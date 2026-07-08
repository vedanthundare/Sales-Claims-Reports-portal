/* ------------------------------------------------------------------
 * Frontend runtime config.
 *
 * The Vercel deploy hosts ONLY the static frontend — the API lives on
 * Render. Route API calls accordingly:
 *   - localhost / 127.0.0.1   → same origin (the local `npm start` server)
 *   - *.onrender.com          → same origin (Render serves both)
 *   - anything else (Vercel)  → point at the Render URL
 * ------------------------------------------------------------------ */
(function () {
    const RENDER_API = "https://sales-claims-reports-portal.onrender.com";
    const host = (window.location && window.location.hostname) || "";
    if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".onrender.com")) {
        window.__API_BASE = "";
    } else {
        window.__API_BASE = RENDER_API;
    }
})();
