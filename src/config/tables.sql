-- ===========================
-- AUTHENTICATION METHODS
-- ===========================

-- User authentication methods (for issue #11)
CREATE TABLE IF NOT EXISTS votteryy_user_auth_methods (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  auth_type VARCHAR(50) NOT NULL, -- passkey, oauth, magic_link, email_password
  provider VARCHAR(50), -- google, facebook, twitter, linkedin, null
  provider_user_id VARCHAR(255),
  is_primary BOOLEAN DEFAULT FALSE,
  public_key TEXT, -- For passkey
  credential_id TEXT, -- For passkey
  email_verified BOOLEAN DEFAULT FALSE,
  phone_verified BOOLEAN DEFAULT FALSE,
  last_used TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, auth_type, provider)
);

-- Magic link tokens (issue #11)
CREATE TABLE IF NOT EXISTS votteryy_magic_links (
  id SERIAL PRIMARY KEY,
  token UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  user_id VARCHAR(255),
  email VARCHAR(255) NOT NULL,
  election_id INTEGER, -- Optional: link tied to specific election
  expires_at TIMESTAMP NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  used_at TIMESTAMP,
  ip_address INET,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- OTP/2FA codes (issue #11)
CREATE TABLE IF NOT EXISTS votteryy_otp_codes (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  code VARCHAR(6) NOT NULL,
  purpose VARCHAR(50) NOT NULL, -- login, voting, withdrawal
  election_id INTEGER,
  expires_at TIMESTAMP NOT NULL,
  verified BOOLEAN DEFAULT FALSE,
  verified_at TIMESTAMP,
  attempts INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ===========================
-- VERIFICATION & AUDIT (Issues #1, #2, #3)
-- ===========================

-- Public bulletin board for vote verification (issue #2)
CREATE TABLE IF NOT EXISTS votteryy_public_bulletin_board (
  id SERIAL PRIMARY KEY,
  election_id INTEGER NOT NULL,
  vote_hash VARCHAR(64) NOT NULL UNIQUE,
  encrypted_vote_data TEXT NOT NULL,
  timestamp TIMESTAMP NOT NULL,
  block_hash VARCHAR(64) NOT NULL, -- Hash chain
  previous_block_hash VARCHAR(64),
  merkle_root VARCHAR(64),
  verification_proof JSONB, -- Zero-knowledge proof
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Encryption verification (issue #1)
CREATE TABLE IF NOT EXISTS votteryy_encryption_keys (
  id SERIAL PRIMARY KEY,
  election_id INTEGER NOT NULL,
  key_type VARCHAR(50) NOT NULL, -- public, private_shard, threshold
  key_data TEXT NOT NULL, -- Encrypted private keys
  key_index INTEGER, -- For threshold encryption
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(election_id, key_type, key_index)
);

-- Audit trail timeline (issue #3)
CREATE TABLE IF NOT EXISTS votteryy_audit_timeline (
  id SERIAL PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  election_id INTEGER,
  event_type VARCHAR(100) NOT NULL, -- election_created, vote_cast, lottery_drawn, etc.
  actor_id VARCHAR(255), -- User who triggered event
  actor_role VARCHAR(50),
  event_data JSONB NOT NULL,
  ip_address INET,
  user_agent TEXT,
  hash VARCHAR(64) NOT NULL, -- Event hash
  previous_hash VARCHAR(64), -- Chain to previous event
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_immutable BOOLEAN DEFAULT TRUE
);

CREATE INDEX idx_audit_timeline_election ON votteryy_audit_timeline(election_id);
CREATE INDEX idx_audit_timeline_type ON votteryy_audit_timeline(event_type);
CREATE INDEX idx_audit_timeline_timestamp ON votteryy_audit_timeline(timestamp DESC);

-- ===========================
-- ANONYMOUS VOTING (Issue #12)
-- ===========================

-- Anonymous vote tokens (mixnet)
CREATE TABLE IF NOT EXISTS votteryy_anonymous_tokens (
  id SERIAL PRIMARY KEY,
  token UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  election_id INTEGER NOT NULL,
  user_id VARCHAR(255) NOT NULL, -- Only for issuing token
  blinded_token TEXT, -- Cryptographic blind signature
  is_used BOOLEAN DEFAULT FALSE,
  used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, election_id)
);

-- ===========================
-- VOTER APPROVAL SYSTEM (Issue #13)
-- ===========================

CREATE TABLE IF NOT EXISTS votteryy_voter_approvals (
  id SERIAL PRIMARY KEY,
  election_id INTEGER NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending', -- pending, approved, rejected
  requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  reviewed_by VARCHAR(255),
  reviewed_at TIMESTAMP,
  rejection_reason TEXT,
  UNIQUE(user_id, election_id)
);

CREATE INDEX idx_voter_approvals_election ON votteryy_voter_approvals(election_id);
CREATE INDEX idx_voter_approvals_status ON votteryy_voter_approvals(status);

-- ===========================
-- ABSTENTIONS TRACKING (Issue #20)
-- ===========================

CREATE TABLE IF NOT EXISTS votteryy_abstentions (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  election_id INTEGER NOT NULL,
  question_id INTEGER,
  reason TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, election_id, question_id)
);

-- ===========================
-- ELECTION LOCKING (Issue #14)
-- ===========================

CREATE TABLE IF NOT EXISTS votteryy_election_locks (
  id SERIAL PRIMARY KEY,
  election_id INTEGER NOT NULL UNIQUE,
  locked BOOLEAN DEFAULT FALSE,
  locked_at TIMESTAMP,
  locked_reason VARCHAR(100), -- first_vote_cast, admin_lock
  unlockable_fields JSONB, -- ['lottery_prize_pool', 'lottery_winner_count']
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ===========================
-- LIVE RESULTS CONTROL (Issue #18)
-- ===========================

CREATE TABLE IF NOT EXISTS votteryy_results_visibility (
  id SERIAL PRIMARY KEY,
  election_id INTEGER NOT NULL UNIQUE,
  visibility_status VARCHAR(50) DEFAULT 'hidden', -- hidden, visible
  changed_at TIMESTAMP,
  changed_by VARCHAR(255),
  change_history JSONB, -- [{status, timestamp, changed_by}]
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ===========================
-- GROUPED MEMBER PERMISSIONS (Issue #7)
-- ===========================

CREATE TABLE IF NOT EXISTS votteryy_voter_groups (
  id SERIAL PRIMARY KEY,
  group_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  group_name VARCHAR(255) NOT NULL,
  owner_id VARCHAR(255) NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS votteryy_voter_group_members (
  id SERIAL PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES votteryy_voter_groups(group_id) ON DELETE CASCADE,
  user_id VARCHAR(255) NOT NULL,
  added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(group_id, user_id)
);

CREATE TABLE IF NOT EXISTS votteryy_election_group_access (
  id SERIAL PRIMARY KEY,
  election_id INTEGER NOT NULL,
  group_id UUID NOT NULL REFERENCES votteryy_voter_groups(group_id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(election_id, group_id)
);

-- ===========================
-- INDEXES
-- ===========================

CREATE INDEX idx_auth_methods_user ON votteryy_user_auth_methods(user_id);
CREATE INDEX idx_magic_links_token ON votteryy_magic_links(token);
CREATE INDEX idx_magic_links_email ON votteryy_magic_links(email);
CREATE INDEX idx_otp_user ON votteryy_otp_codes(user_id);
CREATE INDEX idx_bulletin_board_election ON votteryy_public_bulletin_board(election_id);
CREATE INDEX idx_bulletin_board_hash ON votteryy_public_bulletin_board(vote_hash);
CREATE INDEX idx_encryption_keys_election ON votteryy_encryption_keys(election_id);
CREATE INDEX idx_anonymous_tokens_election ON votteryy_anonymous_tokens(election_id);
CREATE INDEX idx_abstentions_election ON votteryy_abstentions(election_id);
CREATE INDEX idx_voter_groups_owner ON votteryy_voter_groups(owner_id);
CREATE INDEX idx_voter_group_members_group ON votteryy_voter_group_members(group_id);
CREATE INDEX idx_voter_group_members_user ON votteryy_voter_group_members(user_id);
CREATE INDEX idx_election_group_access_election ON votteryy_election_group_access(election_id);
```
-- Prize distribution queue
CREATE TABLE IF NOT EXISTS votteryy_prize_distribution_queue (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  election_id INTEGER REFERENCES votteryyy_elections(id),
  winner_id INTEGER,
  amount DECIMAL(10, 2) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending_review',
  approved_by VARCHAR(255),
  approved_at TIMESTAMP,
  admin_notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sponsor funding
CREATE TABLE IF NOT EXISTS votteryy_prize_pool_funding (
  id SERIAL PRIMARY KEY,
  sponsor_id VARCHAR(255) NOT NULL,
  election_id INTEGER REFERENCES votteryyy_elections(id),
  amount DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',
  payment_intent_id VARCHAR(255) UNIQUE,
  status VARCHAR(20) DEFAULT 'pending',
  confirmed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Platform config
CREATE TABLE IF NOT EXISTS votteryy_platform_config (
  id SERIAL PRIMARY KEY,
  auto_prize_distribution_threshold DECIMAL(10, 2) DEFAULT 5000.00,
  auto_withdrawal_threshold DECIMAL(10, 2) DEFAULT 5000.00,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO votteryy_platform_config 
(auto_prize_distribution_threshold, auto_withdrawal_threshold) 
VALUES (5000.00, 5000.00)
ON CONFLICT DO NOTHING;

-- Add columns
ALTER TABLE votteryy_wallet_transactions
ADD COLUMN IF NOT EXISTS stripe_fee DECIMAL(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS platform_fee DECIMAL(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS net_amount DECIMAL(10, 2);

ALTER TABLE votteryy_election_payments
ADD COLUMN IF NOT EXISTS stripe_fee DECIMAL(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS platform_fee DECIMAL(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS net_amount DECIMAL(10, 2),
ADD COLUMN IF NOT EXISTS metadata JSONB;

ALTER TABLE votteryy_blocked_accounts
ADD COLUMN IF NOT EXISTS stripe_fee DECIMAL(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS platform_fee DECIMAL(10, 2) DEFAULT 0;

ALTER TABLE votteryyy_elections
ADD COLUMN IF NOT EXISTS prize_pool DECIMAL(12, 2) DEFAULT 0;
---

## 📁 FILES I NEED FROM YOU RIGHT NOW

Please share these files immediately so I can give you production-ready code:

### **Backend - Voting Service:**
```
WHAT YOU ALREADY HAVE (GOOD ✅):
Voting Tables:

✅ votteryy_votes - Core voting with encryption, hash, audit
✅ votteryy_vote_receipts - Digital receipts
✅ votteryy_vote_audit_logs - Immutable audit trail
✅ votteryy_video_watch_progress - Video watch tracking

Lottery Tables:

✅ votteryy_lottery_tickets - Auto-created tickets
✅ votteryy_lottery_winners - Winner records
✅ votteryy_lottery_draws - Draw execution logs

Wallet Tables:

✅ votteryy_user_wallets - User balance + blocked balance
✅ votteryy_wallet_transactions - Transaction history
✅ votteryy_blocked_accounts - Payment holds until election ends
✅ votteryy_withdrawal_requests - Withdrawal management
✅ votteryy_election_payments - Participation fee payments
✅ votteryy_payment_gateway_config - Regional gateway switching

Analytics Tables:

✅ votteryy_vote_analytics - Election analytics
✅ votteryy_platform_analytics - Platform-wide metrics

https://claude.ai/share/7bb1dd8b-c40e-474d-8913-7dfe70f8490b


❌ WHAT'S MISSING (CRITICAL GAPS):
1. Authentication Methods (PDF Issue #11) - MISSING
You need:

votteryy_user_auth_methods - Track Passkey/OAuth/Magic Link/Email+Pass per user
votteryy_magic_links - Store magic link tokens
votteryy_otp_codes - 2FA/OTP verification codes

Why: Your system has NO way to support 4 different authentication methods per election

2. Verification & Audit (PDF Issues #1, #2, #3) - PARTIALLY MISSING
You need:

votteryy_public_bulletin_board - Public vote verification (Issue #2)
votteryy_encryption_keys - Store encryption keys for user verification (Issue #1)
votteryy_audit_timeline - Enhanced audit trail with hash chain (Issue #3)

Why: Your votteryy_vote_audit_logs exists but lacks:

Public bulletin board for voters to verify votes
Encryption key storage for E2E verification
Hash-chain linking between audit events
Merkle tree proofs


3. Anonymous Voting (PDF Issue #12) - MISSING
You need:

votteryy_anonymous_tokens - Blind signature tokens for anonymous voting

Why: Your current votteryy_votes table always links user_id to vote. True anonymous voting requires unlinkable tokens.

4. Voter Approval System (PDF Issue #13) - MISSING
You need:

votteryy_voter_approvals - Track pending/approved/rejected voters per election

Why: You have no way for election creators to manually approve voters before they can vote.

5. Specific Group Permissions (PDF Issue #7) - MISSING
You need:

votteryy_voter_groups - Create named groups
votteryy_voter_group_members - Group membership
votteryy_election_group_access - Link elections to specific groups

Why: You only support World Citizens + Specific Countries. Missing "Specific Group Members" option.

6. Abstentions Tracking (PDF Issue #20) - MISSING
You need:

votteryy_abstentions - Track intentional non-votes per question

Why: No way to differentiate between "didn't vote" and "chose to abstain"

7. Election Locking (PDF Issue #14) - MISSING
You need:

votteryy_election_locks - Lock election fields after first vote (except rewards)

Why: You have no mechanism to prevent editing elections after voting starts

8. Live Results Visibility Control (PDF Issue #18) - MISSING
You need:

votteryy_results_visibility - Track visibility status + change history

Why: You need to track when creator changes visibility from hidden → visible (and prevent reverse)


CREATE TABLE IF NOT EXISTS votteryy_wallets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE,
    balance DECIMAL(10,2) DEFAULT 0.00,
    blocked_balance DECIMAL(10,2) DEFAULT 0.00,
    currency VARCHAR(3) DEFAULT 'USD',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE
);