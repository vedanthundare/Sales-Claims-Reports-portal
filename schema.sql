-- =====================================================================
-- Skoda Sales Claims Reporting — SQLite schema (real-data edition)
-- Ingested from files/*.xlsx (Retail dump, Wholesale dump, 11 Mar-26 schemes)
-- =====================================================================

DROP TABLE IF EXISTS isac_payment_line;
DROP TABLE IF EXISTS scheme_claim_line;
DROP TABLE IF EXISTS scheme;
DROP TABLE IF EXISTS wholesale_sale;
DROP TABLE IF EXISTS retail_sale;
DROP TABLE IF EXISTS model;
DROP TABLE IF EXISTS dealer_month_target;
DROP TABLE IF EXISTS dealer;

-- (no legacy compat views — reports.js is being rewritten against these tables)
DROP VIEW IF EXISTS dealers;
DROP VIEW IF EXISTS schemes;
DROP VIEW IF EXISTS claims;
DROP TABLE IF EXISTS claim_events;
DROP TABLE IF EXISTS claims;
DROP TABLE IF EXISTS schemes;
DROP TABLE IF EXISTS dealers;

-- ---------------------------------------------------------------------
-- Dealer master (one row per outlet)
-- Real dealer codes come in three variants that all point at the same
-- outlet: retail short (e.g. 10296), ISAC 938-form (93810296), and a
-- short human name (BRITE, AKOYA…). We store all three.
-- ---------------------------------------------------------------------
CREATE TABLE dealer (
    dealer_code       TEXT PRIMARY KEY,       -- canonical (retail short)
    dealer_code_isac  TEXT,                    -- 938xxxxx form
    dealer_short_name TEXT,                    -- BRITE, AKOYA, etc.
    dealer_name       TEXT,                    -- long name from wholesale
    dealer_company    TEXT,
    rsm               TEXT,                    -- Regional Sales Manager
    zone              TEXT,                    -- India-I / India-II
    state             TEXT,
    city              TEXT,
    outlet            TEXT
);
CREATE INDEX idx_dealer_isac ON dealer(dealer_code_isac);
CREATE INDEX idx_dealer_short ON dealer(dealer_short_name);
CREATE INDEX idx_dealer_zone ON dealer(zone);

CREATE TABLE dealer_month_target (
    dealer_code      TEXT NOT NULL,
    period_yyyymm    TEXT NOT NULL,           -- e.g. 2026-03
    retail_target    INTEGER,
    wholesale_target INTEGER,
    PRIMARY KEY (dealer_code, period_yyyymm)
);

-- ---------------------------------------------------------------------
-- Model master
-- ---------------------------------------------------------------------
CREATE TABLE model (
    model_code   TEXT PRIMARY KEY,             -- 6-char e.g. PA15D5
    model_desc   TEXT,
    model_group  TEXT                          -- Kushaq / Slavia / Kylaq / Kodiaq / Octavia
);

-- ---------------------------------------------------------------------
-- Retail sales — one row per delivered VIN
-- Source: Retail March 2026.xlsx → 'Retail Dump' sheet
-- ---------------------------------------------------------------------
CREATE TABLE retail_sale (
    vin                TEXT PRIMARY KEY,
    record_id          TEXT,
    dealer_code        TEXT NOT NULL,
    dealer_short_name  TEXT,
    ws_dealer_code     TEXT,
    ws_date            TEXT,                   -- wholesale date (dealer took delivery from Skoda)
    model_code         TEXT,
    model_group        TEXT,
    model_desc         TEXT,
    variant            TEXT,
    booking_date       TEXT,
    delivery_date      TEXT,                   -- retail-to-customer
    period_yyyymm      TEXT,                   -- YYYY-MM of delivery
    customer_state     TEXT,
    zone               TEXT,
    rsm                TEXT
);
CREATE INDEX idx_retail_dealer ON retail_sale(dealer_code);
CREATE INDEX idx_retail_period ON retail_sale(period_yyyymm);
CREATE INDEX idx_retail_group  ON retail_sale(model_group);

-- ---------------------------------------------------------------------
-- Wholesale sales — one row per invoiced VIN (Skoda → dealer)
-- Source: SKSL2026M03_575.xlsx → "Wholesale Mar'26" (the 3 wholesale
-- scheme workbooks all carry the same base rows).
-- ---------------------------------------------------------------------
CREATE TABLE wholesale_sale (
    chassis            TEXT PRIMARY KEY,
    commission_number  TEXT,
    dealer_code        TEXT NOT NULL,
    dealer_short_name  TEXT,
    model_code         TEXT,
    model_group        TEXT,
    variant            TEXT,
    invoice_number     TEXT,
    invoice_date       TEXT,
    invoice_amount     REAL,
    ws_date            TEXT,
    period_yyyymm      TEXT,
    basic_price        REAL,
    dealer_price       REAL,
    tax_amount         REAL,
    state_code         TEXT,
    zone               TEXT,
    rsm                TEXT
);
CREATE INDEX idx_ws_dealer ON wholesale_sale(dealer_code);
CREATE INDEX idx_ws_period ON wholesale_sale(period_yyyymm);
CREATE INDEX idx_ws_group  ON wholesale_sale(model_group);

-- ---------------------------------------------------------------------
-- Scheme master — one row per scheme workbook
-- ---------------------------------------------------------------------
CREATE TABLE scheme (
    scheme_code        TEXT PRIMARY KEY,       -- SKSL2026M03_555
    scheme_name        TEXT,                   -- 'DAN Support', 'Demo Support', ...
    scheme_kind        TEXT,                   -- RETAIL / WHOLESALE / MIXED
    scheme_type        TEXT,                   -- DAN / DEMO / SC_INCENTIVE / REGIONAL_BOOSTER
                                                 -- LOYALTY / CORPORATE / EXCHANGE
                                                 -- VOLUME_BONUS / EARLY_BIRD / KODIAQ_BOOSTER
    period_yyyymm      TEXT,                   -- 2026-03
    target_payout      REAL,                   -- from Control Sheet
    description        TEXT
);

-- ---------------------------------------------------------------------
-- Scheme claim line — what the calc says is owed per VIN
-- Source: each scheme workbook's payout/base-file sheet
-- ---------------------------------------------------------------------
CREATE TABLE scheme_claim_line (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    scheme_code        TEXT NOT NULL,
    vin                TEXT,                   -- or chassis
    dealer_code        TEXT,
    dealer_short_name  TEXT,
    model_code         TEXT,
    model_group        TEXT,
    calculated_amount  REAL DEFAULT 0,         -- INR (excl. GST unless noted)
    eligibility        TEXT,                   -- YES / NO / PARTIAL / null
    remarks            TEXT,
    period_yyyymm      TEXT,
    FOREIGN KEY (scheme_code) REFERENCES scheme(scheme_code)
);
CREATE INDEX idx_scl_scheme ON scheme_claim_line(scheme_code);
CREATE INDEX idx_scl_dealer ON scheme_claim_line(dealer_code);
CREATE INDEX idx_scl_vin    ON scheme_claim_line(vin);

-- ---------------------------------------------------------------------
-- ISAC payment line — actual money booked to dealer
-- Source: 'ISAC-Till 21st Sep 25' + 'ISAC-From 22nd Sep 25' sheets
-- ---------------------------------------------------------------------
CREATE TABLE isac_payment_line (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    rfa_no             TEXT,
    rfa_line_item      TEXT,
    scheme_code        TEXT,                   -- resolved from workbook filename
    vin                TEXT,
    dealer_code_isac   TEXT,                   -- 938xxxxx form (as it appears)
    dealer_code        TEXT,                   -- normalised (strip leading '938')
    dealer_name        TEXT,
    model_code         TEXT,
    amount_payable     REAL,
    gl_account         TEXT,
    gl_account_desc    TEXT,
    ref_doc_no         TEXT,
    ref_doc_date       TEXT,
    hsn_code           TEXT,
    tax                REAL,
    description        TEXT,
    period_yyyymm      TEXT,
    source_sheet       TEXT                    -- 'PRE_22SEP' / 'POST_22SEP'
);
CREATE INDEX idx_isac_scheme ON isac_payment_line(scheme_code);
CREATE INDEX idx_isac_dealer ON isac_payment_line(dealer_code);
CREATE INDEX idx_isac_vin    ON isac_payment_line(vin);

-- end of schema
