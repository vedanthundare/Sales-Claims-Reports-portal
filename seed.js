/**
 * Seeds the SQLite reporting datamart with realistic synthetic data
 * for Skoda Sales Claims (Tactical & Base payouts).
 *
 * Run: node seed.js
 */
const fs = require('fs');
const path = require('path');
const { open } = require('./db');

const DB_PATH = path.join(__dirname, 'data', 'reports.sqlite3');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

async function main() {
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
const db = await open(DB_PATH);
db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

// Deterministic pseudo-random so re-seeds are stable
let seed = 42;
const rnd = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
};
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const between = (a, b) => Math.floor(rnd() * (b - a + 1)) + a;
const isoDate = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

// ----- Dealers -----
const REGIONS = ['North', 'South', 'East', 'West', 'Central'];
const ZONES_BY_REGION = {
    North: ['Delhi NCR', 'Punjab', 'Haryana'],
    South: ['Bangalore', 'Chennai', 'Hyderabad', 'Kerala'],
    East:  ['Kolkata', 'Bhubaneswar', 'Guwahati'],
    West:  ['Mumbai', 'Pune', 'Ahmedabad'],
    Central: ['Indore', 'Bhopal', 'Nagpur']
};
const DEALER_NAMES = [
    'Skoda Auto Plaza', 'Skoda Premium Motors', 'Skoda Elite Auto', 'Skoda Drive',
    'Skoda Imperial', 'Skoda Crown', 'Skoda Vista', 'Skoda Apex',
    'Skoda Pinnacle', 'Skoda Trinity', 'Skoda Marvel', 'Skoda Royal',
    'Skoda Horizon', 'Skoda Summit', 'Skoda Pristine', 'Skoda Velocity',
    'Skoda Galaxy', 'Skoda Stellar', 'Skoda Astra', 'Skoda Nexus',
    'Skoda Orion', 'Skoda Atlas', 'Skoda Quanta', 'Skoda Vertex'
];

const insertDealer = db.prepare(`
    INSERT INTO dealers (dealer_code, dealer_name, dealer_company, region, zone, state, city,
                         onboarded_on, fnf_status, fnf_target_date, upfront_support, risk_band)
    VALUES (@dealer_code,@dealer_name,@dealer_company,@region,@zone,@state,@city,
            @onboarded_on,@fnf_status,@fnf_target_date,@upfront_support,@risk_band)
`);

const dealers = [];
DEALER_NAMES.forEach((name, idx) => {
    const region = pick(REGIONS);
    const zone = pick(ZONES_BY_REGION[region]);
    const fnfRoll = rnd();
    let fnf_status = 'ACTIVE', fnf_target_date = null;
    if (fnfRoll > 0.92) {
        fnf_status = 'NEARING_EXIT';
        fnf_target_date = isoDate(addDays(new Date('2026-06-10'), between(15, 90)));
    } else if (fnfRoll > 0.88) {
        fnf_status = 'EXITED';
        fnf_target_date = isoDate(addDays(new Date('2026-06-10'), -between(10, 60)));
    }
    const dealer = {
        dealer_code: `SKD${String(1001 + idx).padStart(4, '0')}`,
        dealer_name: name,
        dealer_company: name + ' Pvt Ltd',
        region, zone,
        state: zone, city: zone,
        onboarded_on: isoDate(addDays(new Date('2022-01-01'), between(0, 1200))),
        fnf_status, fnf_target_date,
        upfront_support: between(0, 5) === 0 ? 0 : between(50000, 750000),
        risk_band: 'LOW' // recomputed after claims insert
    };
    dealers.push(dealer);
    insertDealer.run(dealer);
});

// ----- Schemes -----
const SCHEMES = [
    { scheme_code: 'CORP-FY26-Q1', scheme_name: 'Corporate Fleet Q1 FY26',  scheme_type: 'CORPORATE',       payout_kind: 'TACTICAL', target_units: 800,  target_payout: 25000000 },
    { scheme_code: 'CORP-FY26-Q2', scheme_name: 'Corporate Fleet Q2 FY26',  scheme_type: 'CORPORATE',       payout_kind: 'TACTICAL', target_units: 850,  target_payout: 27000000 },
    { scheme_code: 'EXCH-FY26-H1', scheme_name: 'Exchange Bonanza H1 FY26', scheme_type: 'EXCHANGE',        payout_kind: 'TACTICAL', target_units: 1200, target_payout: 18000000 },
    { scheme_code: 'LOYAL-FY26',   scheme_name: 'Loyalty Plus FY26',        scheme_type: 'LOYALTY',         payout_kind: 'TACTICAL', target_units: 600,  target_payout: 9000000  },
    { scheme_code: 'RETAIL-FY26-Q1', scheme_name: 'Retail Tactical Q1 FY26', scheme_type: 'RETAIL_TACTICAL',payout_kind: 'TACTICAL', target_units: 1500, target_payout: 22000000 },
    { scheme_code: 'RETAIL-FY26-Q2', scheme_name: 'Retail Tactical Q2 FY26', scheme_type: 'RETAIL_TACTICAL',payout_kind: 'TACTICAL', target_units: 1500, target_payout: 22500000 },
    { scheme_code: 'BASE-FY26',    scheme_name: 'Base Payout Programme FY26',scheme_type: 'BASE',           payout_kind: 'BASE',     target_units: 8000, target_payout: 80000000 }
];
const insertScheme = db.prepare(`
    INSERT INTO schemes (scheme_code, scheme_name, scheme_type, payout_kind,
                         valid_from, valid_to, target_units, target_payout)
    VALUES (@scheme_code,@scheme_name,@scheme_type,@payout_kind,
            @valid_from,@valid_to,@target_units,@target_payout)
`);
SCHEMES.forEach(s => insertScheme.run({
    ...s,
    valid_from: '2025-04-01', valid_to: '2026-03-31'
}));

