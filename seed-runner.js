/**
 * Wraps seed.js so it can be invoked both from CLI (node seed.js)
 * and programmatically from server.js when the SQLite file is missing.
 */
const { spawn } = require('child_process');
const path = require('path');

module.exports = function runSeed() {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'seed.js')], {
            cwd: __dirname,
            stdio: 'inherit'
        });
        child.on('exit', code => {
            if (code === 0) resolve();
            else reject(new Error(`seed.js exited with code ${code}`));
        });
        child.on('error', reject);
    });
};
