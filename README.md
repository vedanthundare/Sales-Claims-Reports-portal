# Skoda Sales Claims — Reports & MIS

Standalone analytical reporting service for Skoda Sales Claims (Tactical & Base
payouts). Lives **outside** the Dealer Management System and runs against its
own SQLite datamart.

Nine reports, each with declarative filters, KPI tiles, a result table, and
CSV / Excel download.

---

## The nine reports — what they do and why they matter

### 1. Claims Efficiency Report

**What it shows.** For every dealer (or scheme, or period — switchable via the
`group_by` filter) the report prints claims raised, claims approved, total
amount claimed, total amount actually paid out, approval %, payout per claim,
and a HIGH / MEDIUM / LOW efficiency flag.

**How the flag is computed.**
* `HIGH` — approval ≥ 80 % **and** payout-per-claim ≥ ₹12,000
* `MEDIUM` — approval ≥ 60 %
* `LOW (review)` — anything below; surfaces dealers/schemes that file a lot of
  claims for very little realised payout.

**Why it's useful.** Brand finance can answer the single most important
question about a sales scheme: *"is this scheme actually generating
proportionate business value, or just generating paperwork and rejection?"*
Low-efficiency rows are the obvious candidates for scheme tweaks, dealer
training, or stricter eligibility rules.

---

### 2. Dealer Behavior & Risk Profiling Report

**What it shows.** Every dealer with their total claims, rejection %,
time-barred count, repeat-rejection count (claims rejected ≥ 2 times), average
documentation score, and a final **risk band** of LOW / MEDIUM / HIGH.

**Why it's useful.** Instead of reacting case-by-case, the team can run
proactive interventions on a *named list* of high-risk dealers — surprise
audits, mandatory documentation training, tighter approval policies, or
withholding of upfront support until behaviour normalises. The report also
flags dealers who've quietly drifted from LOW to MEDIUM, which is the cheapest
moment to course-correct.

---

### 3. Claim Aging vs Payout Leakage Analysis

**What it shows.** All open claims bucketed into 0-15 / 16-30 / 31-60 / 61-90 /
90+ days, with the amount currently *at risk* (pending/rejected/disputed
claims) and the amount already *leaked* (claims that crossed the 15-day
deadline and time-barred — pure money lost to the business).

**Why it's useful.** Quantifies the rupee cost of slow processing. A
finance head can say: *"₹1.16 Cr leaked last quarter because dealers/auditors
sat on claims past their submission window."* That number is what justifies
SLA dashboards, escalation rules, and the time-bar warnings inside the DMS.

---

### 4. Scheme Effectiveness & Region-wise Dashboard

**What it shows.** Each scheme broken down by region — claims volume, approved
count, payout, the scheme's stated payout target, achievement %, and a
STRONG / AVERAGE / UNDERPERFORMING ROI signal.

**Why it's useful.** Lets the brand compare apples to apples across
**Corporate, Exchange, Loyalty, Retail Tactical**, and **Base** schemes
side-by-side. Two answers come out of it instantly:
* *"Which schemes deserve more budget next quarter?"*
* *"Which schemes are underperforming everywhere we run them and should be
  retired?"*

A region cross-cut also prevents the false comfort of a national average — a
scheme that's STRONG in West and UNDERPERFORMING in East shows up as two
separate rows.

---

### 5. Predictive & Provision Forecast Report (Bonus & Tactical)

**What it shows.** For each payout kind (BASE / TACTICAL) the next 6 months of
expected payout, computed by trending recent 3-month average against the
12-month average. Adds a +10 % buffer to suggest a provision figure and flags
the period as `INCREASE`, `ADEQUATE`, or `REDUCE`.

**Why it's useful.** Stops the "provisioning shock" that hits when a scheme
ramps faster than finance models. The CFO's office gets a defensible number to
park in next quarter's books *before* the claims arrive, and the
`INCREASE` / `REDUCE` flag tells them which lines to revisit at the next
budget review.

---

### 6. Documentation Quality Index (DQI) Report

**What it shows.** Each dealer scored 0-100 on average documentation
completeness across all their claims, plus the **most common documentation
gap** (e.g. `INVOICE_MISSING (47)`, `RC_PENDING (31)`), the average days from
claim raise to approval, and a tier badge: `GOLD / SILVER / BRONZE / NEEDS
COACHING`.

