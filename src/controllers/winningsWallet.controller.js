// controllers/winningsWallet.controller.js
// ✅ USER WINNINGS WALLET - Separate from Creator Wallet
// Handles lottery prize withdrawals with full history tracking

import pool from "../config/database.js";

//import pool from '../config/db.js';

const winningsWalletController = {
  // =====================================================
  // GET USER WINNINGS WALLET SUMMARY
  // GET /api/lottery/wallet
  // =====================================================
  async getWinningsWallet(req, res) {
    try {
      const userId = req.user.userId;

      // Get all winnings for this user
      const winningsResult = await pool.query(
        `SELECT 
          lw.*,
          e.title as election_title
         FROM votteryy_lottery_winners lw
         JOIN votteryyy_elections e ON lw.election_id = e.id
         WHERE lw.user_id = $1
         ORDER BY lw.created_at DESC`,
        [userId]
      );

      const winnings = winningsResult.rows;

      // Calculate different amounts
      const totalWon = winnings.reduce((sum, w) => sum + parseFloat(w.prize_amount || 0), 0);
      
      // Disbursed = approved by admin and available for user withdrawal
      const disbursedWinnings = winnings.filter(w => w.disbursement_status === 'disbursed');
      const totalDisbursed = disbursedWinnings.reduce((sum, w) => sum + parseFloat(w.prize_amount || 0), 0);

      // Get withdrawal history
      const withdrawalsResult = await pool.query(
        `SELECT * FROM votteryy_winnings_withdrawals 
         WHERE user_id = $1 AND status = 'completed'
         ORDER BY created_at DESC`,
        [userId]
      );

      const totalWithdrawn = withdrawalsResult.rows.reduce(
        (sum, w) => sum + parseFloat(w.amount || 0), 0
      );

      // Available = Disbursed - Withdrawn
      const availableBalance = totalDisbursed - totalWithdrawn;

      // Pending approval amounts
      const pendingApproval = winnings
        .filter(w => ['pending_approval', 'pending_senior_approval'].includes(w.disbursement_status))
        .reduce((sum, w) => sum + parseFloat(w.prize_amount || 0), 0);

      // Unclaimed
      const unclaimed = winnings
        .filter(w => !w.claimed || w.disbursement_status === 'pending_claim')
        .reduce((sum, w) => sum + parseFloat(w.prize_amount || 0), 0);

      res.json({
        success: true,
        wallet: {
          total_won: totalWon,
          total_disbursed: totalDisbursed,
          total_withdrawn: totalWithdrawn,
          available_balance: availableBalance,
          pending_approval: pendingApproval,
          unclaimed: unclaimed,
        },
        summary: {
          total_wins: winnings.length,
          disbursed_count: disbursedWinnings.length,
          pending_count: winnings.filter(w => 
            ['pending_approval', 'pending_senior_approval'].includes(w.disbursement_status)
          ).length,
          unclaimed_count: winnings.filter(w => !w.claimed).length,
          withdrawals_count: withdrawalsResult.rows.length,
        },
        currency: 'USD'
      });

    } catch (error) {
      console.error('❌ Get winnings wallet error:', error);
      res.status(500).json({ error: 'Failed to get winnings wallet' });
    }
  },

  // =====================================================
  // GET WITHDRAWAL HISTORY
  // GET /api/lottery/wallet/withdrawals
  // =====================================================
  async getWithdrawalHistory(req, res) {
    try {
      const userId = req.user.userId;
      const { page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;

      const withdrawalsResult = await pool.query(
        `SELECT * FROM votteryy_winnings_withdrawals 
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM votteryy_winnings_withdrawals WHERE user_id = $1`,
        [userId]
      );

      res.json({
        success: true,
        withdrawals: withdrawalsResult.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: parseInt(countResult.rows[0].count),
          totalPages: Math.ceil(countResult.rows[0].count / limit)
        }
      });

    } catch (error) {
      console.error('❌ Get withdrawal history error:', error);
      res.status(500).json({ error: 'Failed to get withdrawal history' });
    }
  },

  // =====================================================
  // REQUEST WITHDRAWAL
  // POST /api/lottery/wallet/withdraw
  // =====================================================
  async requestWithdrawal(req, res) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      const userId = req.user.userId;
      const { amount, method, bankDetails, paypalEmail, notes } = req.body;

      // Validate amount
      const withdrawAmount = parseFloat(amount);
      if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
        return res.status(400).json({ error: 'Invalid withdrawal amount' });
      }

      // Minimum withdrawal check
      const MIN_WITHDRAWAL = 10;
      if (withdrawAmount < MIN_WITHDRAWAL) {
        return res.status(400).json({ 
          error: `Minimum withdrawal amount is $${MIN_WITHDRAWAL}` 
        });
      }

      // Calculate available balance
      const winningsResult = await client.query(
        `SELECT COALESCE(SUM(prize_amount), 0) as total_disbursed
         FROM votteryy_lottery_winners 
         WHERE user_id = $1 AND disbursement_status = 'disbursed'`,
        [userId]
      );

      const withdrawnResult = await client.query(
        `SELECT COALESCE(SUM(amount), 0) as total_withdrawn
         FROM votteryy_winnings_withdrawals 
         WHERE user_id = $1 AND status IN ('completed', 'pending', 'processing')`,
        [userId]
      );

      const totalDisbursed = parseFloat(winningsResult.rows[0].total_disbursed || 0);
      const totalWithdrawn = parseFloat(withdrawnResult.rows[0].total_withdrawn || 0);
      const availableBalance = totalDisbursed - totalWithdrawn;

      console.log(`💰 Withdrawal request: userId=${userId}, amount=${withdrawAmount}, available=${availableBalance}`);

      // Check if user has enough balance
      if (withdrawAmount > availableBalance) {
        await client.query('ROLLBACK');
        return res.status(400).json({ 
          error: 'Insufficient balance',
          available: availableBalance,
          requested: withdrawAmount
        });
      }

      // Validate withdrawal method
      if (!['bank_transfer', 'paypal'].includes(method)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invalid withdrawal method' });
      }

      // Validate payment details
      if (method === 'bank_transfer') {
        if (!bankDetails?.accountName || !bankDetails?.accountNumber || !bankDetails?.bankName) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Bank details are required for bank transfer' });
        }
      } else if (method === 'paypal') {
        if (!paypalEmail) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'PayPal email is required' });
        }
      }

      // Generate withdrawal reference
      const withdrawalRef = `WD-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

      // Create withdrawal record
      const withdrawalResult = await client.query(
        `INSERT INTO votteryy_winnings_withdrawals 
         (user_id, amount, method, status, reference, payment_details, notes, balance_before, balance_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          userId,
          withdrawAmount,
          method,
          'pending', // Will be processed by admin/system
          withdrawalRef,
          JSON.stringify(method === 'bank_transfer' ? bankDetails : { paypalEmail }),
          notes || null,
          availableBalance,
          availableBalance - withdrawAmount
        ]
      );

      // Create audit log
      await client.query(
        `INSERT INTO votteryy_audit_logs 
         (action, entity_type, entity_id, user_id, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          'WINNINGS_WITHDRAWAL_REQUESTED',
          'withdrawal',
          withdrawalResult.rows[0].id,
          userId,
          JSON.stringify({
            amount: withdrawAmount,
            method,
            reference: withdrawalRef,
            balance_before: availableBalance,
            balance_after: availableBalance - withdrawAmount
          })
        ]
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        message: 'Withdrawal request submitted successfully',
        withdrawal: {
          id: withdrawalResult.rows[0].id,
          reference: withdrawalRef,
          amount: withdrawAmount,
          method,
          status: 'pending',
          balance_before: availableBalance,
          balance_after: availableBalance - withdrawAmount,
          estimated_processing: method === 'bank_transfer' ? '2-3 business days' : '1-2 business days',
          created_at: withdrawalResult.rows[0].created_at
        }
      });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Request withdrawal error:', error);
      res.status(500).json({ error: 'Failed to process withdrawal request' });
    } finally {
      client.release();
    }
  },

  // =====================================================
  // GET SINGLE WITHDRAWAL DETAILS
  // GET /api/lottery/wallet/withdrawals/:withdrawalId
  // =====================================================
  async getWithdrawalDetails(req, res) {
    try {
      const userId = req.user.userId;
      const { withdrawalId } = req.params;

      const result = await pool.query(
        `SELECT * FROM votteryy_winnings_withdrawals 
         WHERE id = $1 AND user_id = $2`,
        [withdrawalId, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Withdrawal not found' });
      }

      res.json({
        success: true,
        withdrawal: result.rows[0]
      });

    } catch (error) {
      console.error('❌ Get withdrawal details error:', error);
      res.status(500).json({ error: 'Failed to get withdrawal details' });
    }
  },

  // =====================================================
  // CANCEL PENDING WITHDRAWAL (User can cancel if still pending)
  // POST /api/lottery/wallet/withdrawals/:withdrawalId/cancel
  // =====================================================
  async cancelWithdrawal(req, res) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const userId = req.user.userId;
      const { withdrawalId } = req.params;

      // Get withdrawal
      const withdrawalResult = await client.query(
        `SELECT * FROM votteryy_winnings_withdrawals 
         WHERE id = $1 AND user_id = $2`,
        [withdrawalId, userId]
      );

      if (withdrawalResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Withdrawal not found' });
      }

      const withdrawal = withdrawalResult.rows[0];

      // Can only cancel pending withdrawals
      if (withdrawal.status !== 'pending') {
        await client.query('ROLLBACK');
        return res.status(400).json({ 
          error: `Cannot cancel withdrawal with status: ${withdrawal.status}` 
        });
      }

      // Update withdrawal status
      await client.query(
        `UPDATE votteryy_winnings_withdrawals 
         SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [withdrawalId]
      );

      // Create audit log
      await client.query(
        `INSERT INTO votteryy_audit_logs 
         (action, entity_type, entity_id, user_id, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          'WINNINGS_WITHDRAWAL_CANCELLED',
          'withdrawal',
          withdrawalId,
          userId,
          JSON.stringify({
            amount: withdrawal.amount,
            reference: withdrawal.reference,
            cancelled_by: 'user'
          })
        ]
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        message: 'Withdrawal cancelled successfully',
        withdrawal_id: withdrawalId,
        amount_restored: parseFloat(withdrawal.amount)
      });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Cancel withdrawal error:', error);
      res.status(500).json({ error: 'Failed to cancel withdrawal' });
    } finally {
      client.release();
    }
  },

  // =====================================================
  // ADMIN: GET ALL PENDING WITHDRAWALS
  // GET /api/lottery/wallet/admin/pending-withdrawals
  // =====================================================
  async getAdminPendingWithdrawals(req, res) {
    try {
      const { page = 1, limit = 20, status = 'pending' } = req.query;
      const offset = (page - 1) * limit;

      let statusFilter = '';
      if (status !== 'all') {
        statusFilter = `AND ww.status = '${status}'`;
      }

      const result = await pool.query(
        `SELECT 
          ww.*,
          u.username,
          u.email,
          u.full_name
         FROM votteryy_winnings_withdrawals ww
         JOIN users u ON ww.user_id = u.id
         WHERE 1=1 ${statusFilter}
         ORDER BY ww.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM votteryy_winnings_withdrawals ww WHERE 1=1 ${statusFilter}`
      );

      // Get summary stats
      const statsResult = await pool.query(
        `SELECT 
          COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
          COUNT(*) FILTER (WHERE status = 'processing') as processing_count,
          COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
          COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0) as pending_amount,
          COALESCE(SUM(amount) FILTER (WHERE status = 'completed'), 0) as completed_amount
         FROM votteryy_winnings_withdrawals`
      );

      res.json({
        success: true,
        withdrawals: result.rows,
        stats: statsResult.rows[0],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: parseInt(countResult.rows[0].count),
          totalPages: Math.ceil(countResult.rows[0].count / limit)
        }
      });

    } catch (error) {
      console.error('❌ Get admin pending withdrawals error:', error);
      res.status(500).json({ error: 'Failed to get pending withdrawals' });
    }
  },

  // =====================================================
  // ADMIN: PROCESS WITHDRAWAL (Approve/Complete)
  // POST /api/lottery/wallet/admin/withdrawals/:withdrawalId/process
  // =====================================================
  async processWithdrawal(req, res) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const adminId = req.user.userId;
      const { withdrawalId } = req.params;
      const { action, transactionId, notes } = req.body;

      // Validate action
      if (!['approve', 'complete', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'Invalid action. Use: approve, complete, or reject' });
      }

      // Get withdrawal
      const withdrawalResult = await client.query(
        `SELECT * FROM votteryy_winnings_withdrawals WHERE id = $1`,
        [withdrawalId]
      );

      if (withdrawalResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Withdrawal not found' });
      }

      const withdrawal = withdrawalResult.rows[0];

      let newStatus;
      let updateFields = '';

      switch (action) {
        case 'approve':
          if (withdrawal.status !== 'pending') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Can only approve pending withdrawals' });
          }
          newStatus = 'processing';
          updateFields = `, approved_by = ${adminId}, approved_at = CURRENT_TIMESTAMP`;
          break;

        case 'complete':
          if (!['pending', 'processing'].includes(withdrawal.status)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Can only complete pending or processing withdrawals' });
          }
          newStatus = 'completed';
          updateFields = `, completed_by = ${adminId}, completed_at = CURRENT_TIMESTAMP, transaction_id = '${transactionId || ''}'`;
          break;

        case 'reject':
          if (!['pending', 'processing'].includes(withdrawal.status)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Can only reject pending or processing withdrawals' });
          }
          if (!notes) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Rejection reason is required' });
          }
          newStatus = 'rejected';
          updateFields = `, rejected_by = ${adminId}, rejected_at = CURRENT_TIMESTAMP, rejection_reason = '${notes}'`;
          break;
      }

      // Update withdrawal
      await client.query(
        `UPDATE votteryy_winnings_withdrawals 
         SET status = $1, admin_notes = $2, updated_at = CURRENT_TIMESTAMP ${updateFields}
         WHERE id = $3`,
        [newStatus, notes || null, withdrawalId]
      );

      // Create audit log
      await client.query(
        `INSERT INTO votteryy_audit_logs 
         (action, entity_type, entity_id, user_id, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          `WINNINGS_WITHDRAWAL_${action.toUpperCase()}`,
          'withdrawal',
          withdrawalId,
          adminId,
          JSON.stringify({
            amount: withdrawal.amount,
            reference: withdrawal.reference,
            user_id: withdrawal.user_id,
            new_status: newStatus,
            notes
          })
        ]
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        message: `Withdrawal ${action}ed successfully`,
        withdrawal_id: withdrawalId,
        new_status: newStatus
      });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Process withdrawal error:', error);
      res.status(500).json({ error: 'Failed to process withdrawal' });
    } finally {
      client.release();
    }
  },

  // =====================================================
  // GET COMPLETE TRANSACTION HISTORY (Combined view)
  // GET /api/lottery/wallet/transactions
  // =====================================================
  // Find this function and replace it:
