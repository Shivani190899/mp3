const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const run = promisify(execFile);

for (const uri of ['', 'mongodb+srv://<username>:<password>@<your-cluster>.mongodb.net/mp3']) {
    test('startup rejects ' + (uri ? 'the placeholder database address' : 'a missing database address'), async () => {
        await assert.rejects(run(process.execPath, ['server.js'], {
            cwd: path.resolve(__dirname, '..'),
            env: { ...process.env, MONGODB_URI: uri, PORT: '0' },
            timeout: 3000
        }), error => {
            assert.equal(error.code, 1);
            assert.match(error.stderr, /MONGODB_URI/);
            assert.doesNotMatch(error.stdout, /Server running/);
            return true;
        });
    });
}
