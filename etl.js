/**
 * ETL: rebuild the reporting DB from files/*.xlsx (real Skoda data).
 *
 * Target DB:
 *   - If DATABASE_URL is set → Postgres (uses schema.pg.sql).
 *   - Otherwise            → SQLite file at data/reports.sqlite3 (uses schema.sql).
 *
 * Run:  node etl.js
 *   or: DATABASE_URL=postgres://... node etl.js
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { open } = require('./db');

const FILES_DIR = path.join(__dirname, 'files');
const SQLITE_PATH = path.join(__dirname, 'data', 'reports.sqlite3');
const DIALECT = process.env.DATABASE_URL ? 'pg' : 'sqlite';
const SCHEMA_PATH = path.join(__dirname, DIALECT === 'pg' ? 'schema.pg.sql' : 'schema.sql');

// ─── xlsx helpers ────────────────────────────────────────────────────────
const excelDateToIso = v => {
    if (v == null || v === '') return null;
    if (typeof v === 'string') {
        const m = v.match(/^\d{4}-\d{2}-\d{2}/);
        return m ? m[0] : null;
    }
    if (typeof v !== 'number') return null;
    const ms = (v - 25569) * 86400 * 1000;
    const d = new Date(ms);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
};
const periodOf = iso => iso ? iso.slice(0, 7) : null;
const num = v => {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v;
    const n = parseFloat(String(v).replace(/[, ₹]/g, ''));
    return isFinite(n) ? n : 0;
};
const clean = v => String(v == null ? '' : v).trim();
const norm = s => clean(s).toUpperCase();

const safeXlsx = p => {
    try { return XLSX.readFile(p, { cellDates: false }); }
    catch (e) { console.warn('  skip', path.basename(p), e.message); return null; }
};

const HEADER_HINTS = ['chassis', 'vin', 'dealer code', 'record id', 'rfa no', 'commission number'];
function readSheet(wb, name) {
    if (!wb || !wb.Sheets[name]) return [];
    const raw = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
    let headerIdx = 0;
    for (let i = 0; i < Math.min(6, raw.length); i++) {
        const lowered = (raw[i] || []).map(c => String(c).toLowerCase());
        if (HEADER_HINTS.some(h => lowered.some(c => c.includes(h)))) {
            headerIdx = i; break;
        }
    }
    const header = (raw[headerIdx] || []).map(k =>
        String(k).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim());
    const out = [];
    for (let r = headerIdx + 1; r < raw.length; r++) {
        const row = raw[r] || [];
        if (row.every(v => v === '' || v == null)) continue;
        const obj = {};
        for (let c = 0; c < header.length; c++) {
            if (!header[c]) continue;
            obj[header[c]] = row[c] === undefined ? '' : row[c];
        }
        out.push(obj);
    }
    return out;
}
function pickField(row, ...names) {
    for (const n of names) {
        if (row[n] != null && row[n] !== '') return row[n];
    }
    return null;
}
function pickFieldLoose(row, ...needles) {
    const keys = Object.keys(row);
    for (const needle of needles) {
        const n = needle.toLowerCase();
        for (const k of keys) {
            if (k.toLowerCase().includes(n) && row[k] != null && row[k] !== '') return row[k];
        }
    }
    return null;
}

function normalizeDealerCode(rawCode) {
    if (rawCode == null) return null;
    let c = String(rawCode).trim();
    if (!c) return null;
    c = c.replace(/^938/, '');
    c = c.replace(/[^0-9A-Z]/gi, '');
    return c || null;
}

// ─── dialect-aware INSERT builder ────────────────────────────────────────
// SQLite: INSERT OR IGNORE / INSERT OR REPLACE
// Postgres: INSERT ... ON CONFLICT DO NOTHING / DO UPDATE
function insertSql(table, cols, opts = {}) {
    const colList = cols.join(', ');
    const paramList = cols.map(c => '@' + c).join(', ');
    if (DIALECT === 'pg') {
        if (opts.onConflict === 'ignore') {
            const conflict = opts.conflictKey || cols[0];
            return `INSERT INTO ${table} (${colList}) VALUES (${paramList}) ON CONFLICT (${conflict}) DO NOTHING`;
        }
        if (opts.onConflict === 'replace') {
            const conflict = opts.conflictKey || cols[0];
            // Support composite keys like "dealer_code, period_yyyymm"
            const keyCols = new Set(conflict.split(',').map(s => s.trim()));
            const updates = cols.filter(c => !keyCols.has(c))
                                 .map(c => `${c} = EXCLUDED.${c}`).join(', ');
            return `INSERT INTO ${table} (${colList}) VALUES (${paramList}) ON CONFLICT (${conflict}) DO UPDATE SET ${updates}`;
        }
        return `INSERT INTO ${table} (${colList}) VALUES (${paramList})`;
    }
    // sqlite
    if (opts.onConflict === 'ignore')  return `INSERT OR IGNORE  INTO ${table} (${colList}) VALUES (${paramList})`;
    if (opts.onConflict === 'replace') return `INSERT OR REPLACE INTO ${table} (${colList}) VALUES (${paramList})`;
    return `INSERT INTO ${table} (${colList}) VALUES (${paramList})`;
}

// ─── scheme catalogue ────────────────────────────────────────────────────
const SCHEMES = [
    { code: 'SKSL2026M03_555', name: 'DAN Support (Retail Tactical, per delivery)',       kind: 'RETAIL',    type: 'DAN',              file: 'SKSL2026M03_555.xlsx',                                              data_sheet: "March'26 DAN Support", vin_col: 'Chassis Number', amount_col: 'Retail Tactical Amount to be given', dealer_col: 'Dealer Code' },
    { code: 'SKSL2026M03_565', name: 'Demo Vehicle Support',                              kind: 'RETAIL',    type: 'DEMO',             file: 'SKSL2026M03_565.xlsx',                                              data_sheet: "Demo Support - Mar'26", vin_col: 'Chassis Number', amount_col: 'Demo Support to be given', dealer_col: 'Dealer Code' },
    { code: 'SKSL2026M03_575', name: 'Integrated Volume Bonus (Retail + Wholesale slab)', kind: 'WHOLESALE', type: 'VOLUME_BONUS',     file: 'SKSL2026M03_575.xlsx',                                              data_sheet: "Wholesale Mar'26", vin_col: 'Chassis Number', amount_col: 'Volume Bonus', dealer_col: 'Dealer Code' },
    { code: 'SKSL2026M03_576', name: 'Early Bird / Stock Support Incentive',              kind: 'WHOLESALE', type: 'EARLY_BIRD',       file: 'SKSL2026M03_576.xlsx',                                              data_sheet: "Wholesale Mar'26", vin_col: 'Chassis Number', amount_col: 'Stock Support Incentive', dealer_col: 'Dealer Code' },
    { code: 'SKSL2026M03_581', name: 'Sales Consultant Incentive',                        kind: 'RETAIL',    type: 'SC_INCENTIVE',     file: 'SC Incentive_SKSL2026M03_581.xlsx',                                 data_sheet: 'SC Incentive RB01 Add 2', vin_col: 'VIN', amount_col: 'SC Incentive Amount', dealer_col: 'Dealer Code' },
    { code: 'SKSL2026M03_582', name: 'Kushaq Metal-Out Regional Booster',                 kind: 'RETAIL',    type: 'REGIONAL_BOOSTER', file: 'Kushaq Metal out action - Regional Booster_SKSL2026M03_582.xlsx',   data_sheet: 'Base File', vin_col: 'VIN', amount_col: 'Kushaq Metal out Action Regional Booster', dealer_col: 'Dealer Code' },
    { code: 'SKSL2026M03_583', name: 'Kylaq Classic MT Regional Booster',                 kind: 'RETAIL',    type: 'REGIONAL_BOOSTER', file: 'Kylaq Classic MT Regional Booster_SKSL2026M03_583.xlsx',            data_sheet: 'Base File', vin_col: 'VIN', amount_col: 'Kylaq Classic MT Regional Booster', dealer_col: 'Dealer Code' },
    { code: 'SKSL2026M03_585', name: 'Wholesale Kodiaq Booster',                          kind: 'WHOLESALE', type: 'KODIAQ_BOOSTER',   file: 'Wholesale Kodiaq Booster_SKSL2026M03_585.xlsx',                     data_sheet: "Wholesale Mar'26", vin_col: 'Chassis Number', amount_col: 'Kodiaq Booster', dealer_col: 'Dealer Code' },
    { code: 'SKSL2026M03_612', name: 'Loyalty Bonus (Repeat-Customer Support)',           kind: 'RETAIL',    type: 'LOYALTY',          file: 'SKSL2026M03_612.xlsx',                                              data_sheet: 'Loyalty Payout', vin_col: 'Chassis Number', amount_col: 'SAIPL Contri (Inc GST)', dealer_col: 'Retail Dealer Code' },
    { code: 'SKSL2026M03_614', name: 'Corporate Customer Support',                        kind: 'RETAIL',    type: 'CORPORATE',        file: 'SKSL2026M03_614.xlsx',                                              data_sheet: 'Coporate Payout', vin_col: 'Chassis Number', amount_col: 'Actual Amount as on CDD', dealer_col: 'Retail Dealer Code' },
    { code: 'SKSL2026M03_615', name: 'Exchange / Scrappage Bonus',                        kind: 'RETAIL',    type: 'EXCHANGE',         file: 'SKSL2026M03_615.xlsx',                                              data_sheet: 'Exchange Payout', vin_col: 'Chassis Number', amount_col: 'SAIPL Contri', dealer_col: 'Retail Dealer Code' }
];

function modelGroupOf(modelCode, modelDesc) {
    const c = clean(modelCode).toUpperCase();
    const d = clean(modelDesc).toUpperCase();
    if (c.startsWith('PA') || d.includes('KUSHAQ')) return 'Kushaq';
    if (c.startsWith('PB') || d.includes('SLAVIA')) return 'Slavia';
    if (c.startsWith('PC') || d.includes('KYLAQ'))  return 'Kylaq';
    if (c.startsWith('PS') || d.includes('KODIAQ')) return 'Kodiaq';
    if (d.includes('OCTAVIA')) return 'Octavia';
    if (d.includes('SUPERB'))  return 'Superb';
    return d.split(' ')[0] || 'Other';
}

// ─── main ────────────────────────────────────────────────────────────────
async function main() {
    if (DIALECT === 'sqlite' && fs.existsSync(SQLITE_PATH)) fs.unlinkSync(SQLITE_PATH);
    const db = await open(SQLITE_PATH);
    console.log(`▶ using ${DIALECT} dialect (schema: ${path.basename(SCHEMA_PATH)})`);
    await db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

    if (!fs.existsSync(FILES_DIR)) {
        console.log('files/ folder missing — schema created, no data ingested');
        await db.close();
        return;
    }

    const dealerMap = new Map();
    function upsertDealer(fields) {
        const code = normalizeDealerCode(fields.dealer_code);
        if (!code) return null;
        const existing = dealerMap.get(code) || { dealer_code: code };
        ['dealer_code_isac', 'dealer_short_name', 'dealer_name', 'dealer_company',
         'rsm', 'zone', 'state', 'city', 'outlet'].forEach(k => {
            if (!existing[k] && fields[k]) existing[k] = fields[k];
        });
        dealerMap.set(code, existing);
        return existing;
    }

    // ---------- Book2 ----------
    console.log('▶ Book2.xlsx (dealer targets)');
    const book2 = safeXlsx(path.join(FILES_DIR, 'Book2.xlsx'));
    const targets = [];
    if (book2) {
        const rows = XLSX.utils.sheet_to_json(book2.Sheets['Sheet1'] || book2.Sheets[book2.SheetNames[0]], { defval: '' });
        rows.forEach(r => {
            const shortName = clean(r['Actual Dealer'] || r.Dealer);
            if (!shortName) return;
            targets.push({
                short: shortName, state: clean(r.State),
                zone: clean(r.Zone || 'India-I'),
                rtl: num(r['RTL TGTS']), ws: num(r['WS tgts'])
            });
        });
        console.log('   targets rows:', targets.length);
    }
    const targetByShort = new Map(targets.map(t => [norm(t.short), t]));

    // ---------- Retail ----------
    console.log('▶ Retail March 2026.xlsx (retail_sale)');
    const retailWb = safeXlsx(path.join(FILES_DIR, 'Retail March 2026.xlsx'));
    const retailRows = retailWb ? readSheet(retailWb, 'Retail Dump') : [];
    console.log('   retail rows:', retailRows.length);

    const RETAIL_COLS = ['vin','record_id','dealer_code','dealer_short_name','ws_dealer_code','ws_date',
                         'model_code','model_group','model_desc','variant','booking_date','delivery_date',
                         'period_yyyymm','customer_state','zone','rsm'];
    const modelSet = new Map();
    const retailBatch = [];
    const seenVin = new Set();

    for (const row of retailRows) {
        const vin = clean(pickField(row, 'VIN', 'Chassis Number'));
        if (!vin || seenVin.has(vin)) continue;
        seenVin.add(vin);
        const modelCode = clean(pickField(row, 'Model Code1', 'Model Code'));
        const modelDesc = clean(pickField(row, 'Model Desc', 'Model'));
        const group     = modelGroupOf(modelCode, modelDesc) || clean(row['Model Group Names']);
        const dealerCode = normalizeDealerCode(pickField(row, 'Dealer Code'));
        const wsDealer   = normalizeDealerCode(pickField(row, 'Wholesale Dealer Code', 'WS Dealer Code'));
        const shortName  = clean(pickField(row, 'Actual Dealer', 'Dealer Name'));
        const deliveryDate = excelDateToIso(pickField(row, 'Delivery Date', 'First Delivery Date (Qualified Lead - Vehicle)', 'Delivery to Customer'));
        upsertDealer({
            dealer_code: dealerCode,
            dealer_short_name: shortName,
            dealer_name: clean(pickField(row, 'Dealer Name')),
            rsm: clean(row.RSM),
            zone: clean(row.ZONE) || clean(row.Zone),
            state: clean(pickField(row, 'City/State (Registration)'))
        });
        if (modelCode && !modelSet.has(modelCode)) {
            modelSet.set(modelCode, { model_desc: modelDesc, model_group: group });
        }
        if (!dealerCode) continue; // NOT NULL in schema
        retailBatch.push({
            vin,
            record_id: clean(pickField(row, 'Record Id', 'Record Id (Qualified Lead - Vehicle)')) || null,
            dealer_code: dealerCode,
            dealer_short_name: shortName || null,
            ws_dealer_code: wsDealer || null,
            ws_date: excelDateToIso(pickField(row, 'Wholesale date', 'WS Date')),
            model_code: modelCode || null,
            model_group: group,
            model_desc: modelDesc || null,
            variant: clean(pickField(row, 'Final Grade Desc', 'Variant')) || null,
            booking_date: excelDateToIso(row['Booking Date']),
            delivery_date: deliveryDate,
            period_yyyymm: periodOf(deliveryDate) || '2026-03',
            customer_state: clean(pickField(row, 'City/State (Registration)')) || null,
            zone: clean(pickField(row, 'ZONE', 'Zone')) || null,
            rsm: clean(row.RSM) || null
        });
    }
    console.log('   flushing retail_sale (bulk)…');
    await db.bulkInsert('retail_sale', RETAIL_COLS, retailBatch, { onConflict: 'ignore', conflictKey: 'vin' });

    // ---------- Wholesale ----------
    console.log('▶ SKSL2026M03_575.xlsx / Wholesale Mar\'26 (wholesale_sale)');
    const wsWb = safeXlsx(path.join(FILES_DIR, 'SKSL2026M03_575.xlsx'));
    const wsRows = wsWb ? readSheet(wsWb, "Wholesale Mar'26") : [];
    console.log('   wholesale rows:', wsRows.length);

    const WS_COLS = ['chassis','commission_number','dealer_code','dealer_short_name','model_code','model_group',
                     'variant','invoice_number','invoice_date','invoice_amount','ws_date','period_yyyymm',
                     'basic_price','dealer_price','tax_amount','state_code','zone','rsm'];
    const wsBatch = [];
    const seenChassis = new Set();
    for (const row of wsRows) {
        const chassis = clean(pickField(row, 'Chassis Number'));
        if (!chassis || seenChassis.has(chassis)) continue;
        seenChassis.add(chassis);
        const modelCode = clean(pickField(row, 'Model Code'));
        const variant   = clean(pickField(row, 'Grade Description', 'Grades'));
        const group     = modelGroupOf(modelCode, variant) || clean(row.MODEL);
        const dealerCode = normalizeDealerCode(pickField(row, 'Dealer Code'));
        const shortName  = clean(pickField(row, 'Actual Dealer', 'DEALER'));
        const wsDate = excelDateToIso(pickField(row, 'Wholesale Date', 'Payment: Dealer Invoice Date'));
        upsertDealer({
            dealer_code: dealerCode,
            dealer_short_name: shortName,
            dealer_name: clean(pickField(row, 'Dealer: Company Name', 'Selling Dealer')),
            dealer_company: clean(pickField(row, 'Dealer: Company Name')),
            rsm: clean(row.RSM),
            zone: clean(pickField(row, 'ZONE')),
            city: clean(pickField(row, 'Dealer: Location'))
        });
        if (modelCode && !modelSet.has(modelCode)) {
            modelSet.set(modelCode, { model_desc: variant, model_group: group });
        }
        if (!dealerCode) continue;
        wsBatch.push({
            chassis,
            commission_number: clean(pickField(row, 'Commission Number')) || null,
            dealer_code: dealerCode,
            dealer_short_name: shortName || null,
            model_code: modelCode || null,
            model_group: group,
            variant: variant || null,
            invoice_number: clean(pickField(row, 'Payment: Dealer Invoice Number')) || null,
            invoice_date: excelDateToIso(pickField(row, 'Payment: Dealer Invoice Date')),
            invoice_amount: num(pickField(row, 'Payment: Dealer Invoice Amount')),
            ws_date: wsDate,
            period_yyyymm: periodOf(wsDate) || '2026-03',
            basic_price: num(pickField(row, 'Vehicle Basic Price')),
            dealer_price: num(pickField(row, 'Dealer Price')),
            tax_amount: num(pickField(row, 'Vehicle Tax Amount')),
            state_code: clean(pickField(row, 'State Code')) || null,
            zone: clean(pickField(row, 'ZONE')) || null,
            rsm: clean(row.RSM) || null
        });
    }
    console.log('   flushing wholesale_sale (bulk)…');
    await db.bulkInsert('wholesale_sale', WS_COLS, wsBatch, { onConflict: 'ignore', conflictKey: 'chassis' });

    // ---------- Models ----------
    const modelBatch = [...modelSet].map(([k, v]) =>
        ({ model_code: k, model_desc: v.model_desc, model_group: v.model_group }));
    await db.bulkInsert('model', ['model_code','model_desc','model_group'], modelBatch,
        { onConflict: 'ignore', conflictKey: 'model_code' });
    console.log('   models:', modelSet.size);

    // ---------- Schemes + claim lines + ISAC ----------
    console.log('▶ ingesting 11 scheme workbooks');
    const SCHEME_COLS = ['scheme_code','scheme_name','scheme_kind','scheme_type','period_yyyymm','target_payout','description'];
    const CLAIM_COLS  = ['scheme_code','vin','dealer_code','dealer_short_name','model_code','model_group',
                         'calculated_amount','eligibility','remarks','period_yyyymm'];
    const ISAC_COLS   = ['rfa_no','rfa_line_item','scheme_code','vin','dealer_code_isac','dealer_code',
                         'dealer_name','model_code','amount_payable','gl_account','gl_account_desc',
                         'ref_doc_no','ref_doc_date','hsn_code','tax','description','period_yyyymm','source_sheet'];
    const schemeBatch = [];
    const claimBatch  = [];
    const isacBatch   = [];

    function readControlTotal(wb) {
        if (!wb || !wb.Sheets['Control Sheet']) return null;
        const rows = XLSX.utils.sheet_to_json(wb.Sheets['Control Sheet'], { header: 1, defval: '' });
        for (const row of rows) {
            let labelCol = -1;
            for (let c = 0; c < row.length; c++) {
                const label = String(row[c] || '').toLowerCase();
                if (label.includes('amount as per calculation')) { labelCol = c; break; }
            }
            if (labelCol >= 0) {
                for (let c = labelCol + 1; c < row.length; c++) {
                    const v = num(row[c]);
                    if (v > 0) return v;
                }
            }
        }
        for (const row of rows) {
            for (let c = 0; c < row.length; c++) {
                const label = String(row[c] || '').toLowerCase();
                if (label.includes('payout data')) {
                    for (let x = c + 1; x < row.length; x++) {
                        const v = num(row[x]);
                        if (v > 0) return v;
                    }
                }
            }
        }
        return null;
    }

    function collectIsacSheet(wb, sheetName, sourceTag, schemeCode) {
        const rows = readSheet(wb, sheetName);
        let n = 0;
        for (const r of rows) {
            const vin = clean(pickFieldLoose(r, 'vin no', 'chassis'));
            const amt = num(pickFieldLoose(r, 'amount payable', 'amount to dealer'));
            if (!vin && !amt) continue;
            const rawDealer = pickField(r, 'Dealer code', 'Dealer Code');
            const dealerIsac = clean(rawDealer);
            const dealerNorm = normalizeDealerCode(rawDealer);
            isacBatch.push({
                rfa_no: clean(pickField(r, 'RFA no.', 'RFA No.')) || null,
                rfa_line_item: clean(pickField(r, 'RFA Line Item Number')) || null,
                scheme_code: schemeCode,
                vin: vin || null,
                dealer_code_isac: dealerIsac || null,
                dealer_code: dealerNorm,
                dealer_name: clean(pickField(r, 'Dealer Name')) || null,
                model_code: clean(pickField(r, 'Six Digit Model Code', 'Model Code')) || null,
                amount_payable: amt,
                gl_account: clean(pickField(r, 'GL account', 'GL Account')) || null,
                gl_account_desc: clean(pickField(r, 'GL account Description')) || null,
                ref_doc_no: clean(pickField(r, 'Ref Doc No.')) || null,
                ref_doc_date: excelDateToIso(pickField(r, 'Ref Doc Date')),
                hsn_code: clean(pickField(r, 'HSN Code')) || null,
                tax: num(pickField(r, 'Tax')),
                description: clean(pickField(r, 'Description', 'Ref Doc No.')) || null,
                period_yyyymm: '2026-03',
                source_sheet: sourceTag
            });
            n++;
        }
        return n;
    }

    for (const s of SCHEMES) {
        const wb = safeXlsx(path.join(FILES_DIR, s.file));
        if (!wb) continue;
        const target = readControlTotal(wb);
        schemeBatch.push({
            scheme_code: s.code, scheme_name: s.name,
            scheme_kind: s.kind, scheme_type: s.type,
            period_yyyymm: '2026-03', target_payout: target || 0,
            description: `Source: ${s.file}`
        });

        const rows = readSheet(wb, s.data_sheet);
        let claimCount = 0;
        for (const r of rows) {
            const vin = clean(pickField(r, s.vin_col, 'VIN', 'Chassis Number'));
            const amt = num(pickField(r, s.amount_col));
            if (!vin && !amt) continue;
            const modelCode = clean(pickField(r, 'Model Code1', 'Model Code'));
            const modelDesc = clean(pickField(r, 'Model Desc', 'Model'));
            const group = modelGroupOf(modelCode, modelDesc) || clean(r['Model Group Names']);
            const rawDealer = pickField(r, s.dealer_col, 'Dealer Code', 'Retail Dealer Code', 'Dealer code');
            const dealerCode = normalizeDealerCode(rawDealer);
            const short = clean(pickField(r, 'Actual Dealer', 'Dealer Name', 'Retail Dealer Name', 'WS Dealer Name'));
            const remarks = clean(pickField(r, 'Remarks', 'Remark', 'Loyalty Claim Remarks (1st Lot)', 'Corporate Claim Remarks (1st Lot)', 'Exchange Claim Remarks (1st Lot)')) || null;
            let eligibility = null;
            const elig = clean(pickField(r, 'Eligible for DAN Support?', 'SC Incentive Eligibility', 'Early incentive Eligibility', 'Payout Eligiblity', 'Kodiaq Applicability', 'Loyalty Claim Status', 'Corporate Status', 'Exchange Claim Status'));
            if (elig) {
                const u = elig.toUpperCase();
                if (u.includes('YES') || u.includes('ELIG') || u === 'Y' || u.includes('APPROVED') || u === 'PAID') eligibility = 'YES';
                else if (u.includes('NO') || u.includes('NOT') || u.includes('REJECT')) eligibility = 'NO';
                else eligibility = elig.slice(0, 40);
            } else if (amt > 0) {
                eligibility = 'YES';
            }
            claimBatch.push({
                scheme_code: s.code, vin: vin || null,
                dealer_code: dealerCode, dealer_short_name: short || null,
                model_code: modelCode || null, model_group: group,
                calculated_amount: amt, eligibility, remarks,
                period_yyyymm: '2026-03'
            });
            claimCount++;
        }

        let isacCount = 0;
        isacCount += collectIsacSheet(wb, "ISAC-Till 21st Sep'25", 'PRE_22SEP', s.code);
        isacCount += collectIsacSheet(wb, "ISAC-From 22nd Sep'25", 'POST_22SEP', s.code);
        isacCount += collectIsacSheet(wb, 'ISAC 1 EInvoice', 'ISAC1_EINVOICE', s.code);
        isacCount += collectIsacSheet(wb, 'ISAC 2 Non-EInvoice', 'ISAC2_NON', s.code);

        console.log(`    ${s.code} — ${s.name}  target=${target || 0}  claims=${claimCount}  isac=${isacCount}`);
    }

    console.log('   flushing scheme / scheme_claim_line / isac_payment_line (bulk)…');
    await db.bulkInsert('scheme', SCHEME_COLS, schemeBatch);
    await db.bulkInsert('scheme_claim_line', CLAIM_COLS, claimBatch);
    await db.bulkInsert('isac_payment_line', ISAC_COLS, isacBatch);

    // ---------- Dealer master ----------
    console.log('▶ persisting dealers');
    const DEALER_COLS = ['dealer_code','dealer_code_isac','dealer_short_name','dealer_name','dealer_company',
                         'rsm','zone','state','city','outlet'];

    const isacDealers = await db.prepare(`
        SELECT DISTINCT dealer_code, dealer_code_isac, dealer_name
          FROM isac_payment_line
         WHERE dealer_code IS NOT NULL
    `).all();
    isacDealers.forEach(r => upsertDealer({
        dealer_code: r.dealer_code,
        dealer_code_isac: r.dealer_code_isac,
        dealer_name: r.dealer_name
    }));

    dealerMap.forEach(d => {
        if (!d.dealer_short_name) return;
        const t = targetByShort.get(norm(d.dealer_short_name));
        if (t) {
            if (!d.zone)  d.zone  = t.zone;
            if (!d.state) d.state = t.state;
        }
    });

    const dealerBatch = [...dealerMap.values()].map(d => ({
        dealer_code:       d.dealer_code,
        dealer_code_isac:  d.dealer_code_isac || null,
        dealer_short_name: d.dealer_short_name || null,
        dealer_name:       d.dealer_name || null,
        dealer_company:    d.dealer_company || null,
        rsm:               d.rsm || null,
        zone:              d.zone || null,
        state:             d.state || null,
        city:              d.city || null,
        outlet:            d.outlet || null
    }));
    await db.bulkInsert('dealer', DEALER_COLS, dealerBatch,
        { onConflict: 'replace', conflictKey: 'dealer_code' });

    // ---------- Targets ----------
    console.log('▶ dealer targets (Book2 → 2026-03)');
    const TARGET_COLS = ['dealer_code','period_yyyymm','retail_target','wholesale_target'];
    const shortToCode = new Map();
    dealerMap.forEach(d => {
        if (d.dealer_short_name) shortToCode.set(norm(d.dealer_short_name), d.dealer_code);
    });
    const targetBatch = [];
    for (const t of targets) {
        const code = shortToCode.get(norm(t.short));
        if (!code) continue;
        targetBatch.push({
            dealer_code: code, period_yyyymm: '2026-03',
            retail_target: t.rtl, wholesale_target: t.ws
        });
    }
    await db.bulkInsert('dealer_month_target', TARGET_COLS, targetBatch,
        { onConflict: 'replace', conflictKey: 'dealer_code, period_yyyymm' });
    console.log('   targets applied:', targetBatch.length);

    // ---------- Summary ----------
    const cnt = async table => Number((await db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()).c);
    const counts = {
        dealer:            await cnt('dealer'),
        retail_sale:       await cnt('retail_sale'),
        wholesale_sale:    await cnt('wholesale_sale'),
        scheme:            await cnt('scheme'),
        scheme_claim_line: await cnt('scheme_claim_line'),
        isac_payment_line: await cnt('isac_payment_line')
    };
    console.log('ETL complete:', counts);
    await db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
