/* ------------------------------------------------------------------
 * Frontend runtime config.
 *
 * On Render (frontend + API on the same origin) → leave empty.
 * On Vercel (frontend only)                     → set to Render URL,
 *   e.g. "https://sales-claims-reports-portal.onrender.com"
 * ------------------------------------------------------------------ */
// Local dev: leave empty so the frontend calls the same origin (the Node server on 4500).
// For a deployed frontend-only setup, set this to your API host.
window.__API_BASE = "";