// ----- Claims -----
const MODELS = ['Kushaq', 'Slavia', 'Kodiaq', 'Superb', 'Octavia', 'Karoq'];
const VARIANTS = ['Active', 'Ambition', 'Style', 'L&K', 'Monte Carlo'];
const REJECT_REASONS = [
    'Invoice mismatch', 'RC pending', 'Documentation incomplete',
    'Eligibility criteria not met', 'Customer KYC missing',
    'Vehicle dispatch date dispute', 'Scheme period expired'
];
const DOC_GAP_POOL = ['INVOICE_MISSING','RC_PENDING','KYC_INCOMPLETE','DELIVERY_PROOF_GAP','GST_MISMATCH','SIGNATURE_MISSING'];
const DISPUTE_ROOTS = ['DOC', 'POLICY', 'ELIGIBILITY', 'SYSTEM', 'DEALER_ERROR'];
// 70% APPROVED, 12% PENDING, 9% REJECTED, 5% TIME_BARRED, 4% DISPUTED
const STATUS_DIST = [
    'APPROVED','APPROVED','APPROVED','APPROVED','APPROVED','APPROVED','APPROVED',
    'APPROVED','APPROVED','APPROVED','APPROVED','APPROVED','APPROVED','APPROVED',
    'PENDING','PENDING','PENDING',
    'REJECTED','REJECTED',
    'TIME_BARRED',
    'DISPUTED'
];

const insertClaim = db.prepare(`
    INSERT INTO claims (
        chassis_number, dealer_code, scheme_code, customer_name, model, variant,
        delivery_date, claim_raised_on, submission_deadline, first_lot_submitted,
        final_submitted, approved_on, rejected_on, settlement_date, status, final_status,
        rejection_reason, rejection_count, documentation_score, doc_gap_tags,
        is_dispute, dispute_root_cause, claimed_amount, approved_amount,
        payout_kind, period_yyyymm
    ) VALUES (
        @chassis_number,@dealer_code,@scheme_code,@customer_name,@model,@variant,
        @delivery_date,@claim_raised_on,@submission_deadline,@first_lot_submitted,
        @final_submitted,@approved_on,@rejected_on,@settlement_date,@status,@final_status,
        @rejection_reason,@rejection_count,@documentation_score,@doc_gap_tags,
        @is_dispute,@dispute_root_cause,@claimed_amount,@approved_amount,
        @payout_kind,@period_yyyymm
    )
`);
const insertEvent = db.prepare(`
    INSERT INTO claim_events (claim_id, event_type, event_date, note)
    VALUES (?, ?, ?, ?)
`);

const TOTAL_CLAIMS = 4000;
const today = new Date('2026-06-10');

