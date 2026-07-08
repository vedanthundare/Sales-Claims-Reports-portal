/**
 * DB adapter. Dual-mode:
 *   - If DATABASE_URL is set → Postgres (via `pg`).
 *   - Otherwise            → SQLite in-memory / on-disk via `sql.js`.
 *
 * Public surface (identical for both drivers):
 *   const db = await open(pathOrIgnored);
 *   const rows = await db.prepare(sql).all(params);   // Array
 *   const row  = await db.prepare(sql).get(params);   // Object | undefined
 *   const info = await db.prepare(sql).run(params);   // { lastInsertRowid }
 *   const tx   = db.transaction(async () => { ... }); // returns () => Promise
 *   await db.exec(scriptSql);
 *   await db.close();
 *
 * All operations are async so pg fits cleanly. Callers must `await`.
 *
 * Named-parameter translation: queries use `@name` for both dialects; the pg
 * adapter converts `@name` → `$1, $2, ...` in bind order.
 */
const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------
// pg-flavoured adapter
// ------------------------------------------------------------
async function openPg(url) {
    const { Pool } = require('pg');
    const pool = new Pool({
        connectionString: url,
        ssl: /render\.com|neon\.tech|supabase\.co/i.test(url) ? { rejectUnauthorized: false } : false
    });
    // Sanity-check the connection eagerly so boot errors surface clearly.
    await pool.query('SELECT 1');

    function bindPg(sql, params) {
        if (params == null) return { text: sql, values: [] };
        if (Array.isArray(params)) {
            let i = 0;
            const text = sql.replace(/\?/g, () => `$${++i}`);
            return { text, values: params };
        }
        // named binds — @name → $N
        const values = [];
        const seen = new Map();
        const text = sql.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
            if (seen.has(name)) return `$${seen.get(name)}`;
            values.push(params[name] == null ? null : params[name]);
            seen.set(name, values.length);
            return `$${values.length}`;
        });
        return { text, values };
    }

    let clientHolder = { client: null }; // set during transaction

    function runner() { return clientHolder.client || pool; }

    const api = {
        _dialect: 'pg',
        _pool: pool,

        async exec(sql) {
            // Split on ';' safely (schema.sql has no strings with embedded ;).
            const stmts = sql.split(/;\s*(?:\r?\n|$)/).map(s => s.trim()).filter(Boolean);
            for (const s of stmts) {
                await runner().query(s);
            }
            return api;
        },
        pragma(_) { /* pg: no-op */ },
        prepare(sql) {
            return {
                async all(params) {
                    const { text, values } = bindPg(sql, params);
                    const r = await runner().query(text, values);
                    return r.rows;
                },
                async get(params) {
                    const { text, values } = bindPg(sql, params);
                    const r = await runner().query(text, values);
                    return r.rows[0];
                },
                async run(params) {
                    let { text, values } = bindPg(sql, params);
                    // If it's an INSERT and no RETURNING clause, add one so we can
                    // return lastInsertRowid uniformly.
                    let addedReturning = false;
                    if (/^\s*INSERT\b/i.test(text) && !/\bRETURNING\b/i.test(text)) {
                        text += ' RETURNING *';
                        addedReturning = true;
                    }
                    const r = await runner().query(text, values);
                    let lastInsertRowid = null;
                    if (addedReturning && r.rows.length) {
                        const row = r.rows[0];
                        lastInsertRowid = row.id != null ? row.id
                                        : row.claim_id != null ? row.claim_id
                                        : null;
                    }
                    return { lastInsertRowid, rowCount: r.rowCount };
                }
            };
        },
        transaction(fn) {
            return async (...args) => {
                const c = await pool.connect();
                clientHolder.client = c;
                try {
                    await c.query('BEGIN');
                    const r = await fn(...args);
                    await c.query('COMMIT');
                    return r;
                } catch (e) {
                    await c.query('ROLLBACK');
                    throw e;
                } finally {
                    clientHolder.client = null;
                    c.release();
                }
            };
        },
        async close() { await pool.end(); }
    };
    return api;
}

// ------------------------------------------------------------
// sql.js (SQLite) adapter — mostly the same as before, but every method now
// returns a Promise so callers use one code path.
// ------------------------------------------------------------
let SQL = null;
async function _ensureSql() {
    if (SQL) return SQL;
    const initSqlJs = require('sql.js');
    const distDir = path.join(__dirname, 'node_modules', 'sql.js', 'dist');
    SQL = await initSqlJs({ locateFile: f => path.join(distDir, f) });
    return SQL;
}
function _bindSqlite(stmt, params) {
    if (params == null) return;
    if (Array.isArray(params)) { stmt.bind(params); return; }
    if (typeof params === 'object') {
        const obj = {};
        Object.keys(params).forEach(k => { obj['@' + k] = params[k]; });
        stmt.bind(obj);
        return;
    }
    stmt.bind([params]);
}
async function openSqlite(dbPath) {
    await _ensureSql();
    const raw = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();
    const api = {
        _dialect: 'sqlite',
        _raw: raw,
        _path: dbPath,
        async exec(sql) { raw.exec(sql); return api; },
        pragma(_) { /* no-op */ },
        prepare(sql) {
            return {
                async all(params) {
                    const stmt = raw.prepare(sql);
                    if (params !== undefined) _bindSqlite(stmt, params);
                    const out = [];
                    while (stmt.step()) out.push(stmt.getAsObject());
                    stmt.free();
                    return out;
                },
                async get(params) {
                    const stmt = raw.prepare(sql);
                    if (params !== undefined) _bindSqlite(stmt, params);
                    const row = stmt.step() ? stmt.getAsObject() : undefined;
                    stmt.free();
                    return row;
                },
                async run(params) {
                    const stmt = raw.prepare(sql);
                    if (params !== undefined) _bindSqlite(stmt, params);
                    stmt.step();
                    stmt.free();
                    const r = raw.exec('SELECT last_insert_rowid() AS id');
                    const id = r.length ? r[0].values[0][0] : null;
                    return { lastInsertRowid: id, rowCount: 1 };
                }
            };
        },
        transaction(fn) {
            return async (...args) => {
                raw.exec('BEGIN');
                try {
                    const r = await fn(...args);
                    raw.exec('COMMIT');
                    return r;
                } catch (e) {
                    raw.exec('ROLLBACK');
                    throw e;
                }
            };
        },
        save() {
            const data = raw.export();
            fs.writeFileSync(dbPath, Buffer.from(data));
        },
        async close() { api.save(); raw.close(); }
    };
    return api;
}

// ------------------------------------------------------------
// Dispatcher
// ------------------------------------------------------------
async function open(dbPath) {
    if (process.env.DATABASE_URL) {
        return openPg(process.env.DATABASE_URL);
    }
    return openSqlite(dbPath);
}

module.exports = { open };
