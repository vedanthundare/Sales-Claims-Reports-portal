/**
 * Skoda Sales Claims — reporting service (Postgres or SQLite).
 *
 *   GET  /                              -> embedded HTML UI (public/index.html)
 *   GET  /api/meta                      -> report catalogue + filter options
 *   GET  /api/kpis/:role                -> role KPIs (manager | dealer | finance)
 *   GET  /api/charts/:chart             -> dashboard chart data
 *   GET  /api/dealers                   -> dealer directory for the dealer view
 *   GET  /api/reports/:id               -> canned report JSON { rows, summary, meta }
 *   GET  /api/reports/:id/download      -> CSV / XLSX export
 *
 * DB selection: sets DATABASE_URL to use Postgres, else falls back to SQLite
 * file at data/reports.sqlite3.
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const XLSX = require('xlsx');

const { reports, kpis, charts } = require('./reports');
const { open } = require('./db');

const DIALECT = process.env.DATABASE_URL ? 'pg' : 'sqlite';
const DB_PATH = path.join(__dirname, 'data', 'reports.sqlite3');

if (DIALECT === 'sqlite') {
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

// ETL runner only makes sense when files/ is present (i.e. dev machine).
async function ensureDb() {
    if (DIALECT === 'sqlite') {
        if (fs.existsSync(DB_PATH)) return;
        if (fs.existsSync(path.join(__dirname, 'files'))) {
            console.log('reports.sqlite3 missing — running ETL');
            await require('./seed-runner')();
        } else {
            console.log('reports.sqlite3 missing and no files/ folder — starting with empty schema');
            const db = await open(DB_PATH);
            const schemaPath = path.join(__dirname, 'schema.sql');
            await db.exec(fs.readFileSync(schemaPath, 'utf8'));
            await db.close();
        }
    }
    // For Postgres, we assume the DB is either populated by a local ETL run
    // (DATABASE_URL=<render-pg-url> node etl.js) or empty (dashboard shows empty state).
}

let db;
let dbHasData = false;

async function checkDataPresent() {
    try {
        const row = await db.prepare('SELECT COUNT(*) AS c FROM scheme_claim_line').get();
        return Number(row && row.c) > 0;
    } catch (e) {
        // Tables don't exist — create them from schema file (Postgres path).
        if (DIALECT === 'pg') {
            const schemaPath = path.join(__dirname, 'schema.pg.sql');
            console.log('Schema missing — creating from', schemaPath);
            await db.exec(fs.readFileSync(schemaPath, 'utf8'));
        }
        return false;
    }
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// small helper: wrap async route handlers so thrown errors surface cleanly
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
    console.error(req.path, err);
    res.status(500).json({ error: err.message });
});

// -------- Health / status --------
app.get('/api/health', (req, res) => {
    res.json({ ok: true, dialect: DIALECT, hasData: dbHasData });
});

// -------- Meta --------
app.get('/api/meta', wrap(async (req, res) => {
    if (!dbHasData) {
        return res.json({
            empty: true,
            message: 'The database is empty. Run `node etl.js` locally against DATABASE_URL to populate.',
            reports: [], filter_options: {
                period_yyyymm: [], zone: [], dealer: [], scheme: [],
                scheme_type: [], scheme_kind: [], model_group: [],
                status: [], group_by: []
            }
        });
    }
    const dealerOpts = await db.prepare(`
        SELECT dealer_code,
               COALESCE(dealer_short_name, dealer_name, dealer_code) AS dealer_name,
               zone
          FROM dealer
         WHERE dealer_code IS NOT NULL
         ORDER BY dealer_name
    `).all();
    const schemeOpts = await db.prepare(`
        SELECT scheme_code, scheme_name, scheme_type, scheme_kind, target_payout
          FROM scheme ORDER BY scheme_name
    `).all();
    const zoneOpts = (await db.prepare(`
        SELECT DISTINCT zone FROM dealer WHERE zone IS NOT NULL AND zone <> '' ORDER BY zone
    `).all()).map(r => r.zone);
    const modelGroups = (await db.prepare(`
        SELECT DISTINCT model_group FROM model
         WHERE model_group IS NOT NULL AND model_group <> ''
         ORDER BY model_group
    `).all()).map(r => r.model_group);
    const periods = (await db.prepare(`
        SELECT DISTINCT period_yyyymm FROM scheme_claim_line
         WHERE period_yyyymm IS NOT NULL ORDER BY period_yyyymm DESC
    `).all()).map(r => r.period_yyyymm);

    const reportList = Object.values(reports).map(r => ({ ...r.meta, filters: r.filters }));

    res.json({
        reports: reportList,
        filter_options: {
            period_yyyymm: periods,
            zone:          zoneOpts,
            dealer:        dealerOpts,
            scheme:        schemeOpts,
            scheme_type:   ['DAN','DEMO','SC_INCENTIVE','REGIONAL_BOOSTER','LOYALTY','CORPORATE','EXCHANGE','VOLUME_BONUS','EARLY_BIRD','KODIAQ_BOOSTER'],
            scheme_kind:   ['RETAIL','WHOLESALE'],
            model_group:   modelGroups,
            status:        ['APPROVED','PENDING','REJECTED'],
            group_by:      ['dealer','scheme','period']
        }
    });
}));

// -------- Role KPIs --------
app.get('/api/kpis/:role', wrap(async (req, res) => {
    const role = req.params.role;
    if (!kpis[role]) return res.status(404).json({ error: 'Unknown role' });
    const result = await kpis[role](db, req.query);
    res.json(result || {});
}));

// -------- Charts --------
app.get('/api/charts/:chart', wrap(async (req, res) => {
    const key = req.params.chart;
    if (!charts[key]) return res.status(404).json({ error: 'Unknown chart' });
    const result = await charts[key](db, req.query);
    res.json({ data: result });
}));

// -------- Dealer directory --------
app.get('/api/dealers', wrap(async (req, res) => {
    const rows = await db.prepare(`
        SELECT d.dealer_code,
               COALESCE(d.dealer_short_name, d.dealer_name, d.dealer_code) AS dealer_name,
               d.zone, d.state, d.rsm,
               t.retail_target, t.wholesale_target
          FROM dealer d
     LEFT JOIN dealer_month_target t
            ON t.dealer_code = d.dealer_code AND t.period_yyyymm = '2026-03'
         WHERE d.dealer_code IS NOT NULL
         ORDER BY dealer_name
    `).all();
    res.json({ rows });
}));

// -------- Run a canned report --------
app.get('/api/reports/:id', wrap(async (req, res) => {
    const def = reports[req.params.id];
    if (!def) return res.status(404).json({ error: 'Unknown report' });
    const result = await def.run(db, req.query);
    res.json({ meta: def.meta, filters: req.query, ...result });
}));

// -------- Download report --------
app.get('/api/reports/:id/download', wrap(async (req, res) => {
    const def = reports[req.params.id];
    if (!def) return res.status(404).json({ error: 'Unknown report' });
    const format = (req.query.format || 'xlsx').toLowerCase();
    const { rows } = await def.run(db, req.query);
    const cols = def.meta.columns;
    const filename = `${def.meta.id}_${new Date().toISOString().slice(0,10)}`;

    if (format === 'csv') {
        const esc = v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
        const header = cols.map(c => esc(c.label)).join(',');
        const body = rows.map(r => cols.map(c => esc(r[c.key])).join(',')).join('\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
        return res.send(header + '\n' + body);
    }

    const sheetData = [
        cols.map(c => c.label),
        ...rows.map(r => cols.map(c => r[c.key] == null ? '' : r[c.key]))
    ];
    const ws = XLSX.utils.aoa_to_sheet(sheetData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, def.meta.title.slice(0, 28));
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    res.send(buf);
}));

const PORT = process.env.PORT || 4500;
(async () => {
    try {
        await ensureDb();
        db = await open(DB_PATH);
        dbHasData = await checkDataPresent();
        console.log(`DB (${DIALECT}): ${dbHasData ? 'populated' : 'empty'}`);
        app.listen(PORT, () => {
            console.log(`Skoda Reports service running on port ${PORT}`);
        });
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();
