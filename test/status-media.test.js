'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const statusMedia = require('../statusMedia');

const img = (len = 100) => ({ key: { id: 'a' }, message: { imageMessage: { mimetype: 'image/jpeg', fileLength: len } } });

test('télécharge à la demande puis sert le cache', async () => {
    statusMedia.remember('s1', img());
    let calls = 0;
    const dl = async () => { calls += 1; return Buffer.from('abc'); };
    const a = await statusMedia.fetchMedia('s1', dl);
    const b = await statusMedia.fetchMedia('s1', dl);
    assert.equal(a.mime, 'image/jpeg');
    assert.equal(b.buffer.toString(), 'abc');
    assert.equal(calls, 1);
});

test('refuse un média déclaré au-dessus de 10 Mo sans le télécharger', async () => {
    statusMedia.remember('s2', img(11 * 1024 * 1024));
    await assert.rejects(statusMedia.fetchMedia('s2', async () => { throw new Error('ne doit pas être appelé'); }), { code: 'too-large' });
});

test('statut texte : pas de média, texte lisible', async () => {
    const msg = { key: { id: 't' }, message: { extendedTextMessage: { text: 'Bonjour' } } };
    statusMedia.remember('s3', msg);
    assert.equal(statusMedia.container(msg), null);
    assert.equal(statusMedia.textOf(msg), 'Bonjour');
    await assert.rejects(statusMedia.fetchMedia('s3', async () => Buffer.from('x')), { code: 'no-media' });
});

test('statut inconnu', async () => {
    await assert.rejects(statusMedia.fetchMedia('nope', async () => Buffer.from('x')), { code: 'not-found' });
});
