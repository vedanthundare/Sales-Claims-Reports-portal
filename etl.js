/**
 * ETL: rebuild reports.sqlite3 from files/*.xlsx (real Skoda data).
 *
 * Pipeline
 *   Book2.xlsx                          -> dealer_month_target seed + dealer names
 *   Retail March 2026 / Retail Dump     -> retail_sale (6,440 delivered VINs) + dealer master
 *   SKSL2026M03_575 / Wholesale Mar'26  -> wholesale_sale (7,937 invoiced VINs)
 *   All 11 scheme workbooks             -> scheme + scheme_claim_line (per-VIN calc)
 *   Every ISAC-* sheet inside each      -> isac_payment_line (what was actually paid)
 *
 * Run:  node etl.js
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { open } = require('./db');

const FILES_DIR = path.join(__dirname, 'files');
const DB_PATH = path.join(__dirname, 'data', 'reports.sqlite3');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

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
    // Build rows by hand from raw[] to avoid sheet_to_json's `range` mismatching
    // when the sheet's !ref doesn't start at A1 (e.g. some ISAC sheets).
    const header = (raw[headerIdx] || []).map(k =>
        String(k).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim());
    const out = [];
    for (let r = headerIdx + 1; r < raw.length; r++) {
        const row = raw[r] || [];
        // skip completely empty rows
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
// Fallback: substring match on the header (case-insensitive, ignoring parens/punct)
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
    // ISAC form 93810296 → 10296 ; retail short with '01A' suffix → keep base
    c = c.replace(/^938/, '');
    c = c.replace(/[^0-9A-Z]/gi, '');
    return c || null;
}

// ─── scheme catalogue (workbook → scheme metadata) ───────────────────────
const SCHEMES = [
    { code: 'SKSL2026M03_555', name: 'DAN Support (Retail Tactical, per delivery)',      kind: 'RETAIL',    type: 'DAN',              file: 'SKSL2026M03_555.xlsx',                                                    data_sheet: "March'26 DAN Support", vin_col: 'Chassis Number',     amount_col: 'Retail Tactical Amount to be given', dealer_col: 'Dealer Code' },
    { code: 'SKSL2026M03_565', name: 'Demo Vehicle Support',                             kind: 'RETAIL',    type: 'DEMO',             file: 'SKSL2026M03_565.xlsx',                                                    data_sheet: "Demo Support - Mar'26", vin_col: 'Chassis Number',    amount_col: 'Demo Support to be given',           dealer_col: 'Dealer Code' },
    { code: 'SKSL2026M03_575', name: 'Integrated Volume Bonus (Retail + Wholesale slab)',kind: 'WHOLESALE', type: 'VOLUME_BONUS',     file: 'SKSL2026M03_575.xlsx',                                                    data_sheet: "Wholesale Mar'26",     vin_col: 'Chassis Number',   amount_col: 'Volume Bonus',                       dealer_col: 'Dealer Code' },
    { code: 'SKSL2026M03_576', name: 'Early Bird / Stock Support Incentive',              kind: 'WHOLESALE', type: 'EARLY_BIRD',       file: 'SKSL2026M03_576.xlsx',                                                    data_sheet: "Wholesale Mar'26",     vin_col: 'Chassis Number',   amount_col: 'Stock Support Incentive',            dealer_col: 'Dealer Code' },
    { code: 'SKSL2026M03_581', name: 'Sales Consultant Incentive',                        kind: 'RETAIL',    type: 'SC_INCENTIVE',     file: 'SC Incentive_SKSL2026M03_581.xlsx',                                       data_sheet: 'SC Incentive RB01 Add 2', vin_col: 'VIN',            amount_col: 'SC Incentive Amount',                dealer_col: 'Dealer Code' },
    { code: 'SKSL2026M03_582', name: 'Kushaq Metal-Out Regional Booster',                 kind: 'RETAIL',    type: 'REGIONAL_BOOSTER', file: 'Kushaq Metal out action - Regional Booster_SKSL2026M03_582.xlsx',         data_sheet: 'Base File',            vin_col: 'VIN',              amount_col: 'Kushaq Metal out Action Regional Booster', dealer_col: 'Dealer Code' },
    { code: 'SKSL2026M03_583', name: 'Kylaq Classic MT Regional Booster',                 kind: 'RETAIL',    type: 'REGIONAL_BOOSTER', file: 'Kylaq Classic MT Regional Booster_SKSL2026M03_583.xlsx',                  data_sheet: 'Base File',            vin_col: 'VIN',              amount_col: 'Kylaq Classic MT Regional Booster',  dealer_col: 'Dealer Code' },
    { code: 'SKSL2026M03_585', name: 'Wholesale Kodiaq Booster',                          kind: 'WHOLESALE', type: 'KODIAQ_BOOSTER',   file: 'Wholesale Kodiaq Booster_SKSL2026M03_585.xlsx',                           data_sheet: "Wholesale Mar'26",     vin_col: 'Chassis Number',   amount_col: 'Kodiaq Booster',                     dealer_col: 'Dealer Code' },
    { code: 'SKSL2026M03_612', name: 'Loyalty Bonus (Repeat-Customer Support)',           kind: 'RETAIL',    type: 'LOYALTY',          file: 'SKSL2026M03_612.xlsx',                                                    data_sheet: 'Loyalty Payout',       vin_col: 'Chassis Number',   amount_col: 'SAIPL Contri (Inc GST)',             dealer_col: 'Retail Dealer Code' },
    { code: 'SKSL2026M03_614', name: 'Corporate Customer Support',                        kind: 'RETAIL',    type: 'CORPORATE',        file: 'SKSL2026M03_614.xlsx',                                                    data_sheet: 'Coporate Payout',      vin_col: 'Chassis Number',   amount_col: 'Actual Amount as on CDD',            dealer_col: 'Retail Dealer Code' },
    { code: 'SKSL2026M03_615', name: 'Exchange / Scrappage Bonus',                        kind: 'RETAIL',    type: 'EXCHANGE',         file: 'SKSL2026M03_615.xlsx',                                                    data_sheet: 'Exchange Payout',      vin_col: 'Chassis Number',   amount_col: 'SAIPL Contri',                       dealer_col: 'Retail Dealer Code' }
];

const CTRL_TOTAL_HINTS = ['payout data', 'as per calculation', 'total', 'amount as per'];

// ─── model group inference from Model Code / Model Desc ──────────────────
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
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    const db = await open(DB_PATH);
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

    // ---------- Dealer master (built lazily from retail + wholesale) ----------
    const dealerMap = new Map(); // dealer_code -> row

    function upsertDealer(fields) {
        const code = normalizeDealerCode(fields.dealer_code);
        if (!code) return null;
        const existing = dealerMap.get(code) || { dealer_code: code };
        // fill only if not already present
        ['dealer_code_isac', 'dealer_short_name', 'dealer_name', 'dealer_company',
         'rsm', 'zone', 'state', 'city', 'outlet'].forEach(k => {
            if (!existing[k] && fields[k]) existing[k] = fields[k];
        });
        dealerMap.set(code, existing);
        return existing;
    }

    // ---------- Book2.xlsx  → targets + short-name seeds ----------
    console.log('▶ Book2.xlsx (dealer targets)');
    const book2 = safeXlsx(path.join(FILES_DIR, 'Book2.xlsx'));
    const targets = []; // {dealer_short_name, zone, state, rtl, ws}
    if (book2) {
        const rows = XLSX.utils.sheet_to_json(book2.Sheets['Sheet1'] || book2.Sheets[book2.SheetNames[0]], { defval: '' });
        rows.forEach(r => {
            const shortName = clean(r['Actual Dealer'] || r.Dealer);
            if (!shortName) return;
            targets.push({
                short: shortName,
                state: clean(r.State),
                zone: clean(r.Zone || 'India-I'),
                rtl: num(r['RTL TGTS']),
                ws:  num(r['WS tgts'])
            });
        });
        console.log('   targets rows:', targets.length);
    }
    const targetByShort = new Map(targets.map(t => [norm(t.short), t]));

    // ---------- Retail March 2026  → retail_sale + dealer names ----------
    console.log('▶ Retail March 2026.xlsx (retail_sale)');
    const retailWb = safeXlsx(path.join(FILES_DIR, 'Retail March 2026.xlsx'));
    const retailRows = retailWb ? readSheet(retailWb, 'Retail Dump') : [];
    console.log('   retail rows:', retailRows.length);

    const insertRetail = db.prepare(`
        INSERT OR IGNORE INTO retail_sale
            (vin, record_id, dealer_code, dealer_short_name, ws_dealer_code, ws_date,
             model_code, model_group, model_desc, variant, booking_date, delivery_date,
             period_yyyymm, customer_state, zone, rsm)
        VALUES (@vin,@record_id,@dealer_code,@dealer_short_name,@ws_dealer_code,@ws_date,
                @model_code,@model_group,@model_desc,@variant,@booking_date,@delivery_date,
                @period_yyyymm,@customer_state,@zone,@rsm)
    `);

    const modelSet = new Map(); // model_code -> {model_desc, model_group}

    const retailTx = db.transaction(() => {
        retailRows.forEach(row => {
            const vin = clean(pickField(row, 'VIN', 'Chassis Number'));
            if (!vin) return;
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
            if (modelCode) {
                if (!modelSet.has(modelCode)) modelSet.set(modelCode, { model_desc: modelDesc, model_group: group });
            }
            insertRetail.run({
                vin,
                record_id: clean(pickField(row, 'Record Id', 'Record Id (Qualified Lead - Vehicle)')),
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
        });
    });
    retailTx();

    // ---------- Wholesale (use the 575 workbook — same base rows) ----------
    console.log('▶ SKSL2026M03_575.xlsx / Wholesale Mar\'26 (wholesale_sale)');
    const wsWb = safeXlsx(path.join(FILES_DIR, 'SKSL2026M03_575.xlsx'));
    const wsRows = wsWb ? readSheet(wsWb, "Wholesale Mar'26") : [];
    console.log('   wholesale rows:', wsRows.length);

    const insertWs = db.prepare(`
        INSERT OR IGNORE INTO wholesale_sale
            (chassis, commission_number, dealer_code, dealer_short_name, model_code, model_group,
             variant, invoice_number, invoice_date, invoice_amount, ws_date, period_yyyymm,
             basic_price, dealer_price, tax_amount, state_code, zone, rsm)
        VALUES (@chassis,@commission_number,@dealer_code,@dealer_short_name,@model_code,@model_group,
                @variant,@invoice_number,@invoice_date,@invoice_amount,@ws_date,@period_yyyymm,
                @basic_price,@dealer_price,@tax_amount,@state_code,@zone,@rsm)
    `);
    const wsTx = db.transaction(() => {
        wsRows.forEach(row => {
            const chassis = clean(pickField(row, 'Chassis Number'));
            if (!chassis) return;
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
            insertWs.run({
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
        });
    });
    wsTx();

    // ---------- Persist models ----------
    const insertModel = db.prepare(`
        INSERT OR IGNORE INTO model (model_code, model_desc, model_group)
        VALUES (?, ?, ?)
    `);
    modelSet.forEach((v, k) => insertModel.run(k, v.model_desc, v.model_group));
    console.log('   models:', modelSet.size);

    // ---------- Schemes + claim lines + ISAC payments ----------
    console.log('▶ ingesting 11 scheme workbooks');
    const insertScheme = db.prepare(`
        INSERT INTO scheme (scheme_code, scheme_name, scheme_kind, scheme_type,
                            period_yyyymm, target_payout, description)
        VALUES (@scheme_code,@scheme_name,@scheme_kind,@scheme_type,
                @period_yyyymm,@target_payout,@description)
    `);
    const insertClaim = db.prepare(`
        INSERT INTO scheme_claim_line
            (scheme_code, vin, dealer_code, dealer_short_name, model_code, model_group,
             calculated_amount, eligibility, remarks, period_yyyymm)
        VALUES (@scheme_code,@vin,@dealer_code,@dealer_short_name,@model_code,@model_group,
                @calculated_amount,@eligibility,@remarks,@period_yyyymm)
    `);
    const insertIsac = db.prepare(`
        INSERT INTO isac_payment_line
            (rfa_no, rfa_line_item, scheme_code, vin, dealer_code_isac, dealer_code,
             dealer_name, model_code, amount_payable, gl_account, gl_account_desc,
             ref_doc_no, ref_doc_date, hsn_code, tax, description, period_yyyymm, source_sheet)
        VALUES (@rfa_no,@rfa_line_item,@scheme_code,@vin,@dealer_code_isac,@dealer_code,
                @dealer_name,@model_code,@amount_payable,@gl_account,@gl_account_desc,
                @ref_doc_no,@ref_doc_date,@hsn_code,@tax,@description,@period_yyyymm,@source_sheet)
    `);

    function readControlTotal(wb) {
        if (!wb || !wb.Sheets['Control Sheet']) return null;
        const rows = XLSX.utils.sheet_to_json(wb.Sheets['Control Sheet'], { header: 1, defval: '' });
        // Find the FIRST row containing an "amount as per calculation" style label
        // in ANY column, then take the first numeric value in that row.
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
        // Fallback: any row with 'payout data (total)'
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

    function ingestIsacSheet(wb, sheetName, sourceTag, schemeCode) {
        const rows = readSheet(wb, sheetName);
        let n = 0;
        rows.forEach(r => {
            const vin = clean(pickFieldLoose(r, 'vin no', 'chassis'));
            const amt = num(pickFieldLoose(r, 'amount payable', 'amount to dealer'));
            if (!vin && !amt) return;
            const rawDealer = pickField(r, 'Dealer code', 'Dealer Code');
            const dealerIsac = clean(rawDealer);
            const dealerNorm = normalizeDealerCode(rawDealer);
            insertIsac.run({
                rfa_no: clean(pickField(r, 'RFA no.', 'RFA No.')),
                rfa_line_item: clean(pickField(r, 'RFA Line Item Number')),
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
        });
        return n;
    }

    for (const s of SCHEMES) {
        const wb = safeXlsx(path.join(FILES_DIR, s.file));
        if (!wb) continue;
        const target = readControlTotal(wb);
        insertScheme.run({
            scheme_code: s.code,
            scheme_name: s.name,
            scheme_kind: s.kind,
            scheme_type: s.type,
            period_yyyymm: '2026-03',
            target_payout: target || 0,
            description: `Source: ${s.file}`
        });

        // claim lines
        const rows = readSheet(wb, s.data_sheet);
        let claimCount = 0;
        const claimTx = db.transaction(() => {
            rows.forEach(r => {
                const vin = clean(pickField(r, s.vin_col, 'VIN', 'Chassis Number'));
                const amt = num(pickField(r, s.amount_col));
                if (!vin && !amt) return;
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
                insertClaim.run({
                    scheme_code: s.code,
                    vin: vin || null,
                    dealer_code: dealerCode,
                    dealer_short_name: short || null,
                    model_code: modelCode || null,
                    model_group: group,
                    calculated_amount: amt,
                    eligibility,
                    remarks,
                    period_yyyymm: '2026-03'
                });
                claimCount++;
            });
        });
        claimTx();

        // ISAC (two sheets in most workbooks)
        let isacCount = 0;
        const isacTx = db.transaction(() => {
            isacCount += ingestIsacSheet(wb, "ISAC-Till 21st Sep'25", 'PRE_22SEP', s.code);
            isacCount += ingestIsacSheet(wb, "ISAC-From 22nd Sep'25", 'POST_22SEP', s.code);
            isacCount += ingestIsacSheet(wb, 'ISAC 1 EInvoice', 'ISAC1_EINVOICE', s.code);
            isacCount += ingestIsacSheet(wb, 'ISAC 2 Non-EInvoice', 'ISAC2_NON', s.code);
        });
        isacTx();

        console.log(`    ${s.code} — ${s.name}  target=${target || 0}  claims=${claimCount}  isac=${isacCount}`);
    }

    // ---------- Persist dealer master ----------
    console.log('▶ persisting dealers');
    const insertDealer = db.prepare(`
        INSERT OR REPLACE INTO dealer
            (dealer_code, dealer_code_isac, dealer_short_name, dealer_name, dealer_company,
             rsm, zone, state, city, outlet)
        VALUES (@dealer_code,@dealer_code_isac,@dealer_short_name,@dealer_name,@dealer_company,
                @rsm,@zone,@state,@city,@outlet)
    `);
    // Also pull dealer codes from ISAC (some dealers only appear on ISAC)
    const isacDealers = db.prepare(`
        SELECT DISTINCT dealer_code, dealer_code_isac, dealer_name
          FROM isac_payment_line
         WHERE dealer_code IS NOT NULL
    `).all();
    isacDealers.forEach(r => upsertDealer({
        dealer_code: r.dealer_code,
        dealer_code_isac: r.dealer_code_isac,
        dealer_name: r.dealer_name
    }));

    // Enrich with Book2 targets by short name match
    dealerMap.forEach(d => {
        if (!d.dealer_short_name) return;
        const t = targetByShort.get(norm(d.dealer_short_name));
        if (t) {
            if (!d.zone)  d.zone  = t.zone;
            if (!d.state) d.state = t.state;
        }
    });

    const dealerTx = db.transaction(() => {
        dealerMap.forEach(d => insertDealer.run({
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
    });
    dealerTx();

    // ---------- Dealer month targets (Book2 assumed for 2026-03) ----------
    console.log('▶ dealer targets (Book2 → 2026-03)');
    const insertTarget = db.prepare(`
        INSERT OR REPLACE INTO dealer_month_target
            (dealer_code, period_yyyymm, retail_target, wholesale_target)
        VALUES (?, ?, ?, ?)
    `);
    // match by short name
    const shortToCode = new Map();
    dealerMap.forEach(d => {
        if (d.dealer_short_name) shortToCode.set(norm(d.dealer_short_name), d.dealer_code);
    });
    let tCount = 0;
    targets.forEach(t => {
        const code = shortToCode.get(norm(t.short));
        if (!code) return;
        insertTarget.run(code, '2026-03', t.rtl, t.ws);
        tCount++;
    });
    console.log('   targets applied:', tCount);

    // ---------- Summary ----------
    const counts = {
        dealer:            db.prepare('SELECT COUNT(*) c FROM dealer').get().c,
        retail_sale:       db.prepare('SELECT COUNT(*) c FROM retail_sale').get().c,
        wholesale_sale:    db.prepare('SELECT COUNT(*) c FROM wholesale_sale').get().c,
        scheme:            db.prepare('SELECT COUNT(*) c FROM scheme').get().c,
        scheme_claim_line: db.prepare('SELECT COUNT(*) c FROM scheme_claim_line').get().c,
        isac_payment_line: db.prepare('SELECT COUNT(*) c FROM isac_payment_line').get().c,
        total_claimed:     db.prepare('SELECT ROUND(SUM(calculated_amount)) c FROM scheme_claim_line').get().c,
        total_paid:        db.prepare('SELECT ROUND(SUM(amount_payable)) c FROM isac_payment_line').get().c
    };
    console.log('ETL complete:', counts);
    db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
