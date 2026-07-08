/**
 * Wraps the ETL (real-file ingest) so it can be invoked both from CLI
 * (node etl.js) and programmatically from server.js when the SQLite
 * file is missing. Falls back to seed.js if files/ folder is absent.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

module.exports = function runSeed() {
    const filesDir = path.join(__dirname, 'files');
    const script = fs.existsSync(filesDir) ? 'etl.js' : 'seed.js';
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, script)], {
            cwd: __dirname,
            stdio: 'inherit'
        });
        child.on('exit', code => {
            if (code === 0) resolve();
            else reject(new Error(`${script} exited with code ${code}`));
        });
        child.on('error', reject);
    });
};