const tx = db.transaction(() => {
    for (let i = 0; i < TOTAL_CLAIMS; i++) {
        const dealer = pick(dealers);
        const scheme = pick(SCHEMES);
        const raised = addDays(today, -between(0, 365));
        const deadline = addDays(raised, 15);
        const status = pick(STATUS_DIST);
        const claimedBase = scheme.scheme_type === 'CORPORATE' ? between(35000, 90000)
                          : scheme.scheme_type === 'EXCHANGE'  ? between(15000, 35000)
                          : scheme.scheme_type === 'LOYALTY'   ? between(8000, 20000)
                          : scheme.scheme_type === 'BASE'      ? between(6000, 14000)
                          : between(10000, 25000);
        const claimed_amount = claimedBase + between(-1500, 1500);

        let first_lot_submitted = null, final_submitted = null,
            approved_on = null, rejected_on = null, settlement_date = null,
            rejection_reason = null, rejection_count = 0, approved_amount = 0,
            final_status = null, is_dispute = 0, dispute_root_cause = null;

        // Skew documentation higher: most dealers are decent, a few are weak
        const docScore = rnd() < 0.6 ? between(80, 100) : rnd() < 0.7 ? between(60, 85) : between(40, 70);
        const gapsCount = docScore > 90 ? 0 : docScore > 75 ? 1 : docScore > 60 ? 2 : 3;
        const docGaps = [];
        for (let g = 0; g < gapsCount; g++) docGaps.push(pick(DOC_GAP_POOL));

        if (status === 'APPROVED') {
            first_lot_submitted = isoDate(addDays(raised, between(2, 14)));
            final_submitted = isoDate(addDays(new Date(first_lot_submitted), between(1, 7)));
            approved_on = isoDate(addDays(new Date(final_submitted), between(1, 12)));
            settlement_date = isoDate(addDays(new Date(approved_on), between(2, 25)));
            approved_amount = Math.round(claimed_amount * (0.85 + rnd() * 0.15));
            final_status = 'APPROVED';
        } else if (status === 'PENDING') {
            if (rnd() > 0.4) first_lot_submitted = isoDate(addDays(raised, between(2, 14)));
        } else if (status === 'REJECTED') {
            first_lot_submitted = isoDate(addDays(raised, between(2, 14)));
            rejected_on = isoDate(addDays(new Date(first_lot_submitted), between(1, 10)));
            rejection_reason = pick(REJECT_REASONS);
            rejection_count = between(1, 3);
            final_status = 'REJECTED';
        } else if (status === 'TIME_BARRED') {
            // Either never submitted, or submitted past deadline → barred
            if (rnd() > 0.5) first_lot_submitted = isoDate(addDays(deadline, between(1, 25)));
            rejection_reason = 'Time barred — submission past deadline';
            final_status = 'TIME_BARRED';
            rejection_count = 1;
        } else if (status === 'DISPUTED') {
            first_lot_submitted = isoDate(addDays(raised, between(2, 14)));
            rejected_on = isoDate(addDays(new Date(first_lot_submitted), between(1, 10)));
            is_dispute = 1;
            dispute_root_cause = pick(DISPUTE_ROOTS);
            rejection_reason = pick(REJECT_REASONS);
            rejection_count = between(1, 4);
            final_status = 'DISPUTED';
        }

        const period = `${raised.getFullYear()}-${String(raised.getMonth() + 1).padStart(2, '0')}`;
        const claim = {
            chassis_number: `MEC${String(100000 + i).padStart(7, '0')}`,
            dealer_code: dealer.dealer_code,
            scheme_code: scheme.scheme_code,
            customer_name: `Customer ${i + 1}`,
            model: pick(MODELS),
            variant: pick(VARIANTS),
            delivery_date: isoDate(addDays(raised, -between(1, 30))),
            claim_raised_on: isoDate(raised),
            submission_deadline: isoDate(deadline),
            first_lot_submitted, final_submitted, approved_on, rejected_on, settlement_date,
            status, final_status, rejection_reason, rejection_count,
            documentation_score: docScore,
            doc_gap_tags: docGaps.join(','),
            is_dispute, dispute_root_cause,
            claimed_amount, approved_amount,
            payout_kind: scheme.payout_kind,
            period_yyyymm: period
        };
        const info = insertClaim.run(claim);
        const cid = info.lastInsertRowid;

        insertEvent.run(cid, 'RAISED', claim.claim_raised_on, null);
        if (first_lot_submitted) insertEvent.run(cid, 'SUBMITTED', first_lot_submitted, null);
        if (rejected_on) insertEvent.run(cid, 'REJECTED', rejected_on, rejection_reason);
        if (approved_on) insertEvent.run(cid, 'APPROVED', approved_on, null);
        if (settlement_date) insertEvent.run(cid, 'SETTLED', settlement_date, null);
        if (status === 'TIME_BARRED') insertEvent.run(cid, 'TIME_BARRED', isoDate(addDays(deadline, 1)), null);
        if (is_dispute) {
            insertEvent.run(cid, 'DISPUTE_OPENED', rejected_on, dispute_root_cause);
            if (rnd() > 0.5) insertEvent.run(cid, 'DISPUTE_CLOSED', isoDate(addDays(new Date(rejected_on), between(15, 60))), 'closed');
        }
    }
});
tx();

// Recompute dealer risk_band from actual rejection / time_barred rates
const updateRisk = db.prepare(`UPDATE dealers SET risk_band = ? WHERE dealer_code = ?`);
const dealerStats = db.prepare(`
    SELECT dealer_code,
           COUNT(*)                                                              AS total,
           SUM(CASE WHEN status IN ('REJECTED','TIME_BARRED') THEN 1 ELSE 0 END) AS bad,
           SUM(CASE WHEN status='TIME_BARRED' THEN 1 ELSE 0 END)                 AS tb
      FROM claims
     GROUP BY dealer_code
`).all();
dealerStats.forEach(s => {
    const ratio = s.bad / Math.max(1, s.total);
    let band = 'LOW';
    if (ratio > 0.30 || s.tb > 8) band = 'HIGH';
    else if (ratio > 0.18 || s.tb > 3) band = 'MEDIUM';
    updateRisk.run(band, s.dealer_code);
});

const counts = {
    dealers: db.prepare('SELECT COUNT(*) c FROM dealers').get().c,
    schemes: db.prepare('SELECT COUNT(*) c FROM schemes').get().c,
    claims:  db.prepare('SELECT COUNT(*) c FROM claims').get().c,
    events:  db.prepare('SELECT COUNT(*) c FROM claim_events').get().c
};
console.log('Seed complete:', counts);
db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
