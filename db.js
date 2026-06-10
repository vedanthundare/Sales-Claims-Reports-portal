/**
 * Tiny adapter that wraps sql.js (pure-JS / WASM SQLite) and exposes a
 * better-sqlite3-style synchronous API so seed.js / reports.js / server.js
 * don't have to care which driver is underneath.
 *
 * Public surface used in this project:
 *   db.exec(sqlScript)
 *   db.pragma(str)             (no-op — sql.js handles its own pragmas)
 *   db.prepare(sql).all(params)
 *   db.prepare(sql).get(params)
 *   db.prepare(sql).run(params) -> { lastInsertRowid }
 *   db.transaction(fn) -> () => fn(...)  (wraps in BEGIN/COMMIT)
 *   db.close()                  (persists to disk)
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

let SQL = null;

async function _ensureSql() {
    if (SQL) return SQL;
    const distDir = path.join(__dirname, 'node_modules', 'sql.js', 'dist');
    SQL = await initSqlJs({ locateFile: f => path.join(distDir, f) });
    return SQL;
}

function _normalizeArgs(args) {
    if (!args.length) return undefined;
    if (args.length === 1) return args[0];
    return args; // positional binds for "?, ?, ?"
}

function _bindParams(stmt, params) {
    if (params == null) return;
    if (Array.isArray(params)) {
        stmt.bind(params);
    } else if (typeof params === 'object') {
        // sql.js named params are prefixed with @, :, or $; our queries use '@'
        const obj = {};
        Object.keys(params).forEach(k => { obj['@' + k] = params[k]; });
        stmt.bind(obj);
    } else {
        stmt.bind([params]);
    }
}

function _wrap(rawDb, dbPath) {
    const api = {
        _raw: rawDb,
        _path: dbPath,

        exec(sql) {
            rawDb.exec(sql);
            return api;
        },
        pragma(_) { /* sql.js manages its own; no-op */ },

        prepare(sql) {
            return {
                all(...args) {
                    const params = _normalizeArgs(args);
                    const stmt = rawDb.prepare(sql);
                    if (params !== undefined) _bindParams(stmt, params);
                    const out = [];
                    while (stmt.step()) out.push(stmt.getAsObject());
                    stmt.free();
                    return out;
                },
                get(...args) {
                    const params = _normalizeArgs(args);
                    const stmt = rawDb.prepare(sql);
                    if (params !== undefined) _bindParams(stmt, params);
                    const row = stmt.step() ? stmt.getAsObject() : undefined;
                    stmt.free();
                    return row;
                },
                run(...args) {
                    const params = _normalizeArgs(args);
                    const stmt = rawDb.prepare(sql);
                    if (params !== undefined) _bindParams(stmt, params);
                    stmt.step();
                    stmt.free();
                    const r = rawDb.exec('SELECT last_insert_rowid() AS id');
                    const id = r.length ? r[0].values[0][0] : null;
                    return { lastInsertRowid: id };
                }
            };
        },

        transaction(fn) {
            return (...args) => {
                rawDb.exec('BEGIN');
                try {
                    const r = fn(...args);
                    rawDb.exec('COMMIT');
                    return r;
                } catch (e) {
                    rawDb.exec('ROLLBACK');
                    throw e;
                }
            };
        },

        save() {
            const data = rawDb.export();
            fs.writeFileSync(dbPath, Buffer.from(data));
        },
        close() {
            api.save();
            rawDb.close();
        }
    };
    return api;
}

async function open(dbPath) {
    await _ensureSql();
    let raw;
    if (fs.existsSync(dbPath)) {
        raw = new SQL.Database(fs.readFileSync(dbPath));
    } else {
        raw = new SQL.Database();
    }
    return _wrap(raw, dbPath);
}

module.exports = { open };
