/* ------------------------------------------------------------------
 * Frontend runtime config.
 *
 * On Render (frontend + API on the same origin) → leave empty.
 * On Vercel (frontend only)                     → set to Render URL,
 *   e.g. "https://sales-claims-reports-portal.onrender.com"
 * ------------------------------------------------------------------ */
window.__API_BASE = "https://sales-claims-reports-portal.onrender.com";
