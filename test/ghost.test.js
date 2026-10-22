'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ghost = require('../ghost');
const { patch, TARGET } = require('../scripts/patch-baileys');

function fakeAirplane(log) {
    return { async set(socket, enabled) { log.push(['airplane', enabled]); return enabled; } };
}

test('activer : coupe les accusés et active le mode avion', async () => {
    ghost._reset({}, null, () => true);
    const log = [];
    assert.equal(await ghost.set({}, true, fakeAirplane(log)), true);
    assert.deepEqual(log, [['airplane', true]]);
    assert.equal(globalThis.__josiSkipReceipt({}), true);
});

test('couper : les accusés repartent et le mode avion se coupe', async () => {
    ghost._reset({ enabled: true }, null, () => true);
    const log = [];
    assert.equal(await ghost.set({}, false, fakeAirplane(log)), false);
    assert.deepEqual(log, [['airplane', false]]);
    assert.equal(globalThis.__josiSkipReceipt({}), false);
});

test('sans correctif Baileys : refuse d\'activer', async () => {
    ghost._reset({}, null, () => false);
    const log = [];
    await assert.rejects(ghost.set({}, true, fakeAirplane(log)), { code: 'not-patched' });
    assert.deepEqual(log, []);
    assert.equal(ghost.isEnabled(), false);
});

test('le réglage est persisté', async () => {
    const saved = [];
    ghost._reset({}, async (s) => { saved.push(s); }, () => true);
    await ghost.set({}, true, fakeAirplane([]));
    assert.deepEqual(saved, [{ enabled: true }]);
});

test('correctif : s\'applique une fois, est idempotent, signale une ligne absente', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-'));
    const file = path.join(dir, 'messages-recv.js');
    fs.writeFileSync(file, `a();\n                        ${TARGET}\nb();\n`);
    assert.equal(patch(file), 'patched');
    const once = fs.readFileSync(file, 'utf8');
    assert.match(once, /__josiSkipReceipt/);
    assert.equal(patch(file), 'already');
    assert.equal(fs.readFileSync(file, 'utf8'), once);
    // le fichier patché reste du JavaScript valide
    new Function(`return async function f(msg, type, sendReceipt, participant){ ${once.replace(/^a\(\);|b\(\);$/gm, '')} }`);

    const other = path.join(dir, 'other.js');
    fs.writeFileSync(other, 'rien\n');
    assert.equal(patch(other), 'not-found');
    fs.rmSync(dir, { recursive: true, force: true });
});