async getTransactionHistory(req, res) {
  try {
    const userId = req.user.userId;
    const { page = 1, limit = 20, type = 'all' } = req.query;
    const offset = (page - 1) * limit;

    let transactions = [];

    // Get winnings (credits) - FIXED: Use table alias for created_at
    const winningsResult = await pool.query(
      `SELECT 
        lw.winner_id as id,
        'prize_won' as type,
        lw.prize_amount as amount,
        lw.disbursement_status as status,
        lw.created_at,
        lw.disbursed_at as completed_at,
        lw.election_id,
        e.title as description
       FROM votteryy_lottery_winners lw
       JOIN votteryyy_elections e ON lw.election_id = e.id
       WHERE lw.user_id = $1 AND lw.disbursement_status = 'disbursed'
       ORDER BY lw.disbursed_at DESC`,
      [userId]
    );

    // Get withdrawals (debits)
    const withdrawalsResult = await pool.query(
      `SELECT 
        id,
        'withdrawal' as type,
        amount,
        status,
        created_at,
        completed_at,
        reference as description,
        method,
        balance_before,
        balance_after
       FROM votteryy_winnings_withdrawals
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    // Combine and sort
    const allTransactions = [
      ...winningsResult.rows.map(t => ({ ...t, direction: 'credit' })),
      ...withdrawalsResult.rows.map(t => ({ ...t, direction: 'debit' }))
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Filter by type if specified
    let filteredTransactions = allTransactions;
    if (type === 'credits') {
      filteredTransactions = allTransactions.filter(t => t.direction === 'credit');
    } else if (type === 'debits') {
      filteredTransactions = allTransactions.filter(t => t.direction === 'debit');
    }

    // Paginate
    const paginatedTransactions = filteredTransactions.slice(offset, offset + parseInt(limit));

    res.json({
      success: true,
      transactions: paginatedTransactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: filteredTransactions.length,
        totalPages: Math.ceil(filteredTransactions.length / limit)
      }
    });

  } catch (error) {
    console.error('❌ Get transaction history error:', error);
    res.status(500).json({ error: 'Failed to get transaction history' });
  }
}
//   async getTransactionHistory(req, res) {
//     try {
//       const userId = req.user.userId;
//       const { page = 1, limit = 20, type = 'all' } = req.query;
//       const offset = (page - 1) * limit;

//       // Build combined query for wins and withdrawals
//       let transactions = [];

//       // Get winnings (credits)
//       const winningsResult = await pool.query(
//         `SELECT 
//           winner_id as id,
//           'prize_won' as type,
//           prize_amount as amount,
//           disbursement_status as status,
//           created_at,
//           disbursed_at as completed_at,
//           election_id,
//           e.title as description
//          FROM votteryy_lottery_winners lw
//          JOIN votteryyy_elections e ON lw.election_id = e.id
//          WHERE lw.user_id = $1 AND lw.disbursement_status = 'disbursed'
//          ORDER BY lw.disbursed_at DESC`,
//         [userId]
//       );

//       // Get withdrawals (debits)
//       const withdrawalsResult = await pool.query(
//         `SELECT 
//           id,
//           'withdrawal' as type,
//           amount,
//           status,
//           created_at,
//           completed_at,
//           reference as description,
//           method,
//           balance_before,
//           balance_after
//          FROM votteryy_winnings_withdrawals
//          WHERE user_id = $1
//          ORDER BY created_at DESC`,
//         [userId]
//       );

//       // Combine and sort
//       const allTransactions = [
//         ...winningsResult.rows.map(t => ({ ...t, direction: 'credit' })),
//         ...withdrawalsResult.rows.map(t => ({ ...t, direction: 'debit' }))
//       ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

//       // Filter by type if specified
//       let filteredTransactions = allTransactions;
//       if (type === 'credits') {
//         filteredTransactions = allTransactions.filter(t => t.direction === 'credit');
//       } else if (type === 'debits') {
//         filteredTransactions = allTransactions.filter(t => t.direction === 'debit');
//       }

//       // Paginate
//       const paginatedTransactions = filteredTransactions.slice(offset, offset + parseInt(limit));

//       res.json({
//         success: true,
//         transactions: paginatedTransactions,
//         pagination: {
//           page: parseInt(page),
//           limit: parseInt(limit),
//           total: filteredTransactions.length,
//           totalPages: Math.ceil(filteredTransactions.length / limit)
//         }
//       });

//     } catch (error) {
//       console.error('❌ Get transaction history error:', error);
//       res.status(500).json({ error: 'Failed to get transaction history' });
//     }
//   }
};

export default winningsWalletController;