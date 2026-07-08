-- Postgres port of schema.sql — same tables, dialect-appropriate types.

DROP TABLE IF EXISTS isac_payment_line;
DROP TABLE IF EXISTS scheme_claim_line;
DROP TABLE IF EXISTS scheme;
DROP TABLE IF EXISTS wholesale_sale;
DROP TABLE IF EXISTS retail_sale;
DROP TABLE IF EXISTS model;
DROP TABLE IF EXISTS dealer_month_target;
DROP TABLE IF EXISTS dealer;

CREATE TABLE dealer (
    dealer_code       TEXT PRIMARY KEY,
    dealer_code_isac  TEXT,
    dealer_short_name TEXT,
    dealer_name       TEXT,
    dealer_company    TEXT,
    rsm               TEXT,
    zone              TEXT,
    state             TEXT,
    city              TEXT,
    outlet            TEXT
);
CREATE INDEX idx_dealer_isac  ON dealer(dealer_code_isac);
CREATE INDEX idx_dealer_short ON dealer(dealer_short_name);
CREATE INDEX idx_dealer_zone  ON dealer(zone);

CREATE TABLE dealer_month_target (
    dealer_code      TEXT NOT NULL,
    period_yyyymm    TEXT NOT NULL,
    retail_target    INTEGER,
    wholesale_target INTEGER,
    PRIMARY KEY (dealer_code, period_yyyymm)
);

CREATE TABLE model (
    model_code   TEXT PRIMARY KEY,
    model_desc   TEXT,
    model_group  TEXT
);

CREATE TABLE retail_sale (
    vin                TEXT PRIMARY KEY,
    record_id          TEXT,
    dealer_code        TEXT NOT NULL,
    dealer_short_name  TEXT,
    ws_dealer_code     TEXT,
    ws_date            TEXT,
    model_code         TEXT,
    model_group        TEXT,
    model_desc         TEXT,
    variant            TEXT,
    booking_date       TEXT,
    delivery_date      TEXT,
    period_yyyymm      TEXT,
    customer_state     TEXT,
    zone               TEXT,
    rsm                TEXT
);
CREATE INDEX idx_retail_dealer ON retail_sale(dealer_code);
CREATE INDEX idx_retail_period ON retail_sale(period_yyyymm);
CREATE INDEX idx_retail_group  ON retail_sale(model_group);

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
    invoice_amount     NUMERIC,
    ws_date            TEXT,
    period_yyyymm      TEXT,
    basic_price        NUMERIC,
    dealer_price       NUMERIC,
    tax_amount         NUMERIC,
    state_code         TEXT,
    zone               TEXT,
    rsm                TEXT
);
CREATE INDEX idx_ws_dealer ON wholesale_sale(dealer_code);
CREATE INDEX idx_ws_period ON wholesale_sale(period_yyyymm);
CREATE INDEX idx_ws_group  ON wholesale_sale(model_group);

CREATE TABLE scheme (
    scheme_code        TEXT PRIMARY KEY,
    scheme_name        TEXT,
    scheme_kind        TEXT,
    scheme_type        TEXT,
    period_yyyymm      TEXT,
    target_payout      NUMERIC,
    description        TEXT
);

CREATE TABLE scheme_claim_line (
    id                 BIGSERIAL PRIMARY KEY,
    scheme_code        TEXT NOT NULL,
    vin                TEXT,
    dealer_code        TEXT,
    dealer_short_name  TEXT,
    model_code         TEXT,
    model_group        TEXT,
    calculated_amount  NUMERIC DEFAULT 0,
    eligibility        TEXT,
    remarks            TEXT,
    period_yyyymm      TEXT
);
CREATE INDEX idx_scl_scheme ON scheme_claim_line(scheme_code);
CREATE INDEX idx_scl_dealer ON scheme_claim_line(dealer_code);
CREATE INDEX idx_scl_vin    ON scheme_claim_line(vin);

CREATE TABLE isac_payment_line (
    id                 BIGSERIAL PRIMARY KEY,
    rfa_no             TEXT,
    rfa_line_item      TEXT,
    scheme_code        TEXT,
    vin                TEXT,
    dealer_code_isac   TEXT,
    dealer_code        TEXT,
    dealer_name        TEXT,
    model_code         TEXT,
    amount_payable     NUMERIC,
    gl_account         TEXT,
    gl_account_desc    TEXT,
    ref_doc_no         TEXT,
    ref_doc_date       TEXT,
    hsn_code           TEXT,
    tax                NUMERIC,
    description        TEXT,
    period_yyyymm      TEXT,
    source_sheet       TEXT
);
CREATE INDEX idx_isac_scheme ON isac_payment_line(scheme_code);
CREATE INDEX idx_isac_dealer ON isac_payment_line(dealer_code);
CREATE INDEX idx_isac_vin    ON isac_payment_line(vin);
