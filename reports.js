/**
 * SQL builders for the 9 analytical / MIS reports.
 *
 * Each report exposes:
 *   - meta: title, description, columns
 *   - filters: declarative filter spec consumed by the UI
 *   - run(db, params): returns { rows, summary }
 *
 * Filters supported across reports (subset per report):
 *   from              ISO date  (claim_raised_on >= from)
 *   to                ISO date  (claim_raised_on <= to)
 *   region            string
 *   zone              string
 *   dealer_code       string
 *   scheme_type       CORPORATE / EXCHANGE / LOYALTY / RETAIL_TACTICAL / BASE
 *   scheme_code       string
 *   payout_kind       BASE / TACTICAL
 *   risk_band         LOW / MEDIUM / HIGH
 *   fnf_status        ACTIVE / NEARING_EXIT / EXITED
 *   status            APPROVED / PENDING / REJECTED / TIME_BARRED / DISPUTED
 */

// Build a parameterised WHERE clause from a filter object
function buildWhere(filters, scope) {
    const where = [];
    const params = {};
    const allow = {
        from:        () => { where.push('c.claim_raised_on >= @from'); },
        to:          () => { where.push('c.claim_raised_on <= @to'); },
        region:      () => { where.push('d.region = @region'); },
        zone:        () => { where.push('d.zone   = @zone'); },
        dealer_code: () => { where.push('c.dealer_code = @dealer_code'); },
        scheme_type: () => { where.push('s.scheme_type = @scheme_type'); },
        scheme_code: () => { where.push('c.scheme_code = @scheme_code'); },
        payout_kind: () => { where.push('c.payout_kind = @payout_kind'); },
        risk_band:   () => { where.push('d.risk_band = @risk_band'); },
        fnf_status:  () => { where.push('d.fnf_status = @fnf_status'); },
        status:      () => { where.push('c.status = @status'); }
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

const reports = {

    // ===================================================================
    // 1. Claims Efficiency Report
    // ===================================================================
    claims_efficiency: {
        meta: {
            id: 'claims_efficiency',
            title: '1. Claims Efficiency Report',
            description: 'Ratio of claims raised vs payout value, dealer / scheme / period. Flags low-efficiency dealers & schemes.',
            columns: [
                { key: 'group_label',      label: 'Group',                fmt: 'text' },
                { key: 'claims_raised',    label: 'Claims Raised',        fmt: 'int' },
                { key: 'claims_approved',  label: 'Claims Approved',      fmt: 'int' },
                { key: 'claimed_amount',   label: 'Claimed (INR)',        fmt: 'inr' },
                { key: 'approved_amount',  label: 'Approved Payout (INR)',fmt: 'inr' },
                { key: 'approval_rate',    label: 'Approval %',           fmt: 'pct' },
                { key: 'payout_per_claim', label: 'Payout / Claim (INR)', fmt: 'inr' },
                { key: 'efficiency_flag',  label: 'Efficiency',           fmt: 'badge' }
            ]
        },
        filters: ['from', 'to', 'region', 'zone', 'dealer_code', 'scheme_type', 'payout_kind', 'group_by'],
        run(db, p) {
            const groupBy = (p.group_by || 'dealer'); // dealer | scheme | period
            const groupExpr = groupBy === 'scheme' ? "s.scheme_name"
                            : groupBy === 'period' ? "c.period_yyyymm"
                            : "d.dealer_name";
            const { whereSQL, params } = buildWhere(p, ['from','to','region','zone','dealer_code','scheme_type','payout_kind']);
            const sql = `
                SELECT ${groupExpr} AS group_label,
                       COUNT(*) AS claims_raised,
                       SUM(CASE WHEN c.status='APPROVED' THEN 1 ELSE 0 END) AS claims_approved,
                       ROUND(SUM(c.claimed_amount), 2)   AS claimed_amount,
                       ROUND(SUM(c.approved_amount), 2)  AS approved_amount,
                       ROUND(100.0 * SUM(CASE WHEN c.status='APPROVED' THEN 1 ELSE 0 END) / COUNT(*), 2) AS approval_rate,
                       ROUND(SUM(c.approved_amount) * 1.0 / COUNT(*), 2) AS payout_per_claim
                  FROM claims c
                  JOIN dealers d ON d.dealer_code = c.dealer_code
                  JOIN schemes s ON s.scheme_code = c.scheme_code
                  ${whereSQL}
                 GROUP BY ${groupExpr}
                 ORDER BY claimed_amount DESC
            `;
            const rows = db.prepare(sql).all(params).map(r => ({
                ...r,
                efficiency_flag: r.approval_rate >= 80 && r.payout_per_claim >= 12000 ? 'HIGH'
                               : r.approval_rate >= 60 ? 'MEDIUM'
                               : 'LOW (review)'
            }));
            return { rows, summary: {
                total_claims:    rows.reduce((s,r)=>s+r.claims_raised,0),
                total_payout:    rows.reduce((s,r)=>s+(r.approved_amount||0),0),
                low_eff_groups:  rows.filter(r => r.efficiency_flag.startsWith('LOW')).length
            }};
        }
    },

    // ===================================================================
    // 2. Dealer Behavior & Risk Profiling
    // ===================================================================
    dealer_risk: {
        meta: {
            id: 'dealer_risk',
            title: '2. Dealer Behavior & Risk Profiling Report',
            description: 'Dealers categorised LOW / MEDIUM / HIGH risk by rejection %, time-barred cases, documentation deviations.',
            columns: [
                { key: 'dealer_code', label: 'Dealer Code', fmt: 'text' },
                { key: 'dealer_name', label: 'Dealer',      fmt: 'text' },
                { key: 'region',      label: 'Region',      fmt: 'text' },
                { key: 'total_claims',label: 'Total Claims',fmt: 'int' },
                { key: 'rejection_pct',     label: 'Rejection %',     fmt: 'pct' },
                { key: 'time_barred_count', label: 'Time-Barred',     fmt: 'int' },
                { key: 'avg_doc_score',     label: 'Avg Doc Score',   fmt: 'num' },
                { key: 'repeat_rejections', label: 'Repeat Rejections',fmt: 'int' },
                { key: 'risk_band',         label: 'Risk Band',       fmt: 'badge' }
            ]
        },
        filters: ['from','to','region','zone','risk_band'],
        run(db, p) {
            const { whereSQL, params } = buildWhere(p, ['from','to','region','zone','risk_band']);
            const sql = `
                SELECT d.dealer_code,
                       d.dealer_name,
                       d.region,
                       COUNT(c.claim_id)                                                               AS total_claims,
                       ROUND(100.0 * SUM(CASE WHEN c.status='REJECTED' THEN 1 ELSE 0 END) /
                                       NULLIF(COUNT(c.claim_id),0), 2)                                AS rejection_pct,
                       SUM(CASE WHEN c.status='TIME_BARRED' THEN 1 ELSE 0 END)                        AS time_barred_count,
                       ROUND(AVG(c.documentation_score), 1)                                            AS avg_doc_score,
                       SUM(CASE WHEN c.rejection_count >= 2 THEN 1 ELSE 0 END)                         AS repeat_rejections,
                       d.risk_band
                  FROM dealers d
                  LEFT JOIN claims c ON c.dealer_code = d.dealer_code
                  LEFT JOIN schemes s ON s.scheme_code = c.scheme_code
                  ${whereSQL}
                 GROUP BY d.dealer_code
                 ORDER BY CASE d.risk_band WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
                          rejection_pct DESC
            `;
            const rows = db.prepare(sql).all(params);
            return { rows, summary: {
                high: rows.filter(r => r.risk_band === 'HIGH').length,
                medium: rows.filter(r => r.risk_band === 'MEDIUM').length,
                low: rows.filter(r => r.risk_band === 'LOW').length
            }};
        }
    },

    // ===================================================================
    // 3. Claim Aging vs Payout Leakage
    // ===================================================================
    aging_leakage: {
        meta: {
            id: 'aging_leakage',
            title: '3. Claim Aging vs Payout Leakage Analysis',
            description: 'Aging buckets vs claimed amount at risk; tactical leakage from delays.',
            columns: [
                { key: 'aging_bucket', label: 'Aging Bucket',       fmt: 'text' },
                { key: 'claims_count', label: 'Open Claims',         fmt: 'int' },
                { key: 'amount_at_risk', label: 'Amount At Risk (INR)', fmt: 'inr' },
                { key: 'time_barred',  label: 'Already Time-Barred', fmt: 'int' },
                { key: 'leakage_amount', label: 'Realised Leakage (INR)', fmt: 'inr' }
            ]
        },
        filters: ['from','to','region','zone','dealer_code','scheme_type','payout_kind'],
        run(db, p) {
            const { whereSQL, params } = buildWhere(p, ['from','to','region','zone','dealer_code','scheme_type','payout_kind']);
            const sql = `
                WITH base AS (
                    SELECT c.*, d.region, s.scheme_type,
                           CAST(julianday('now') - julianday(c.claim_raised_on) AS INTEGER) AS age_days
                      FROM claims c
                      JOIN dealers d ON d.dealer_code = c.dealer_code
                      JOIN schemes s ON s.scheme_code = c.scheme_code
                      ${whereSQL}
                )
                SELECT bucket AS aging_bucket,
                       COUNT(*) AS claims_count,
                       ROUND(SUM(CASE WHEN status IN ('PENDING','REJECTED','DISPUTED') THEN claimed_amount ELSE 0 END), 2) AS amount_at_risk,
                       SUM(CASE WHEN status='TIME_BARRED' THEN 1 ELSE 0 END)              AS time_barred,
                       ROUND(SUM(CASE WHEN status='TIME_BARRED' THEN claimed_amount ELSE 0 END), 2) AS leakage_amount
                  FROM (
                       SELECT CASE
                                  WHEN age_days <= 15  THEN '0-15 days'
                                  WHEN age_days <= 30  THEN '16-30 days'
                                  WHEN age_days <= 60  THEN '31-60 days'
                                  WHEN age_days <= 90  THEN '61-90 days'
                                  ELSE '90+ days'
                              END AS bucket,
                              status, claimed_amount
                         FROM base
                  )
                 GROUP BY bucket
                 ORDER BY CASE bucket
                            WHEN '0-15 days' THEN 1 WHEN '16-30 days' THEN 2
                            WHEN '31-60 days' THEN 3 WHEN '61-90 days' THEN 4 ELSE 5 END
            `;
            const rows = db.prepare(sql).all(params);
            return { rows, summary: {
                total_at_risk: rows.reduce((s,r)=>s+(r.amount_at_risk||0),0),
                total_leakage: rows.reduce((s,r)=>s+(r.leakage_amount||0),0)
            }};
        }
    },

    // ===================================================================
    // 4. Scheme Effectiveness & Region-wise Dashboard
    // ===================================================================
    scheme_effectiveness: {
        meta: {
            id: 'scheme_effectiveness',
            title: '4. Scheme Effectiveness & Region-wise Dashboard',
            description: 'Scheme-wise claim volume vs payout, region-wise comparison across CORPORATE / EXCHANGE / LOYALTY / RETAIL.',
            columns: [
                { key: 'scheme_name', label: 'Scheme',      fmt: 'text' },
                { key: 'scheme_type', label: 'Type',        fmt: 'text' },
                { key: 'region',      label: 'Region',      fmt: 'text' },
                { key: 'claims_count',label: 'Claims',      fmt: 'int' },
                { key: 'approved_count', label: 'Approved',  fmt: 'int' },
                { key: 'approved_amount',label: 'Payout (INR)',fmt: 'inr' },
                { key: 'target_payout', label: 'Target (INR)', fmt: 'inr' },
                { key: 'achievement_pct', label: 'Achievement %', fmt: 'pct' },
                { key: 'roi_score',     label: 'ROI Score',   fmt: 'badge' }
            ]
        },
        filters: ['from','to','region','scheme_type','payout_kind'],
        run(db, p) {
            const { whereSQL, params } = buildWhere(p, ['from','to','region','scheme_type','payout_kind']);
            const sql = `
                SELECT s.scheme_name,
                       s.scheme_type,
                       d.region,
                       COUNT(c.claim_id)                                                AS claims_count,
                       SUM(CASE WHEN c.status='APPROVED' THEN 1 ELSE 0 END)              AS approved_count,
                       ROUND(SUM(c.approved_amount), 2)                                  AS approved_amount,
                       s.target_payout,
                       ROUND(100.0 * SUM(c.approved_amount) / NULLIF(s.target_payout,0), 2) AS achievement_pct
                  FROM claims c
                  JOIN dealers d ON d.dealer_code = c.dealer_code
                  JOIN schemes s ON s.scheme_code = c.scheme_code
                  ${whereSQL}
                 GROUP BY s.scheme_code, d.region
                 ORDER BY s.scheme_name, d.region
            `;
            const rows = db.prepare(sql).all(params).map(r => ({
                ...r,
                roi_score: r.achievement_pct >= 80 ? 'STRONG'
                         : r.achievement_pct >= 50 ? 'AVERAGE'
                         : 'UNDERPERFORMING'
            }));
            return { rows, summary: {
                schemes: new Set(rows.map(r=>r.scheme_name)).size,
                avg_achievement: rows.length ? Math.round(rows.reduce((s,r)=>s+(r.achievement_pct||0),0)/rows.length) : 0
            }};
        }
    },

    // ===================================================================
    // 5. Predictive & Provision Forecast
    // ===================================================================
    forecast: {
        meta: {
            id: 'forecast',
            title: '5. Predictive & Provision Forecast (Bonus & Tactical)',
            description: 'Trend-based forecast for next 1–2 quarters; provisioning adequacy flag.',
            columns: [
                { key: 'period',          label: 'Period',          fmt: 'text' },
                { key: 'kind',            label: 'Kind',            fmt: 'text' },
                { key: 'historical_avg',  label: 'Hist. Avg / mo (INR)',  fmt: 'inr' },
                { key: 'forecast_amount', label: 'Forecast Payout (INR)', fmt: 'inr' },
                { key: 'provision_required', label: 'Provision Reqd. (INR)', fmt: 'inr' },
                { key: 'adequacy_flag',   label: 'Adequacy', fmt: 'badge' }
            ]
        },
        filters: ['payout_kind','region'],
        run(db, p) {
            const { whereSQL, params } = buildWhere(p, ['region','payout_kind']);
            const sql = `
                SELECT c.period_yyyymm AS period,
                       c.payout_kind   AS kind,
                       ROUND(SUM(c.approved_amount), 2) AS payout
                  FROM claims c
                  JOIN dealers d ON d.dealer_code = c.dealer_code
                  ${whereSQL}
                 GROUP BY c.period_yyyymm, c.payout_kind
                 ORDER BY c.period_yyyymm
            `;
            const hist = db.prepare(sql).all(params);
            // Compute monthly average per kind, then forecast next 6 months at 1.05x trend
            const byKind = {};
            hist.forEach(h => {
                byKind[h.kind] = byKind[h.kind] || [];
                byKind[h.kind].push(h.payout);
            });
            const today = new Date('2026-06-10');
            const rows = [];
            Object.keys(byKind).forEach(kind => {
                const arr = byKind[kind];
                const avg = arr.reduce((s,v)=>s+v,0) / Math.max(1, arr.length);
                const recent = arr.slice(-3).reduce((s,v)=>s+v,0) / Math.max(1, Math.min(3, arr.length));
                for (let i = 1; i <= 6; i++) {
                    const d = new Date(today); d.setMonth(d.getMonth() + i);
                    const period = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
                    const trendFactor = recent / Math.max(1, avg);
                    const forecast = Math.round(avg * Math.min(1.5, Math.max(0.6, trendFactor)));
                    const provision = Math.round(forecast * 1.10);
                    rows.push({
                        period, kind,
                        historical_avg: Math.round(avg),
                        forecast_amount: forecast,
                        provision_required: provision,
                        adequacy_flag: trendFactor > 1.15 ? 'INCREASE' : trendFactor < 0.85 ? 'REDUCE' : 'ADEQUATE'
                    });
                }
            });
            return { rows, summary: {
                next_quarter_total: rows.filter((_,i)=>i<6).reduce((s,r)=>s+r.forecast_amount,0)
            }};
        }
    },

    // ===================================================================
    // 6. Documentation Quality Index (DQI)
    // ===================================================================
    dqi: {
        meta: {
            id: 'dqi',
            title: '6. Documentation Quality Index (DQI) Report',
            description: 'Dealer-level documentation completeness scoring + top documentation gaps.',
            columns: [
                { key: 'dealer_code', label: 'Dealer Code', fmt: 'text' },
                { key: 'dealer_name', label: 'Dealer',      fmt: 'text' },
                { key: 'avg_score',   label: 'Avg DQI (0-100)', fmt: 'num' },
                { key: 'claims_evaluated', label: 'Claims',  fmt: 'int' },
                { key: 'top_gap',     label: 'Top Gap',     fmt: 'text' },
                { key: 'avg_approval_days', label: 'Avg Days to Approval', fmt: 'num' },
                { key: 'tier',        label: 'Tier',        fmt: 'badge' }
            ]
        },
        filters: ['from','to','region','dealer_code','scheme_type'],
        run(db, p) {
            const { whereSQL, params } = buildWhere(p, ['from','to','region','dealer_code','scheme_type']);
            const sql = `
                SELECT d.dealer_code,
                       d.dealer_name,
                       ROUND(AVG(c.documentation_score), 1)             AS avg_score,
                       COUNT(c.claim_id)                                 AS claims_evaluated,
                       ROUND(AVG(CASE WHEN c.approved_on IS NOT NULL
                                      THEN julianday(c.approved_on) - julianday(c.claim_raised_on)
                                      END), 1)                            AS avg_approval_days,
                       GROUP_CONCAT(c.doc_gap_tags, ',')                  AS gaps_blob
                  FROM dealers d
                  JOIN claims  c ON c.dealer_code = d.dealer_code
                  JOIN schemes s ON s.scheme_code = c.scheme_code
                  ${whereSQL}
                 GROUP BY d.dealer_code
                 ORDER BY avg_score DESC
            `;
            const raw = db.prepare(sql).all(params);
            const rows = raw.map(r => {
                const counts = {};
                (r.gaps_blob || '').split(',').filter(Boolean).forEach(g => {
                    counts[g] = (counts[g]||0) + 1;
                });
                const top = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
                const tier = r.avg_score >= 90 ? 'GOLD'
                           : r.avg_score >= 75 ? 'SILVER'
                           : r.avg_score >= 60 ? 'BRONZE'
                           : 'NEEDS COACHING';
                const out = { ...r, top_gap: top ? `${top[0]} (${top[1]})` : '—', tier };
                delete out.gaps_blob;
                return out;
            });
            return { rows, summary: {
                gold:   rows.filter(r=>r.tier==='GOLD').length,
                coach:  rows.filter(r=>r.tier==='NEEDS COACHING').length
            }};
        }
    },

    // ===================================================================
    // 7. Dealer Lifecycle & FNF Risk Tracker
    // ===================================================================
    fnf_tracker: {
        meta: {
            id: 'fnf_tracker',
            title: '7. Dealer Lifecycle & FNF Risk Tracker',
            description: 'Dealers nearing exit, open claim exposure prior to FNF, dispute pendency.',
            columns: [
                { key: 'dealer_code',  label: 'Dealer Code',  fmt: 'text' },
                { key: 'dealer_name',  label: 'Dealer',       fmt: 'text' },
                { key: 'fnf_status',   label: 'FNF Status',   fmt: 'badge' },
                { key: 'fnf_target_date', label: 'FNF Target', fmt: 'text' },
                { key: 'open_claims',  label: 'Open Claims',  fmt: 'int' },
                { key: 'open_exposure',label: 'Open Exposure (INR)', fmt: 'inr' },
                { key: 'disputes',     label: 'Disputes',     fmt: 'int' },
                { key: 'expected_settlement', label: 'Expected Settle (INR)', fmt: 'inr' }
            ]
        },
        filters: ['fnf_status','region','risk_band'],
        run(db, p) {
            const { whereSQL, params } = buildWhere(p, ['fnf_status','region','risk_band']);
            const sql = `
                SELECT d.dealer_code, d.dealer_name, d.fnf_status, d.fnf_target_date,
                       SUM(CASE WHEN c.status IN ('PENDING','REJECTED','DISPUTED') THEN 1 ELSE 0 END) AS open_claims,
                       ROUND(SUM(CASE WHEN c.status IN ('PENDING','REJECTED','DISPUTED') THEN c.claimed_amount ELSE 0 END),2) AS open_exposure,
                       SUM(c.is_dispute) AS disputes,
                       ROUND(SUM(CASE WHEN c.status IN ('PENDING') THEN c.claimed_amount * 0.85 ELSE 0 END), 2) AS expected_settlement
                  FROM dealers d
                  LEFT JOIN claims c ON c.dealer_code = d.dealer_code
                  LEFT JOIN schemes s ON s.scheme_code = c.scheme_code
                  ${whereSQL}
                 GROUP BY d.dealer_code
                 HAVING d.fnf_status <> 'ACTIVE' OR open_exposure > 0
                 ORDER BY CASE d.fnf_status WHEN 'NEARING_EXIT' THEN 0 WHEN 'EXITED' THEN 1 ELSE 2 END,
                          open_exposure DESC
            `;
            const rows = db.prepare(sql).all(params);
            return { rows, summary: {
                nearing_exit: rows.filter(r => r.fnf_status === 'NEARING_EXIT').length,
                total_exposure: rows.reduce((s,r)=>s+(r.open_exposure||0),0)
            }};
        }
    },

    // ===================================================================
    // 8. Corporate & Exchange Claim Dispute Heatmap
    // ===================================================================
    dispute_heatmap: {
        meta: {
            id: 'dispute_heatmap',
            title: '8. Corporate & Exchange Claim Dispute Heatmap',
            description: 'Disputes by dealer / region / scheme; root-cause taxonomy.',
            viz: 'heatmap',
            columns: [
                { key: 'dealer_name',     label: 'Dealer',       fmt: 'text' },
                { key: 'region',          label: 'Region',       fmt: 'text' },
                { key: 'scheme_type',     label: 'Scheme Type',  fmt: 'text' },
                { key: 'dispute_count',   label: 'Disputes',     fmt: 'int' },
                { key: 'root_cause_top',  label: 'Top Root Cause',fmt: 'text' },
                { key: 'avg_resolution_days', label: 'Avg Resolution (d)', fmt: 'num' },
                { key: 'heat',            label: 'Heat',         fmt: 'badge' }
            ]
        },
        filters: ['from','to','region','scheme_type','dealer_code'],
        run(db, p) {
            const filters = { ...p };
            // Dispute heatmap focuses on Corporate + Exchange by default
            if (!filters.scheme_type) filters._auto_corp_exch = 1;
            const { whereSQL, params } = buildWhere(filters, ['from','to','region','scheme_type','dealer_code']);
            const auto = filters._auto_corp_exch ? (whereSQL ? " AND s.scheme_type IN ('CORPORATE','EXCHANGE')" : "WHERE s.scheme_type IN ('CORPORATE','EXCHANGE')") : '';
            const sql = `
                SELECT d.dealer_name,
                       d.region,
                       s.scheme_type,
                       SUM(c.is_dispute) AS dispute_count,
                       (SELECT dispute_root_cause FROM claims c2
                          WHERE c2.dealer_code = d.dealer_code AND c2.is_dispute = 1
                          GROUP BY dispute_root_cause ORDER BY COUNT(*) DESC LIMIT 1) AS root_cause_top,
                       ROUND(AVG(CASE WHEN ev.event_date IS NOT NULL
                                      THEN julianday(ev.event_date) - julianday(c.rejected_on) END), 1) AS avg_resolution_days
                  FROM claims c
                  JOIN dealers d ON d.dealer_code = c.dealer_code
                  JOIN schemes s ON s.scheme_code = c.scheme_code
             LEFT JOIN claim_events ev ON ev.claim_id = c.claim_id AND ev.event_type = 'DISPUTE_CLOSED'
                  ${whereSQL}${auto}
                 GROUP BY d.dealer_code, s.scheme_type
                 HAVING dispute_count > 0
                 ORDER BY dispute_count DESC
            `;
            const rows = db.prepare(sql).all(params).map(r => ({
                ...r,
                heat: r.dispute_count >= 8 ? 'HOT'
                    : r.dispute_count >= 4 ? 'WARM'
                    : 'COOL'
            }));

            // ─── Region × Scheme-type matrix (the actual heatmap) ──────
            const matrixSql = `
                SELECT d.region                AS region,
                       s.scheme_type           AS scheme_type,
                       SUM(c.is_dispute)       AS disputes,
                       ROUND(AVG(CASE WHEN ev.event_date IS NOT NULL
                                      THEN julianday(ev.event_date) - julianday(c.rejected_on) END), 1) AS avg_resolution_days
                  FROM claims c
                  JOIN dealers d ON d.dealer_code = c.dealer_code
                  JOIN schemes s ON s.scheme_code = c.scheme_code
             LEFT JOIN claim_events ev ON ev.claim_id = c.claim_id AND ev.event_type = 'DISPUTE_CLOSED'
                  ${whereSQL}${auto}
                 GROUP BY d.region, s.scheme_type
                 HAVING disputes > 0
            `;
            const matrixRows = db.prepare(matrixSql).all(params);

            // ─── Root-cause distribution (Corporate + Exchange) ───────
            const rootSql = `
                SELECT c.dispute_root_cause AS cause, COUNT(*) AS cnt
                  FROM claims c
                  JOIN dealers d ON d.dealer_code = c.dealer_code
                  JOIN schemes s ON s.scheme_code = c.scheme_code
                 WHERE c.is_dispute = 1 AND c.dispute_root_cause IS NOT NULL
                   ${whereSQL ? whereSQL.replace(/^WHERE/, 'AND') : ''}
                   ${auto.replace(/^WHERE/, 'AND')}
                 GROUP BY c.dispute_root_cause
                 ORDER BY cnt DESC
            `;
            const rootCauses = db.prepare(rootSql).all(params);

            // Build pivoted matrix the frontend can render directly
            const regions = [...new Set(matrixRows.map(r => r.region))].sort();
            const schemeTypes = [...new Set(matrixRows.map(r => r.scheme_type))].sort();
            const cells = {};
            let maxDisputes = 0;
            matrixRows.forEach(r => {
                cells[`${r.region}::${r.scheme_type}`] = {
                    disputes: r.disputes,
                    avg_resolution_days: r.avg_resolution_days
                };
                if (r.disputes > maxDisputes) maxDisputes = r.disputes;
            });

            return {
                rows,
                summary: {
                    hot_dealers: rows.filter(r => r.heat === 'HOT').length,
                    total_disputes: rows.reduce((s, r) => s + (r.dispute_count || 0), 0),
                    regions_affected: regions.length
                },
                heatmap: {
                    regions, scheme_types: schemeTypes, cells, max: maxDisputes
                },
                root_causes: rootCauses
            };
        }
    },

    // ===================================================================
    // 9. Sales Enablement Impact
    // ===================================================================
    sales_enablement: {
        meta: {
            id: 'sales_enablement',
            title: '9. Sales Enablement Impact Report',
            description: 'Correlation between upfront / DAN support and claim success rate, settlement speed.',
            columns: [
                { key: 'support_band',      label: 'Upfront Support Band', fmt: 'text' },
                { key: 'dealer_count',      label: 'Dealers',              fmt: 'int' },
                { key: 'claims',            label: 'Claims',               fmt: 'int' },
                { key: 'success_rate',      label: 'Success %',            fmt: 'pct' },
                { key: 'avg_settlement_days', label: 'Avg Settlement (d)', fmt: 'num' },
                { key: 'payout_per_claim',  label: 'Payout / Claim (INR)', fmt: 'inr' },
                { key: 'impact_signal',     label: 'Impact',               fmt: 'badge' }
            ]
        },
        filters: ['from','to','region'],
        run(db, p) {
            const { whereSQL, params } = buildWhere(p, ['from','to','region']);
            const sql = `
                WITH base AS (
                    SELECT d.dealer_code,
                           CASE
                               WHEN d.upfront_support = 0           THEN 'No Support'
                               WHEN d.upfront_support < 100000      THEN '<1L'
                               WHEN d.upfront_support < 300000      THEN '1L-3L'
                               WHEN d.upfront_support < 500000      THEN '3L-5L'
                               ELSE '5L+'
                           END AS support_band,
                           c.status,
                           c.approved_amount,
                           c.approved_on,
                           c.settlement_date,
                           c.claim_raised_on
                      FROM dealers d
                      JOIN claims  c ON c.dealer_code = d.dealer_code
                      JOIN schemes s ON s.scheme_code = c.scheme_code
                      ${whereSQL}
                )
                SELECT support_band,
                       COUNT(DISTINCT dealer_code)                                       AS dealer_count,
                       COUNT(*)                                                          AS claims,
                       ROUND(100.0 * SUM(CASE WHEN status='APPROVED' THEN 1 ELSE 0 END) / COUNT(*), 2) AS success_rate,
                       ROUND(AVG(CASE WHEN settlement_date IS NOT NULL
                                      THEN julianday(settlement_date) - julianday(claim_raised_on) END), 1) AS avg_settlement_days,
                       ROUND(SUM(approved_amount) * 1.0 / COUNT(*), 2)                   AS payout_per_claim
                  FROM base
                 GROUP BY support_band
                 ORDER BY CASE support_band
                            WHEN 'No Support' THEN 0 WHEN '<1L' THEN 1
                            WHEN '1L-3L' THEN 2 WHEN '3L-5L' THEN 3 ELSE 4 END
            `;
            const rows = db.prepare(sql).all(params).map((r, _, all) => ({
                ...r,
                impact_signal: (() => {
                    const baseline = all.find(x => x.support_band === 'No Support');
                    if (!baseline || !baseline.success_rate) return '—';
                    const lift = (r.success_rate - baseline.success_rate);
                    return lift > 8 ? 'STRONG +' + lift.toFixed(1) + 'pp'
                         : lift > 3 ? 'MODERATE +' + lift.toFixed(1) + 'pp'
                         : lift < -3 ? 'NEGATIVE'
                         : 'NEUTRAL';
                })()
            }));
            return { rows, summary: {
                bands: rows.length
            }};
        }
    }
};

module.exports = { reports, buildWhere };