**Why it's useful.** Shifts conversations away from individual rejections
("you sent bad docs again") to systemic root causes ("23 of your last 50
claims are missing GST proof — fix the upload step at the dealership"). The
DQI ↔ approval-speed column also gives a hard correlation: dealers in the GOLD
tier get paid materially faster, which is a strong incentive that the brand
can publicise.

---

### 7. Dealer Lifecycle & FNF Risk Tracker

**What it shows.** Every dealer that is **NEARING_EXIT** or **EXITED**, plus
any active dealer with open claim exposure: open claim count, total open
exposure (₹), open dispute count, and an "expected settlement value" (85 % of
the pending claim total — i.e. our best guess at what we'll actually pay).

**Why it's useful.** Dealer exits are when revenue leakage is *highest* —
post-FNF the dealer has zero incentive to chase pending claims, and the brand
risks closing the relationship with disputes still open. This report is the
checklist a relationship manager runs before signing off any FNF
(Full-and-Final) settlement, and the finance team uses the `expected
settlement` column to pre-fund the closure.

---

### 8. Corporate & Exchange Claim Dispute Heatmap

**What it shows.** Wherever disputes concentrate — dealer × region × scheme
type — with the count of disputes, the most common root cause taxonomy
(`DOC / POLICY / ELIGIBILITY / SYSTEM / DEALER_ERROR`), the average days to
resolution, and a `HOT / WARM / COOL` heat label.

**Why it's useful.** Disputes on Corporate (fleet) and Exchange (trade-in)
claims are typically the largest by rupee value and the slowest to clear.
Seeing them in one heatmap lets leadership target the actual driver — if
60 % of HOT cells share `POLICY` as root cause, that's a policy rewrite, not a
dealer training problem. Shortens resolution cycles and prevents the same
dispute pattern repeating across regions.

---

### 9. Sales Enablement Impact Report

**What it shows.** Dealers grouped by upfront / DAN support band
(`No Support` → `<1L` → `1L-3L` → `3L-5L` → `5L+`). For each band: how many
dealers, claims filed, success %, average days-to-settlement, payout per
claim, and an `Impact` signal that compares each band's success rate against
the `No Support` baseline (`STRONG / MODERATE / NEUTRAL / NEGATIVE`).

**Why it's useful.** Upfront support is expensive — this report quantifies
whether it's actually paying off. A `STRONG +14.2 pp` reading on the `3L-5L`
band tells you that ₹3-5 lakh of advance support lifts approval rates by
14 percentage points and shaves *X* days off settlement, which is a defensible
ROI for continuing that program. Conversely, a `NEUTRAL` or `NEGATIVE` band is
the case for re-engineering the support tier.

---

## Filters that drive the SQL

Every filter posted on the query string is mapped 1:1 to a parameterised SQL
fragment by `buildWhere()` in [reports.js](reports.js). Each report
declares which filters it accepts; the UI hides everything else.

| Filter        | Mapped clause                              | Used by reports          |
|---------------|--------------------------------------------|--------------------------|
| `from` / `to` | `c.claim_raised_on BETWEEN ? AND ?`        | 1, 2, 3, 4, 6, 8, 9      |
| `region`      | `d.region = ?`                             | most                     |
| `zone`        | `d.zone = ?`                               | 1, 2, 3                  |
| `dealer_code` | `c.dealer_code = ?`                        | 1, 3, 6, 8               |
| `scheme_type` | `s.scheme_type = ?`                        | 1, 3, 4, 6, 8            |
| `scheme_code` | `c.scheme_code = ?`                        | 1                        |
| `payout_kind` | `c.payout_kind = ?` (BASE / TACTICAL)      | 1, 3, 4, 5               |
| `risk_band`   | `d.risk_band = ?`                          | 2, 7                     |
| `fnf_status`  | `d.fnf_status = ?`                         | 7                        |
| `status`      | `c.status = ?`                             | data-table reports       |
| `group_by`    | switches GROUP BY (dealer / scheme / period) | 1                      |

---

## Download

Every result table has both **CSV** and **Excel (XLSX)** download. Both routes
hit `/api/reports/:id/download?format=csv|xlsx&<filters>`, so the
downloaded file always matches exactly what's currently rendered on screen
(same filters, same rows, same column order).

---

## Architecture

```
skoda-reports/
├── package.json          deps: express, sql.js, xlsx, cors
├── schema.sql            dealers · schemes · claims · claim_events
├── seed.js               4,000 synthetic claims · 24 dealers · 7 schemes
├── db.js                 sql.js wrapper exposing better-sqlite3-style API
├── reports.js            9 report definitions: meta + filters + SQL builder
├── server.js             Express: /api/meta · /api/reports/:id · /download
└── public/index.html     Single-page UI (vanilla JS, no build step)
```

The datamart is intentionally denormalised for fast aggregation — `region`
and `payout_kind` live on the claim row even though they are derivable.

---

## Running

```bash
cd skoda-reports
npm install            # 80 packages, no native compilation
npm run seed           # populates data/reports.sqlite3
npm start              # serves http://localhost:4500
```

Open <http://localhost:4500>, pick a report from the left rail, adjust
filters, click **Generate Report**, then **Download CSV** or **Download
Excel**.

---

## Why standalone

The DMS itself uses MongoDB; this service runs on SQLite so it can be deployed
independently as a read-only analytics layer. Wire it to a nightly ETL job
(out of scope here) that refreshes `reports.sqlite3` from the operational DMS
database.
