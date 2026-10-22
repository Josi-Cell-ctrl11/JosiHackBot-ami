'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rateLimit } = require('../api');

function run(mw, ip) {
    let status = null;
    const res = { setHeader() {}, status(c) { status = c; return this; }, json() { return this; } };
    let passed = false;
    mw({ ip, socket: {} }, res, () => { passed = true; });
    return { passed, status };
}

test('au-delà de la limite : 429, puis la fenêtre repart', () => {
    const mw = rateLimit(3, 60000);
    for (let i = 0; i < 3; i++) assert.equal(run(mw, '1.1.1.1').passed, true);
    assert.equal(run(mw, '1.1.1.1').status, 429);
    assert.equal(run(mw, '2.2.2.2').passed, true);
});

test('deux limiteurs ne partagent pas leur compteur', () => {
    const reads = rateLimit(5, 60000);
    const sends = rateLimit(1, 60000);
    for (let i = 0; i < 4; i++) run(reads, '3.3.3.3');
    assert.equal(run(sends, '3.3.3.3').passed, true);
});
