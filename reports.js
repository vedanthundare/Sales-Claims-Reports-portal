/**
 * Analytical queries powering the 3 role-aware dashboards + the 9 canonical
 * reports, all against the *real* Skoda schema (dealer / retail_sale /
 * wholesale_sale / scheme / scheme_claim_line / isac_payment_line).
 *
 * A "claim" in the real data = a row in scheme_claim_line (one VIN in one
 * scheme). Its lifecycle is derived, not stored:
 *
 *      calculated_amount > 0
 *      eligibility  = YES / NO / null / <text>
 *      matching row(s) in isac_payment_line (same scheme_code + vin)
 *
 *      status derived:
 *        REJECTED  → eligibility = NO  (or explicit reject text)
 *        APPROVED  → calculated > 0 AND matching ISAC line exists
 *        PENDING   → calculated > 0 AND no ISAC line yet
 *        NIL       → calculated = 0  (row exists but no payout — excluded from most reports)
 */

// -------- filter → WHERE builder --------------------------------------
// Filters allowed:
//   period_yyyymm     '2026-03'
//   zone              India-I / India-II
//   dealer_code       (normalised, e.g. 10296)
//   scheme_code       SKSL2026M03_...
//   scheme_type       DAN / DEMO / SC_INCENTIVE / REGIONAL_BOOSTER / LOYALTY / CORPORATE / EXCHANGE / VOLUME_BONUS / EARLY_BIRD / KODIAQ_BOOSTER
//   scheme_kind       RETAIL / WHOLESALE
//   model_group       Kushaq / Slavia / Kylaq / Kodiaq / Octavia
//   status            APPROVED / PENDING / REJECTED
function buildWhere(filters, scope) {
    const where = [];
    const params = {};
    const allow = {
        period_yyyymm: () => where.push('scl.period_yyyymm = @period_yyyymm'),
        zone:          () => where.push('d.zone = @zone'),
        dealer_code:   () => where.push('scl.dealer_code = @dealer_code'),
        scheme_code:   () => where.push('scl.scheme_code = @scheme_code'),
        scheme_type:   () => where.push('s.scheme_type = @scheme_type'),
        scheme_kind:   () => where.push('s.scheme_kind = @scheme_kind'),
        model_group:   () => where.push('scl.model_group = @model_group')
    };
    Object.keys(filters || {}).forEach(k => {
        if (filters[k] === '' || filters[k] == null) return;
        if (!allow[k]) return;
        if (scope && !scope.includes(k)) return;
        allow[k]();
        params[k] = filters[k];
    });
    return { whereSQL: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

// Base joined-claim CTE used by most reports
const CLAIMS_CTE = `
    WITH paid AS (
        SELECT scheme_code, vin, SUM(amount_payable) AS paid_amount
          FROM isac_payment_line
         WHERE vin IS NOT NULL
         GROUP BY scheme_code, vin
    ),
    joined AS (
        SELECT scl.id,
               scl.scheme_code, scl.vin, scl.dealer_code, scl.dealer_short_name,
               scl.model_code, scl.model_group,
               scl.calculated_amount, scl.eligibility, scl.remarks, scl.period_yyyymm,
               COALESCE(p.paid_amount, 0) AS paid_amount,
               CASE
                    WHEN UPPER(COALESCE(scl.eligibility,'')) = 'NO'      THEN 'REJECTED'
                    WHEN scl.calculated_amount = 0 AND p.paid_amount IS NULL THEN 'NIL'
                    WHEN p.paid_amount IS NOT NULL                        THEN 'APPROVED'
                    ELSE 'PENDING'
               END AS status,
               s.scheme_name, s.scheme_kind, s.scheme_type, s.target_payout
          FROM scheme_claim_line scl
          JOIN scheme  s ON s.scheme_code = scl.scheme_code
     LEFT JOIN dealer  d ON d.dealer_code = scl.dealer_code
     LEFT JOIN paid    p ON p.scheme_code = scl.scheme_code AND p.vin = scl.vin
    )
`;

// ─── Role-aware KPI endpoints ────────────────────────────────────────────
const kpis = {
    async manager(db, filters) {
        const { whereSQL, params } = buildWhere(filters, ['period_yyyymm','zone','scheme_type','scheme_kind','model_group']);
        // Re-alias for the CTE
        const w = whereSQL.replace(/scl\./g,'j.').replace(/^WHERE/, 'WHERE');
        const wOrEmpty = w.replace(/j\.scheme_code/g, 'j.scheme_code')
                          .replace(/j\.dealer_code/g, 'j.dealer_code');
        // Include ONLY rows where a payout was calculated (calculated_amount > 0)
        // OR where an ISAC payment landed. Zero-value lines are eligibility rejects
        // and would swamp the counts otherwise.
        const w2 = w
            ? w + ' AND (j.calculated_amount > 0 OR j.paid_amount > 0)'
            : 'WHERE (j.calculated_amount > 0 OR j.paid_amount > 0)';
        const rows = await db.prepare(`
            ${CLAIMS_CTE}
            SELECT
                COUNT(*)                             AS claim_lines,
                COUNT(DISTINCT j.dealer_code)         AS dealers_active,
                COUNT(DISTINCT j.scheme_code)         AS schemes_active,
                ROUND(SUM(j.calculated_amount))       AS total_claimed,
                ROUND(SUM(j.paid_amount))             AS total_paid,
                ROUND(SUM(j.calculated_amount) - SUM(j.paid_amount)) AS gap,
                ROUND(100.0 * SUM(CASE WHEN j.status='APPROVED' THEN 1 ELSE 0 END) / COUNT(*), 1) AS approval_rate,
                SUM(CASE WHEN j.status='APPROVED' THEN 1 ELSE 0 END) AS approved_count,
                SUM(CASE WHEN j.status='PENDING'  THEN 1 ELSE 0 END) AS pending_count,
                SUM(CASE WHEN j.status='REJECTED' THEN 1 ELSE 0 END) AS rejected_count
              FROM joined j
              LEFT JOIN dealer d ON d.dealer_code = j.dealer_code
              LEFT JOIN scheme s ON s.scheme_code = j.scheme_code
             ${w2}
        `).get(params);
        return rows || {};
    },
    async dealer(db, filters) {
        if (!filters.dealer_code) return null;
        const params = { dealer_code: filters.dealer_code, period: filters.period_yyyymm || '2026-03' };
        const info = await db.prepare(`
            SELECT d.dealer_code, d.dealer_short_name, d.dealer_name, d.zone, d.state, d.rsm,
                   -- targets are seeded per outlet in Book2; match on short-name and
                   -- take the max so the primary + branches share the same target.
                   (SELECT MAX(t2.retail_target)
                      FROM dealer_month_target t2
                      JOIN dealer d2 ON d2.dealer_code = t2.dealer_code
                     WHERE d2.dealer_short_name = d.dealer_short_name
                       AND t2.period_yyyymm = @period) AS retail_target,
                   (SELECT MAX(t2.wholesale_target)
                      FROM dealer_month_target t2
                      JOIN dealer d2 ON d2.dealer_code = t2.dealer_code
                     WHERE d2.dealer_short_name = d.dealer_short_name
                       AND t2.period_yyyymm = @period) AS wholesale_target
              FROM dealer d
             WHERE d.dealer_code = @dealer_code
        `).get(params) || {};

        // aggregate across all outlets sharing this dealer_short_name
        const codesRow = await db.prepare(`
            SELECT dealer_short_name FROM dealer WHERE dealer_code = @dealer_code
        `).get(params);
        const shortName = codesRow ? codesRow.dealer_short_name : null;
        const codeFilter = shortName
            ? `IN (SELECT dealer_code FROM dealer WHERE dealer_short_name = @short)`
            : `= @dealer_code`;
        const p2 = { ...params, short: shortName };

        const retail = Number((await db.prepare(`
            SELECT COUNT(*) AS c FROM retail_sale
             WHERE dealer_code ${codeFilter} AND period_yyyymm = @period
        `).get(p2)).c);
        const ws = Number((await db.prepare(`
            SELECT COUNT(*) AS c FROM wholesale_sale
             WHERE dealer_code ${codeFilter} AND period_yyyymm = @period
        `).get(p2)).c);

        const money = await db.prepare(`
            SELECT
                ROUND(COALESCE(SUM(scl.calculated_amount),0)) AS claimed,
                ROUND(COALESCE((SELECT SUM(ip.amount_payable)
                                  FROM isac_payment_line ip
                                 WHERE ip.dealer_code ${codeFilter}
                                   AND ip.period_yyyymm = @period),0)) AS paid
              FROM scheme_claim_line scl
             WHERE scl.dealer_code ${codeFilter}
               AND scl.period_yyyymm = @period
               AND scl.calculated_amount > 0
        `).get(p2) || {};

        return {
            ...info,
            retail_sold: retail,
            wholesale_taken: ws,
            retail_target: info.retail_target || 0,
            wholesale_target: info.wholesale_target || 0,
            retail_ach_pct: info.retail_target ? Math.round(100 * retail / info.retail_target) : null,
            wholesale_ach_pct: info.wholesale_target ? Math.round(100 * ws / info.wholesale_target) : null,
            claimed: money.claimed || 0,
            paid: money.paid || 0,
            pending: (money.claimed || 0) - (money.paid || 0)
        };
    },
    async finance(db, filters) {
        const { whereSQL, params } = buildWhere(filters, ['period_yyyymm','zone','scheme_type','scheme_kind']);
        const w = whereSQL.replace(/scl\./g,'j.');
        const totals = await db.prepare(`
            ${CLAIMS_CTE}
            SELECT
                ROUND(SUM(j.calculated_amount))              AS total_claimed,
                ROUND(SUM(j.paid_amount))                    AS total_paid,
                ROUND(SUM(j.calculated_amount - j.paid_amount)) AS gap,
                ROUND(100.0 * SUM(j.paid_amount) / NULLIF(SUM(j.calculated_amount),0), 1) AS paid_pct
              FROM joined j
             ${w}
        `).get(params) || {};

        const isacTotals = await db.prepare(`
            SELECT COUNT(*) AS rfa_lines,
                   ROUND(SUM(amount_payable)) AS isac_total,
                   COUNT(DISTINCT scheme_code) AS rfa_count
              FROM isac_payment_line
             WHERE period_yyyymm = COALESCE(@period_yyyymm, period_yyyymm)
        `).get({ period_yyyymm: filters.period_yyyymm || null });

        return { ...totals, ...isacTotals };
    }
};

// ─── Dashboard chart data ─────────────────────────────────────────────────
const charts = {
    async topDealersByPayout(db, filters) {
        const { whereSQL, params } = buildWhere(filters, ['period_yyyymm','zone','scheme_type','scheme_kind']);
        const w = whereSQL.replace(/scl\./g,'j.');
        return await db.prepare(`
            ${CLAIMS_CTE}
            SELECT COALESCE(d.dealer_short_name, d.dealer_name, j.dealer_code) AS dealer,
                   ROUND(SUM(j.calculated_amount)) AS claimed,
                   ROUND(SUM(j.paid_amount))       AS paid
              FROM joined j
         LEFT JOIN dealer d ON d.dealer_code = j.dealer_code
             ${w}
             GROUP BY j.dealer_code
             ORDER BY claimed DESC
             LIMIT 10
        `).all(params);
    },
    async schemeMix(db, filters) {
        const { whereSQL, params } = buildWhere(filters, ['period_yyyymm','zone','model_group']);
        const w = whereSQL.replace(/scl\./g,'j.');
        return await db.prepare(`
            ${CLAIMS_CTE}
            SELECT j.scheme_name AS label,
                   ROUND(SUM(j.calculated_amount)) AS value
              FROM joined j
             ${w}
             GROUP BY j.scheme_code
             ORDER BY value DESC
        `).all(params);
    },
    async zonePayout(db, filters) {
        const { whereSQL, params } = buildWhere(filters, ['period_yyyymm','scheme_type','scheme_kind','model_group']);
        const w = whereSQL.replace(/scl\./g,'j.');
        return await db.prepare(`
            ${CLAIMS_CTE}
            SELECT COALESCE(d.zone,'Unknown') AS zone,
                   ROUND(SUM(j.calculated_amount)) AS claimed,
                   ROUND(SUM(j.paid_amount))       AS paid
              FROM joined j
         LEFT JOIN dealer d ON d.dealer_code = j.dealer_code
             ${w}
             GROUP BY COALESCE(d.zone,'Unknown')
             ORDER BY claimed DESC
        `).all(params);
    },
    async modelMix(db, filters) {
        const { whereSQL, params } = buildWhere(filters, ['period_yyyymm','zone','scheme_type','scheme_kind']);
        const w = whereSQL.replace(/scl\./g,'j.');
        return await db.prepare(`
            ${CLAIMS_CTE}
            SELECT COALESCE(j.model_group,'Other') AS label,
                   ROUND(SUM(j.calculated_amount)) AS value
              FROM joined j
             ${w}
             GROUP BY COALESCE(j.model_group,'Other')
             ORDER BY value DESC
        `).all(params);
    },
    async statusBreakdown(db, filters) {
        const { whereSQL, params } = buildWhere(filters, ['period_yyyymm','zone','scheme_type','scheme_kind']);
        const w = whereSQL.replace(/scl\./g,'j.');
        return await db.prepare(`
            ${CLAIMS_CTE}
            SELECT j.status AS label, COUNT(*) AS count,
                   ROUND(SUM(j.calculated_amount)) AS amount
              FROM joined j
             ${w}
             GROUP BY j.status
        `).all(params);
    },
    async reconciliation(db, filters) {
        // If dealer_code is supplied, aggregate across all outlets of the same
        // dealer_short_name (BRITE has 6+ codes; showing one gives wrong totals).
        let dealerCodes = null;
        if (filters.dealer_code) {
            const row = await db.prepare('SELECT dealer_short_name FROM dealer WHERE dealer_code = ?').get(filters.dealer_code);
            if (row && row.dealer_short_name) {
                dealerCodes = (await db.prepare('SELECT dealer_code FROM dealer WHERE dealer_short_name = ?')
                    .all(row.dealer_short_name)).map(r => r.dealer_code);
            }
        }
        const filters2 = { ...filters };
        delete filters2.dealer_code;
        const { whereSQL, params } = buildWhere(filters2, ['period_yyyymm','zone','scheme_kind','scheme_type']);
        let w = whereSQL.replace(/scl\./g,'j.');
        if (dealerCodes && dealerCodes.length) {
            const placeholders = dealerCodes.map((_, i) => `@dc${i}`).join(',');
            dealerCodes.forEach((c, i) => { params[`dc${i}`] = c; });
            w = w ? `${w} AND j.dealer_code IN (${placeholders})`
                  : `WHERE j.dealer_code IN (${placeholders})`;
        }
        return await db.prepare(`
            ${CLAIMS_CTE}
            SELECT j.scheme_code, j.scheme_name,
                   ROUND(SUM(j.calculated_amount)) AS claimed,
                   ROUND(SUM(j.paid_amount))       AS paid,
                   ROUND(SUM(j.calculated_amount - j.paid_amount)) AS gap
              FROM joined j
             ${w}
             GROUP BY j.scheme_code, j.scheme_name
            HAVING claimed > 0 OR paid > 0
             ORDER BY claimed DESC
        `).all(params);
    }
};

// ═════════════════════════════════════════════════════════════════════════
// 9 canonical reports rewritten for the real schema
// ═════════════════════════════════════════════════════════════════════════
const reports = {

    // 1. Claims Efficiency — dealer/scheme/period efficiency
    claims_efficiency: {
        meta: {
            id: 'claims_efficiency',
            title: '1. Claims Efficiency',
            description: 'Ratio of claim value raised vs actually paid via ISAC, per dealer / scheme / period.',
            columns: [
                { key: 'group_label',      label: 'Group',                 fmt: 'text' },
                { key: 'lines',            label: 'Claim Lines',           fmt: 'int' },
                { key: 'approved',         label: 'Approved (Paid)',       fmt: 'int' },
                { key: 'claimed_amount',   label: 'Claimed (INR)',         fmt: 'inr' },
                { key: 'paid_amount',      label: 'Paid via ISAC (INR)',   fmt: 'inr' },
                { key: 'approval_rate',    label: 'Payout %',              fmt: 'pct' },
                { key: 'payout_per_line',  label: 'Paid / Line (INR)',     fmt: 'inr' },
                { key: 'efficiency_flag',  label: 'Efficiency',            fmt: 'badge' }
            ]
        },
        filters: ['period_yyyymm','zone','dealer_code','scheme_type','scheme_kind','group_by'],
        async run(db, p) {
            const groupBy = (p.group_by || 'dealer');
            const groupExpr = groupBy === 'scheme' ? 'j.scheme_name'
                            : groupBy === 'period' ? 'j.period_yyyymm'
                            : 'COALESCE(d.dealer_short_name, d.dealer_name, j.dealer_code)';
            const { whereSQL, params } = buildWhere(p, ['period_yyyymm','zone','dealer_code','scheme_type','scheme_kind']);
            const w = whereSQL.replace(/scl\./g,'j.');
            const sql = `
                ${CLAIMS_CTE}
                SELECT ${groupExpr} AS group_label,
                       COUNT(*)                                                       AS lines,
                       SUM(CASE WHEN j.status='APPROVED' THEN 1 ELSE 0 END)             AS approved,
                       ROUND(SUM(j.calculated_amount))                                  AS claimed_amount,
                       ROUND(SUM(j.paid_amount))                                        AS paid_amount,
                       ROUND(100.0 * SUM(CASE WHEN j.status='APPROVED' THEN 1 ELSE 0 END) / COUNT(*), 1) AS approval_rate,
                       ROUND(SUM(j.paid_amount) * 1.0 / COUNT(*))                       AS payout_per_line
                  FROM joined j
             LEFT JOIN dealer d ON d.dealer_code = j.dealer_code
                 ${w}
                 GROUP BY ${groupExpr}
                 ORDER BY claimed_amount DESC
                 LIMIT 200
            `;
            const rows = (await db.prepare(sql).all(params)).map(r => ({
                ...r,
                efficiency_flag: r.approval_rate >= 80 ? 'HIGH'
                               : r.approval_rate >= 50 ? 'MEDIUM'
                               : 'LOW (review)'
            }));
            return { rows, summary: {
                total_lines:  rows.reduce((s,r)=>s+r.lines,0),
                total_paid:   rows.reduce((s,r)=>s+(r.paid_amount||0),0),
                low_groups:   rows.filter(r => r.efficiency_flag.startsWith('LOW')).length
            }};
        }
    },

    // 2. Dealer Risk Profiling — dealers with low payout rate / high rejection
    dealer_risk: {
        meta: {
            id: 'dealer_risk',
            title: '2. Dealer Risk Profile',
            description: 'Dealers classified LOW / MEDIUM / HIGH risk by their share of unpaid / rejected claim lines.',
            columns: [
                { key: 'dealer_code',   label: 'Dealer Code',   fmt: 'text' },
                { key: 'dealer_name',   label: 'Dealer',        fmt: 'text' },
                { key: 'zone',          label: 'Zone',          fmt: 'text' },
                { key: 'total_lines',   label: 'Claim Lines',   fmt: 'int' },
                { key: 'rejection_pct', label: 'Rejection %',   fmt: 'pct' },
                { key: 'pending_pct',   label: 'Pending %',     fmt: 'pct' },
                { key: 'gap_amount',    label: 'Unpaid (INR)',  fmt: 'inr' },
                { key: 'risk_band',     label: 'Risk',          fmt: 'badge' }
            ]
        },
        filters: ['period_yyyymm','zone','scheme_type','scheme_kind'],
        async run(db, p) {
            const { whereSQL, params } = buildWhere(p, ['period_yyyymm','zone','scheme_type','scheme_kind']);
            const w = whereSQL.replace(/scl\./g,'j.');
            const sql = `
                ${CLAIMS_CTE}
                SELECT j.dealer_code,
                       COALESCE(d.dealer_short_name, d.dealer_name, j.dealer_code) AS dealer_name,
                       COALESCE(d.zone,'Unknown') AS zone,
                       COUNT(*) AS total_lines,
                       ROUND(100.0 * SUM(CASE WHEN j.status='REJECTED' THEN 1 ELSE 0 END) / COUNT(*), 1) AS rejection_pct,
                       ROUND(100.0 * SUM(CASE WHEN j.status='PENDING'  THEN 1 ELSE 0 END) / COUNT(*), 1) AS pending_pct,
                       ROUND(SUM(j.calculated_amount - j.paid_amount)) AS gap_amount
                  FROM joined j
             LEFT JOIN dealer d ON d.dealer_code = j.dealer_code
                 ${w}
                 GROUP BY j.dealer_code
                HAVING total_lines >= 5
                 ORDER BY gap_amount DESC
                 LIMIT 200
            `;
            const rows = (await db.prepare(sql).all(params)).map(r => ({
                ...r,
                risk_band: (r.rejection_pct >= 40 || r.pending_pct >= 70) ? 'HIGH'
                         : (r.rejection_pct >= 15 || r.pending_pct >= 40) ? 'MEDIUM'
                         : 'LOW'
            }));
            return { rows, summary: {
                high: rows.filter(r => r.risk_band === 'HIGH').length,
                medium: rows.filter(r => r.risk_band === 'MEDIUM').length,
                low: rows.filter(r => r.risk_band === 'LOW').length
            }};
        }
    },

    // 3. Claim Aging vs Payout Leakage — pending age & unpaid value at risk
    aging_leakage: {
        meta: {
            id: 'aging_leakage',
            title: '3. Claim Aging & Payout Leakage',
            description: 'How long claims stay unpaid after being calculated; realised leakage in fully-rejected schemes.',
            columns: [
                { key: 'aging_bucket',   label: 'Bucket',              fmt: 'text' },
                { key: 'lines',          label: 'Claim Lines',         fmt: 'int' },
                { key: 'amount_at_risk', label: 'Amount At Risk (INR)',fmt: 'inr' },
                { key: 'rejected_lines', label: 'Rejected Lines',      fmt: 'int' },
                { key: 'leakage_amount', label: 'Realised Leakage (INR)', fmt: 'inr' }
            ]
        },
        filters: ['period_yyyymm','zone','dealer_code','scheme_type','scheme_kind'],
        async run(db, p) {
            const { whereSQL, params } = buildWhere(p, ['period_yyyymm','zone','dealer_code','scheme_type','scheme_kind']);
            const w = whereSQL.replace(/scl\./g,'j.');
            // Fetch per-line aged rows, then bucket in JS (portable across SQLite / Postgres).
            const sql = `
                ${CLAIMS_CTE}
                SELECT COALESCE(rs.delivery_date, ws.ws_date, j.period_yyyymm || '-15') AS anchor_date,
                       j.status, j.calculated_amount
                  FROM joined j
             LEFT JOIN retail_sale rs    ON rs.vin = j.vin
             LEFT JOIN wholesale_sale ws ON ws.chassis = j.vin
                 ${w ? w + ' AND' : 'WHERE'} j.calculated_amount > 0
            `;
            const raw = await db.prepare(sql).all(params);
            const REF = new Date('2026-06-30').getTime();
            const buckets = {
                '0-30 days':    { lines: 0, amount_at_risk: 0, rejected_lines: 0, leakage_amount: 0 },
                '31-60 days':   { lines: 0, amount_at_risk: 0, rejected_lines: 0, leakage_amount: 0 },
                '61-90 days':   { lines: 0, amount_at_risk: 0, rejected_lines: 0, leakage_amount: 0 },
                '91-120 days':  { lines: 0, amount_at_risk: 0, rejected_lines: 0, leakage_amount: 0 },
                '120+ days':    { lines: 0, amount_at_risk: 0, rejected_lines: 0, leakage_amount: 0 }
            };
            raw.forEach(r => {
                const anchor = r.anchor_date && String(r.anchor_date).match(/^\d{4}-\d{2}-\d{2}/)
                    ? new Date(r.anchor_date).getTime() : REF - 999 * 86400000;
                const ageDays = Math.floor((REF - anchor) / 86400000);
                const key = ageDays <= 30 ? '0-30 days'
                          : ageDays <= 60 ? '31-60 days'
                          : ageDays <= 90 ? '61-90 days'
                          : ageDays <= 120 ? '91-120 days'
                          : '120+ days';
                const b = buckets[key];
                b.lines++;
                const amt = Number(r.calculated_amount) || 0;
                if (r.status === 'PENDING' || r.status === 'REJECTED') b.amount_at_risk += amt;
                if (r.status === 'REJECTED') { b.rejected_lines++; b.leakage_amount += amt; }
            });
            const rows = Object.entries(buckets).map(([aging_bucket, v]) => ({
                aging_bucket,
                lines: v.lines,
                amount_at_risk: Math.round(v.amount_at_risk),
                rejected_lines: v.rejected_lines,
                leakage_amount: Math.round(v.leakage_amount)
            }));
            return { rows, summary: {
                total_at_risk: rows.reduce((s,r)=>s+(r.amount_at_risk||0),0),
                total_leakage: rows.reduce((s,r)=>s+(r.leakage_amount||0),0)
            }};
        }
    },

    // 4. Scheme Effectiveness & Zone-wise Dashboard
    scheme_effectiveness: {
        meta: {
            id: 'scheme_effectiveness',
            title: '4. Scheme Effectiveness & Zone Dashboard',
            description: 'Scheme-wise volume vs payout, zone-wise comparison across DAN / Demo / Regional Booster / Loyalty / Corporate / Exchange / Volume Bonus.',
            columns: [
                { key: 'scheme_name',    label: 'Scheme',              fmt: 'text' },
                { key: 'scheme_type',    label: 'Type',                fmt: 'text' },
                { key: 'zone',           label: 'Zone',                fmt: 'text' },
                { key: 'lines',          label: 'Claim Lines',         fmt: 'int' },
                { key: 'approved',       label: 'Approved',            fmt: 'int' },
                { key: 'paid_amount',    label: 'Paid (INR)',          fmt: 'inr' },
                { key: 'target_payout',  label: 'Target (INR)',        fmt: 'inr' },
                { key: 'achievement_pct',label: 'Achievement %',       fmt: 'pct' },
                { key: 'roi_score',      label: 'Impact',              fmt: 'badge' }
            ]
        },
        filters: ['period_yyyymm','zone','scheme_type','scheme_kind'],
        async run(db, p) {
            const { whereSQL, params } = buildWhere(p, ['period_yyyymm','zone','scheme_type','scheme_kind']);
            const w = whereSQL.replace(/scl\./g,'j.');
            const sql = `
                ${CLAIMS_CTE}
                SELECT j.scheme_name, j.scheme_type,
                       COALESCE(d.zone,'Unknown') AS zone,
                       COUNT(*) AS lines,
                       SUM(CASE WHEN j.status='APPROVED' THEN 1 ELSE 0 END) AS approved,
                       ROUND(SUM(j.paid_amount)) AS paid_amount,
                       j.target_payout,
                       ROUND(100.0 * SUM(j.paid_amount) / NULLIF(j.target_payout,0), 1) AS achievement_pct
                  FROM joined j
             LEFT JOIN dealer d ON d.dealer_code = j.dealer_code
                 ${w}
                 GROUP BY j.scheme_code, COALESCE(d.zone,'Unknown')
                 ORDER BY j.scheme_name, zone
            `;
            const rows = (await db.prepare(sql).all(params)).map(r => ({
                ...r,
                roi_score: r.achievement_pct >= 80 ? 'STRONG'
                         : r.achievement_pct >= 50 ? 'AVERAGE'
                         : 'UNDER'
            }));
            return { rows, summary: {
                schemes: new Set(rows.map(r=>r.scheme_name)).size,
                avg_achievement: rows.length ? Math.round(rows.reduce((s,r)=>s+(r.achievement_pct||0),0)/rows.length) : 0
            }};
        }
    },

    // 5. Forecast (very simple — monthly avg × 6 months)
    forecast: {
        meta: {
            id: 'forecast',
            title: '5. Provision & Payout Forecast',
            description: 'Projected next-6-month payout based on the observed Mar-26 run-rate. Provision = forecast × 1.10.',
            columns: [
                { key: 'period',             label: 'Period',                fmt: 'text' },
                { key: 'kind',               label: 'Scheme Kind',           fmt: 'text' },
                { key: 'historical_avg',     label: 'Baseline / mo (INR)',   fmt: 'inr' },
                { key: 'forecast_amount',    label: 'Forecast Payout (INR)', fmt: 'inr' },
                { key: 'provision_required', label: 'Provision Reqd (INR)',  fmt: 'inr' },
                { key: 'adequacy_flag',      label: 'Adequacy',              fmt: 'badge' }
            ]
        },
        filters: ['zone','scheme_kind'],
        async run(db, p) {
            const { whereSQL, params } = buildWhere(p, ['zone','scheme_kind']);
            const w = whereSQL.replace(/scl\./g,'j.');
            const rows = await db.prepare(`
                ${CLAIMS_CTE}
                SELECT j.scheme_kind AS kind,
                       ROUND(SUM(j.paid_amount)) AS payout
                  FROM joined j
             LEFT JOIN dealer d ON d.dealer_code = j.dealer_code
                 ${w}
                 GROUP BY j.scheme_kind
            `).all(params);
            const out = [];
            const startMonth = new Date('2026-04-01');
            rows.forEach(base => {
                const avg = base.payout || 0;
                for (let i = 0; i < 6; i++) {
                    const d = new Date(startMonth); d.setMonth(d.getMonth() + i);
                    const period = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
                    const forecast = Math.round(avg * (1 + 0.02 * i)); // 2% growth
                    out.push({
                        period, kind: base.kind || 'MIXED',
                        historical_avg: avg,
                        forecast_amount: forecast,
                        provision_required: Math.round(forecast * 1.10),
                        adequacy_flag: i < 2 ? 'ADEQUATE' : (i < 4 ? 'WATCH' : 'INCREASE')
                    });
                }
            });
            return { rows: out, summary: {
                next_quarter_total: out.filter((_,i)=>i%6<3).reduce((s,r)=>s+r.forecast_amount,0)
            }};
        }
    },

    // 6. Documentation Quality Index — proxied via calc-vs-paid completeness
    dqi: {
        meta: {
            id: 'dqi',
            title: '6. Documentation Quality Index',
            description: 'Dealer-level documentation quality proxy: % of eligible claim lines that actually reach ISAC payment.',
            columns: [
                { key: 'dealer_code',       label: 'Dealer Code',           fmt: 'text' },
                { key: 'dealer_name',       label: 'Dealer',                fmt: 'text' },
                { key: 'lines_evaluated',   label: 'Lines',                 fmt: 'int' },
                { key: 'paid_pct',          label: 'Paid %',                fmt: 'pct' },
                { key: 'top_scheme',        label: 'Top Scheme',            fmt: 'text' },
                { key: 'tier',              label: 'Tier',                  fmt: 'badge' }
            ]
        },
        filters: ['period_yyyymm','zone','dealer_code','scheme_type'],
        async run(db, p) {
            const { whereSQL, params } = buildWhere(p, ['period_yyyymm','zone','dealer_code','scheme_type']);
            const w = whereSQL.replace(/scl\./g,'j.');
            const rows = (await db.prepare(`
                ${CLAIMS_CTE}
                SELECT j.dealer_code,
                       COALESCE(d.dealer_short_name, d.dealer_name, j.dealer_code) AS dealer_name,
                       COUNT(*) AS lines_evaluated,
                       ROUND(100.0 * SUM(CASE WHEN j.status='APPROVED' THEN 1 ELSE 0 END) / COUNT(*), 1) AS paid_pct,
                       (SELECT scheme_name FROM (
                           SELECT j2.scheme_name, SUM(j2.paid_amount) AS s
                             FROM joined j2 WHERE j2.dealer_code = j.dealer_code
                             GROUP BY j2.scheme_name ORDER BY s DESC LIMIT 1)) AS top_scheme
                  FROM joined j
             LEFT JOIN dealer d ON d.dealer_code = j.dealer_code
                 ${w}
                 GROUP BY j.dealer_code
                HAVING lines_evaluated >= 5
                 ORDER BY paid_pct DESC
                 LIMIT 200
            `).all(params)).map(r => ({
                ...r,
                tier: r.paid_pct >= 85 ? 'GOLD'
                    : r.paid_pct >= 60 ? 'SILVER'
                    : r.paid_pct >= 30 ? 'BRONZE'
                    : 'NEEDS COACHING'
            }));
            return { rows, summary: {
                gold: rows.filter(r=>r.tier==='GOLD').length,
                coach: rows.filter(r=>r.tier==='NEEDS COACHING').length
            }};
        }
    },

    // 7. Dealer Lifecycle & FNF Risk — proxied via zero-activity + unpaid exposure
    fnf_tracker: {
        meta: {
            id: 'fnf_tracker',
            title: '7. Dealer Exposure Tracker',
            description: 'Dealers with unpaid claim lines and their exposure; flag those with zero retail/wholesale activity as at-risk.',
            columns: [
                { key: 'dealer_code',    label: 'Dealer Code',              fmt: 'text' },
                { key: 'dealer_name',    label: 'Dealer',                   fmt: 'text' },
                { key: 'activity_flag',  label: 'Activity',                 fmt: 'badge' },
                { key: 'open_lines',     label: 'Open (Pending) Lines',     fmt: 'int' },
                { key: 'open_exposure',  label: 'Open Exposure (INR)',      fmt: 'inr' },
                { key: 'rejected_lines', label: 'Rejected Lines',           fmt: 'int' },
                { key: 'paid_ytd',       label: 'Paid this Period (INR)',   fmt: 'inr' }
            ]
        },
        filters: ['zone'],
        async run(db, p) {
            const { whereSQL, params } = buildWhere(p, ['zone']);
            const w = whereSQL.replace(/scl\./g,'j.');
            const rows = (await db.prepare(`
                ${CLAIMS_CTE}
                SELECT j.dealer_code,
                       COALESCE(d.dealer_short_name, d.dealer_name, j.dealer_code) AS dealer_name,
                       COALESCE((SELECT COUNT(*) FROM retail_sale WHERE dealer_code = j.dealer_code AND period_yyyymm='2026-03'),0) +
                       COALESCE((SELECT COUNT(*) FROM wholesale_sale WHERE dealer_code = j.dealer_code AND period_yyyymm='2026-03'),0) AS activity,
                       SUM(CASE WHEN j.status='PENDING'  THEN 1 ELSE 0 END) AS open_lines,
                       ROUND(SUM(CASE WHEN j.status='PENDING'  THEN j.calculated_amount ELSE 0 END)) AS open_exposure,
                       SUM(CASE WHEN j.status='REJECTED' THEN 1 ELSE 0 END) AS rejected_lines,
                       ROUND(SUM(j.paid_amount)) AS paid_ytd
                  FROM joined j
             LEFT JOIN dealer d ON d.dealer_code = j.dealer_code
                 ${w}
                 GROUP BY j.dealer_code
                HAVING open_exposure > 0 OR activity = 0
                 ORDER BY open_exposure DESC
                 LIMIT 200
            `).all(params)).map(r => ({
                ...r,
                activity_flag: r.activity === 0 ? 'DORMANT'
                             : r.activity < 5   ? 'LOW ACTIVITY'
                             : 'ACTIVE'
            }));
            return { rows, summary: {
                dormant: rows.filter(r => r.activity_flag === 'DORMANT').length,
                total_exposure: rows.reduce((s,r)=>s+(r.open_exposure||0),0)
            }};
        }
    },

    // 8. Corporate & Exchange Dispute Heatmap — zone × scheme-type unpaid heatmap
    dispute_heatmap: {
        meta: {
            id: 'dispute_heatmap',
            title: '8. Corporate & Exchange Dispute Heatmap',
            description: 'Zone × scheme-type matrix of unpaid Corporate/Exchange claim lines with root-cause breakdown from Remarks.',
            viz: 'heatmap',
            columns: [
                { key: 'dealer_name',       label: 'Dealer',           fmt: 'text' },
                { key: 'zone',              label: 'Zone',             fmt: 'text' },
                { key: 'scheme_type',       label: 'Scheme Type',      fmt: 'text' },
                { key: 'unpaid_lines',      label: 'Unpaid Lines',     fmt: 'int' },
                { key: 'unpaid_amount',     label: 'Unpaid (INR)',     fmt: 'inr' },
                { key: 'top_remark',        label: 'Top Remark',       fmt: 'text' },
                { key: 'heat',              label: 'Heat',             fmt: 'badge' }
            ]
        },
        filters: ['period_yyyymm','zone','scheme_type'],
        async run(db, p) {
            const filters = { ...p };
            if (!filters.scheme_type) filters._auto = 1;
            const { whereSQL, params } = buildWhere(filters, ['period_yyyymm','zone','scheme_type']);
            const auto = filters._auto ? (whereSQL ? " AND s.scheme_type IN ('CORPORATE','EXCHANGE')" : "WHERE s.scheme_type IN ('CORPORATE','EXCHANGE')") : '';
            const w = (whereSQL + auto).replace(/scl\./g,'j.');

            const rows = (await db.prepare(`
                ${CLAIMS_CTE}
                SELECT COALESCE(d.dealer_short_name, d.dealer_name, j.dealer_code) AS dealer_name,
                       COALESCE(d.zone,'Unknown') AS zone,
                       j.scheme_type,
                       SUM(CASE WHEN j.status IN ('PENDING','REJECTED') THEN 1 ELSE 0 END) AS unpaid_lines,
                       ROUND(SUM(CASE WHEN j.status IN ('PENDING','REJECTED') THEN j.calculated_amount ELSE 0 END)) AS unpaid_amount,
                       (SELECT j2.remarks FROM joined j2
                          WHERE j2.dealer_code = j.dealer_code
                            AND j2.scheme_type = j.scheme_type
                            AND j2.remarks IS NOT NULL AND j2.remarks <> ''
                          GROUP BY j2.remarks ORDER BY COUNT(*) DESC LIMIT 1) AS top_remark
                  FROM joined j
             LEFT JOIN dealer d ON d.dealer_code = j.dealer_code
             LEFT JOIN scheme s ON s.scheme_code = j.scheme_code
                 ${w}
                 GROUP BY j.dealer_code, j.scheme_type
                HAVING unpaid_lines > 0
                 ORDER BY unpaid_amount DESC
                 LIMIT 100
            `).all(params)).map(r => ({
                ...r,
                heat: r.unpaid_lines >= 20 ? 'HOT' : r.unpaid_lines >= 8 ? 'WARM' : 'COOL'
            }));

            const matrixRows = await db.prepare(`
                ${CLAIMS_CTE}
                SELECT COALESCE(d.zone,'Unknown') AS zone,
                       j.scheme_type,
                       SUM(CASE WHEN j.status IN ('PENDING','REJECTED') THEN 1 ELSE 0 END) AS disputes,
                       ROUND(SUM(CASE WHEN j.status IN ('PENDING','REJECTED') THEN j.calculated_amount ELSE 0 END)) AS unpaid_amount
                  FROM joined j
             LEFT JOIN dealer d ON d.dealer_code = j.dealer_code
             LEFT JOIN scheme s ON s.scheme_code = j.scheme_code
                 ${w}
                 GROUP BY COALESCE(d.zone,'Unknown'), j.scheme_type
                HAVING disputes > 0
            `).all(params);

            const rootCauses = await db.prepare(`
                ${CLAIMS_CTE}
                SELECT COALESCE(NULLIF(j.remarks,''),'(none)') AS cause,
                       COUNT(*) AS cnt
                  FROM joined j
             LEFT JOIN dealer d ON d.dealer_code = j.dealer_code
             LEFT JOIN scheme s ON s.scheme_code = j.scheme_code
                 ${w ? w + ' AND' : 'WHERE'} j.status IN ('PENDING','REJECTED')
                 GROUP BY cause
                 ORDER BY cnt DESC
                 LIMIT 8
            `).all(params);

            const zones = [...new Set(matrixRows.map(r => r.zone))].sort();
            const schemeTypes = [...new Set(matrixRows.map(r => r.scheme_type))].sort();
            const cells = {};
            let maxDisputes = 0;
            matrixRows.forEach(r => {
                cells[`${r.zone}::${r.scheme_type}`] = {
                    disputes: r.disputes,
                    unpaid_amount: r.unpaid_amount
                };
                if (r.disputes > maxDisputes) maxDisputes = r.disputes;
            });

            return {
                rows,
                summary: {
                    hot_dealers: rows.filter(r => r.heat === 'HOT').length,
                    total_disputes: rows.reduce((s,r)=>s+(r.unpaid_lines||0),0),
                    zones_affected: zones.length
                },
                heatmap: { regions: zones, scheme_types: schemeTypes, cells, max: maxDisputes },
                root_causes: rootCauses
            };
        }
    },

    // 9. Sales Enablement Impact — DAN support band vs downstream scheme success
    sales_enablement: {
        meta: {
            id: 'sales_enablement',
            title: '9. Sales Enablement Impact (DAN → Downstream)',
            description: 'Group dealers by their DAN Support payout band and compare their downstream (non-DAN) scheme payout rates.',
            columns: [
                { key: 'support_band',   label: 'DAN Support Band',     fmt: 'text' },
                { key: 'dealer_count',   label: 'Dealers',              fmt: 'int' },
                { key: 'lines',          label: 'Downstream Lines',     fmt: 'int' },
                { key: 'success_rate',   label: 'Payout %',             fmt: 'pct' },
                { key: 'payout_per_line',label: 'Paid / Line (INR)',    fmt: 'inr' },
                { key: 'impact_signal',  label: 'Impact',               fmt: 'badge' }
            ]
        },
        filters: ['zone'],
        async run(db, p) {
            const { whereSQL, params } = buildWhere(p, ['zone']);
            const w = whereSQL.replace(/scl\./g,'j.');
            const sql = `
                ${CLAIMS_CTE},
                dan_paid AS (
                    SELECT dealer_code, SUM(amount_payable) AS dan_amount
                      FROM isac_payment_line
                     WHERE scheme_code = 'SKSL2026M03_555'
                     GROUP BY dealer_code
                ),
                banded AS (
                    SELECT j.*,
                           CASE
                               WHEN COALESCE(dp.dan_amount,0) = 0        THEN 'No DAN'
                               WHEN dp.dan_amount < 100000               THEN '< 1 Lakh'
                               WHEN dp.dan_amount < 300000               THEN '1-3 Lakh'
                               WHEN dp.dan_amount < 500000               THEN '3-5 Lakh'
                               ELSE '5 Lakh+'
                           END AS support_band
                      FROM joined j
                 LEFT JOIN dan_paid dp ON dp.dealer_code = j.dealer_code
                 LEFT JOIN dealer d    ON d.dealer_code  = j.dealer_code
                     ${w ? w + ' AND' : 'WHERE'} j.scheme_code <> 'SKSL2026M03_555'
                )
                SELECT support_band,
                       COUNT(DISTINCT dealer_code) AS dealer_count,
                       COUNT(*)                    AS lines,
                       ROUND(100.0 * SUM(CASE WHEN status='APPROVED' THEN 1 ELSE 0 END) / COUNT(*), 1) AS success_rate,
                       ROUND(SUM(paid_amount) * 1.0 / COUNT(*)) AS payout_per_line
                  FROM banded
                 GROUP BY support_band
                 ORDER BY CASE support_band
                            WHEN 'No DAN' THEN 0 WHEN '< 1 Lakh' THEN 1
                            WHEN '1-3 Lakh' THEN 2 WHEN '3-5 Lakh' THEN 3 ELSE 4 END
            `;
            const rows = await db.prepare(sql).all(params);
            const baseline = rows.find(r => r.support_band === 'No DAN');
            const withImpact = rows.map(r => ({
                ...r,
                impact_signal: !baseline || baseline === r ? '—' :
                    (r.success_rate - baseline.success_rate) > 8 ? `STRONG +${(r.success_rate - baseline.success_rate).toFixed(1)}pp`
                    : (r.success_rate - baseline.success_rate) > 3 ? `MODERATE +${(r.success_rate - baseline.success_rate).toFixed(1)}pp`
                    : (r.success_rate - baseline.success_rate) < -3 ? 'NEGATIVE'
                    : 'NEUTRAL'
            }));
            return { rows: withImpact, summary: { bands: withImpact.length } };
        }
    }
};

module.exports = { reports, buildWhere, kpis, charts };
