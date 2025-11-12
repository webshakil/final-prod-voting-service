import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

class NotificationService {

  constructor() {
    // Create email transporter
    this.transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: process.env.EMAIL_PORT,
      secure: false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
      }
    });
  }

  // Send vote confirmation email
  async sendVoteConfirmation(email, electionTitle, receiptId, voteHash) {
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: `Vote Confirmation - ${electionTitle}`,
      html: `
        <h2>Your Vote Has Been Recorded</h2>
        <p>Thank you for participating in <strong>${electionTitle}</strong>.</p>
        <h3>Vote Verification Details:</h3>
        <p><strong>Receipt ID:</strong> ${receiptId}</p>
        <p><strong>Vote Hash:</strong> ${voteHash}</p>
        <p>You can verify your vote anytime using these credentials.</p>
        <hr>
        <p><small>This is an automated message from Vottery.</small></p>
      `
    };

    try {
      await this.transporter.sendMail(mailOptions);
      return { success: true };
    } catch (error) {
      console.error('Email send error:', error);
      return { success: false, error: error.message };
    }
  }

  // Send lottery winner notification
  async sendLotteryWinnerNotification(email, userName, electionTitle, prize, rank) {
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: `🎉 Congratulations! You Won - ${electionTitle}`,
      html: `
        <h1>🎉 Congratulations ${userName}!</h1>
        <p>You are a <strong>${this.getRankSuffix(rank)} place winner</strong> in <strong>${electionTitle}</strong>!</p>
        <h2>Your Prize:</h2>
        <p>${prize}</p>
        <p>Please log in to your Vottery account to claim your prize.</p>
        <hr>
        <p><small>This is an automated message from Vottery.</small></p>
      `
    };

    try {
      await this.transporter.sendMail(mailOptions);
      return { success: true };
    } catch (error) {
      console.error('Email send error:', error);
      return { success: false, error: error.message };
    }
  }

  // Send OTP code
  async sendOTP(email, code, purpose = 'login') {
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: `Your Vottery Verification Code`,
      html: `
        <h2>Verification Code</h2>
        <p>Your verification code for ${purpose} is:</p>
        <h1 style="font-size: 32px; letter-spacing: 10px;">${code}</h1>
        <p>This code will expire in 10 minutes.</p>
        <p>If you didn't request this code, please ignore this email.</p>
        <hr>
        <p><small>This is an automated message from Vottery.</small></p>
      `
    };

    try {
      await this.transporter.sendMail(mailOptions);
      return { success: true };
    } catch (error) {
      console.error('Email send error:', error);
      return { success: false, error: error.message };
    }
  }

  // Send magic link
  async sendMagicLink(email, token, electionId = null) {
    const baseUrl = process.env.FRONTEND_URL || 'https://vottery.com';
    const magicLink = electionId 
      ? `${baseUrl}/auth/magic-link/${token}?election=${electionId}`
      : `${baseUrl}/auth/magic-link/${token}`;

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: `Your Vottery Magic Link`,
      html: `
        <h2>Magic Link Login</h2>
        <p>Click the link below to log in to Vottery:</p>
        <p><a href="${magicLink}" style="display: inline-block; padding: 12px 24px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 6px;">Login to Vottery</a></p>
        <p>This link will expire in 15 minutes.</p>
        <p>If you didn't request this link, please ignore this email.</p>
        <hr>
        <p><small>This is an automated message from Vottery.</small></p>
      `
    };

    try {
      await this.transporter.sendMail(mailOptions);
      return { success: true };
    } catch (error) {
      console.error('Email send error:', error);
      return { success: false, error: error.message };
    }
  }

  // Send withdrawal approved notification
  async sendWithdrawalApproved(email, amount, currency = 'USD') {
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: `Withdrawal Approved - ${currency} ${amount}`,
      html: `
        <h2>Withdrawal Approved</h2>
        <p>Your withdrawal request for <strong>${currency} ${amount}</strong> has been approved.</p>
        <p>The funds will be transferred to your account within 3-5 business days.</p>
        <hr>
        <p><small>This is an automated message from Vottery.</small></p>
      `
    };

    try {
      await this.transporter.sendMail(mailOptions);
      return { success: true };
    } catch (error) {
      console.error('Email send error:', error);
      return { success: false, error: error.message };
    }
  }

  // Send payment received notification
  async sendPaymentReceived(email, amount, electionTitle) {
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: `Payment Confirmed - ${electionTitle}`,
      html: `
        <h2>Payment Received</h2>
        <p>We have received your payment of <strong>$${amount}</strong> for <strong>${electionTitle}</strong>.</p>
        <p>You can now participate in the election.</p>
        <hr>
        <p><small>This is an automated message from Vottery.</small></p>
      `
    };

    try {
      await this.transporter.sendMail(mailOptions);
      return { success: true };
    } catch (error) {
      console.error('Email send error:', error);
      return { success: false, error: error.message };
    }
  }

  // Helper function for rank suffix
  getRankSuffix(rank) {
    const suffixes = ['st', 'nd', 'rd'];
    const value = rank % 100;
    return rank + (suffixes[(value - 1) % 10] || 'th');
  }

  // Send voter approval request to creator
  async sendVoterApprovalRequest(creatorEmail, voterEmail, electionTitle, approvalId) {
    const baseUrl = process.env.FRONTEND_URL || 'https://vottery.com';
    const approvalUrl = `${baseUrl}/elections/approvals/${approvalId}`;

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: creatorEmail,
      subject: `Voter Approval Request - ${electionTitle}`,
      html: `
        <h2>New Voter Approval Request</h2>
        <p><strong>${voterEmail}</strong> has requested to participate in your election:</p>
        <p><strong>${electionTitle}</strong></p>
        <p><a href="${approvalUrl}" style="display: inline-block; padding: 12px 24px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 6px;">Review Request</a></p>
        <hr>
        <p><small>This is an automated message from Vottery.</small></p>
      `
    };

    try {
      await this.transporter.sendMail(mailOptions);
      return { success: true };
    } catch (error) {
      console.error('Email send error:', error);
      return { success: false, error: error.message };
    }
  }

  // Send voter approval status
  async sendVoterApprovalStatus(voterEmail, electionTitle, approved) {
    const status = approved ? 'approved' : 'rejected';
    const message = approved 
      ? 'Your request to participate has been approved. You can now vote in this election.'
      : 'Unfortunately, your request to participate has been rejected.';

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: voterEmail,
      subject: `Voter Request ${approved ? 'Approved' : 'Rejected'} - ${electionTitle}`,
      html: `
        <h2>Voter Request ${approved ? 'Approved' : 'Rejected'}</h2>
        <p>${message}</p>
        <p><strong>Election:</strong> ${electionTitle}</p>
        <hr>
        <p><small>This is an automated message from Vottery.</small></p>
      `
    };

    try {
      await this.transporter.sendMail(mailOptions);
      return { success: true };
    } catch (error) {
      console.error('Email send error:', error);
      return { success: false, error: error.message };
    }
  }
}

export default new NotificationService();