/**
 * Standalone Skoda Sales Claims Reporting service.
 *
 *   GET  /api/meta                       -> list of report definitions + filter options
 *   GET  /api/reports/:id?<filters>      -> JSON { rows, summary, meta }
 *   GET  /api/reports/:id/download?...   -> CSV / XLSX file (format=csv|xlsx)
 *   GET  /                               -> embedded HTML UI
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const XLSX = require('xlsx');

const { reports } = require('./reports');
const { open } = require('./db');

const DB_PATH = path.join(__dirname, 'data', 'reports.sqlite3');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Auto-seed on first boot (e.g. fresh deploy with ephemeral disk)
async function ensureDb() {
    if (fs.existsSync(DB_PATH)) return;
    console.log('reports.sqlite3 missing — running seed.js');
    await require('./seed-runner')();
}

let db;
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// -------- Meta: report list + filter dropdown options --------
app.get('/api/meta', (req, res) => {
    const dealerOpts = db.prepare('SELECT dealer_code, dealer_name FROM dealers ORDER BY dealer_name').all();
    const schemeOpts = db.prepare('SELECT scheme_code, scheme_name, scheme_type FROM schemes ORDER BY scheme_name').all();
    const regionOpts = db.prepare('SELECT DISTINCT region FROM dealers ORDER BY region').all().map(r => r.region);
    const zoneOpts   = db.prepare('SELECT DISTINCT zone   FROM dealers ORDER BY zone').all().map(r => r.zone);

    const reportList = Object.values(reports).map(r => ({
        ...r.meta,
        filters: r.filters
    }));

    res.json({
        reports: reportList,
        filter_options: {
            region:      regionOpts,
            zone:        zoneOpts,
            dealer:      dealerOpts,
            scheme:      schemeOpts,
            scheme_type: ['CORPORATE','EXCHANGE','LOYALTY','RETAIL_TACTICAL','BASE'],
            payout_kind: ['BASE','TACTICAL'],
            risk_band:   ['LOW','MEDIUM','HIGH'],
            fnf_status:  ['ACTIVE','NEARING_EXIT','EXITED'],
            status:      ['APPROVED','PENDING','REJECTED','TIME_BARRED','DISPUTED'],
            group_by:    ['dealer','scheme','period']
        }
    });
});

// -------- Run a report --------
app.get('/api/reports/:id', (req, res) => {
    const def = reports[req.params.id];
    if (!def) return res.status(404).json({ error: 'Unknown report' });
    try {
        const { rows, summary } = def.run(db, req.query);
        res.json({ meta: def.meta, filters: req.query, rows, summary });
    } catch (err) {
        console.error('[report]', req.params.id, err);
        res.status(500).json({ error: err.message });
    }
});

// -------- Download as CSV / XLSX --------
app.get('/api/reports/:id/download', (req, res) => {
    const def = reports[req.params.id];
    if (!def) return res.status(404).json({ error: 'Unknown report' });
    const format = (req.query.format || 'xlsx').toLowerCase();
    const { rows } = def.run(db, req.query);
    const cols = def.meta.columns;
    const filename = `${def.meta.id}_${new Date().toISOString().slice(0,10)}`;

    if (format === 'csv') {
        const esc = v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
        const header = cols.map(c => esc(c.label)).join(',');
        const body = rows.map(r => cols.map(c => esc(r[c.key])).join(',')).join('\n');
        const csv = header + '\n' + body;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
        return res.send(csv);
    }

    // XLSX
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
});

const PORT = process.env.PORT || 4500;
ensureDb()
    .then(() => open(DB_PATH))
    .then(d => {
        db = d;
        app.listen(PORT, () => {
            console.log(`Skoda Reports service running on port ${PORT}`);
        });
    })
    .catch(e => { console.error(e); process.exit(1); });
