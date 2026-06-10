-- =====================================================================
-- Skoda Sales Claims Reporting — SQLite schema
-- Standalone reporting datamart (denormalised for fast aggregation).
-- Mirrors the conceptual entities used in the DMS but lives outside it.
-- =====================================================================

DROP TABLE IF EXISTS claim_events;
DROP TABLE IF EXISTS claims;
DROP TABLE IF EXISTS schemes;
DROP TABLE IF EXISTS dealers;

CREATE TABLE dealers (
    dealer_code        TEXT PRIMARY KEY,
    dealer_name        TEXT NOT NULL,
    dealer_company     TEXT,
    region             TEXT NOT NULL,        -- North / South / East / West / Central
    zone               TEXT NOT NULL,
    state              TEXT,
    city               TEXT,
    onboarded_on       TEXT,                 -- ISO date
    fnf_status         TEXT DEFAULT 'ACTIVE',-- ACTIVE / NEARING_EXIT / EXITED
    fnf_target_date    TEXT,                 -- expected closure date (ISO)
    upfront_support    REAL DEFAULT 0,       -- DAN / upfront support extended (INR)
    risk_band          TEXT DEFAULT 'LOW'    -- LOW / MEDIUM / HIGH (latest snapshot)
);

CREATE TABLE schemes (
    scheme_code        TEXT PRIMARY KEY,
    scheme_name        TEXT NOT NULL,
    scheme_type        TEXT NOT NULL,        -- CORPORATE / EXCHANGE / LOYALTY / RETAIL_TACTICAL / BASE
    payout_kind        TEXT NOT NULL,        -- BASE / TACTICAL
    valid_from         TEXT,
    valid_to           TEXT,
    target_units       INTEGER,
    target_payout      REAL
);

CREATE TABLE claims (
    claim_id              INTEGER PRIMARY KEY AUTOINCREMENT,
    chassis_number        TEXT UNIQUE NOT NULL,
    dealer_code           TEXT NOT NULL,
    scheme_code           TEXT NOT NULL,
    customer_name         TEXT,
    model                 TEXT,
    variant               TEXT,
    delivery_date         TEXT,              -- ISO
    claim_raised_on       TEXT NOT NULL,     -- ISO
    submission_deadline   TEXT,              -- ISO (raised + 15 d)
    first_lot_submitted   TEXT,
    final_submitted       TEXT,
    approved_on           TEXT,
    rejected_on           TEXT,
    settlement_date       TEXT,
    status                TEXT NOT NULL,     -- PENDING / APPROVED / REJECTED / TIME_BARRED / DISPUTED
    final_status          TEXT,
    rejection_reason      TEXT,
    rejection_count       INTEGER DEFAULT 0,
    documentation_score   INTEGER DEFAULT 100, -- 0-100
    doc_gap_tags          TEXT,              -- comma list: INVOICE_MISSING, RC_PENDING, ...
    is_dispute            INTEGER DEFAULT 0,
    dispute_root_cause    TEXT,              -- DOC / POLICY / ELIGIBILITY / SYSTEM / DEALER_ERROR
    claimed_amount        REAL DEFAULT 0,
    approved_amount       REAL DEFAULT 0,
    payout_kind           TEXT NOT NULL,     -- BASE / TACTICAL (denorm from scheme)
    period_yyyymm         TEXT NOT NULL,     -- e.g. 2026-04
    FOREIGN KEY (dealer_code) REFERENCES dealers(dealer_code),
    FOREIGN KEY (scheme_code) REFERENCES schemes(scheme_code)
);

CREATE INDEX idx_claims_dealer ON claims(dealer_code);
CREATE INDEX idx_claims_scheme ON claims(scheme_code);
CREATE INDEX idx_claims_status ON claims(status);
CREATE INDEX idx_claims_period ON claims(period_yyyymm);
CREATE INDEX idx_claims_payoutkind ON claims(payout_kind);

-- Per-claim event log used for aging buckets & lifecycle queries
CREATE TABLE claim_events (
    event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id     INTEGER NOT NULL,
    event_type   TEXT NOT NULL,   -- RAISED / SUBMITTED / REJECTED / APPROVED / TIME_BARRED / SETTLED / DISPUTE_OPENED / DISPUTE_CLOSED
    event_date   TEXT NOT NULL,
    note         TEXT,
    FOREIGN KEY (claim_id) REFERENCES claims(claim_id)
);

CREATE INDEX idx_events_claim ON claim_events(claim_id);
CREATE INDEX idx_events_type  ON claim_events(event_type);
