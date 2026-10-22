'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const scheduler = require('../scheduler');

const T0 = Date.UTC(2026, 9, 18, 10, 0, 0);
const MIN = 60 * 1000;

function makeDeps(log, { fail = false } = {}) {
    return {
        async sendMessage(chatId, text) { if (fail) throw new Error('hors ligne'); log.push(['msg', chatId, text]); },
        async sendStatus(s) { if (fail) throw new Error('hors ligne'); log.push(['st', s.text, s.backgroundColor]); },
    };
}

test('un message échu est envoyé puis marqué envoyé', async () => {
    const log = [];
    scheduler._reset({}, null, makeDeps(log));
    await scheduler.add({ kind: 'msg', chatId: '1203@g.us', text: 'salut', ts: T0 + 5 * MIN }, T0);
    assert.equal(await scheduler.tick(T0 + MIN), 0);
    assert.equal(await scheduler.tick(T0 + 6 * MIN), 1);
    assert.deepEqual(log, [['msg', '1203@g.us', 'salut']]);
    assert.equal(scheduler.list()[0].state, 'sent');
    assert.equal(await scheduler.tick(T0 + 7 * MIN), 0);
});

test('un statut utilise la couleur de fond choisie', async () => {
    const log = [];
    scheduler._reset({}, null, makeDeps(log));
    await scheduler.add({ kind: 'st', text: 'Bon lundi', bg: 1, ts: T0 + MIN }, T0);
    await scheduler.tick(T0 + 2 * MIN);
    assert.deepEqual(log, [['st', 'Bon lundi', '#7B4FD0']]);
});

test('bot absent à l\'heure : envoi au retour dans les 30 min, sinon manqué', async () => {
    const log = [];
    scheduler._reset({}, null, makeDeps(log));
    await scheduler.add({ kind: 'msg', chatId: 'a@s.whatsapp.net', text: 'tôt', ts: T0 + MIN }, T0);
    await scheduler.add({ kind: 'msg', chatId: 'b@s.whatsapp.net', text: 'tard', ts: T0 + 2 * MIN }, T0);
    // retour à +25 min : les deux partent
    assert.equal(await scheduler.tick(T0 + 25 * MIN), 2);
    scheduler._reset({}, null, makeDeps(log));
    await scheduler.add({ kind: 'msg', chatId: 'c@s.whatsapp.net', text: 'raté', ts: T0 + MIN }, T0);
    assert.equal(await scheduler.tick(T0 + 40 * MIN), 0);
    assert.equal(scheduler.list()[0].state, 'missed');
});

test('un élément répété saute les occurrences ratées et reste en attente', async () => {
    const log = [];
    scheduler._reset({}, null, makeDeps(log));
    const item = await scheduler.add({ kind: 'msg', chatId: 'a@s.whatsapp.net', text: 'chaque jour', ts: T0 + MIN, repeat: 'daily' }, T0);
    const threeDays = T0 + 3 * 24 * 60 * MIN + 10 * MIN;
    assert.equal(await scheduler.tick(threeDays), 0);
    const [after] = scheduler.list();
    assert.equal(after.state, 'waiting');
    assert.ok(after.ts > threeDays);
    assert.equal((after.ts - item.ts) % (24 * 60 * MIN), 0);
});

test('un envoi réussi d\'un élément répété le replanifie', async () => {
    const log = [];
    scheduler._reset({}, null, makeDeps(log));
    await scheduler.add({ kind: 'msg', chatId: 'a@s.whatsapp.net', text: 'x', ts: T0 + MIN, repeat: 'weekly' }, T0);
    assert.equal(await scheduler.tick(T0 + 2 * MIN), 1);
    const [i] = scheduler.list();
    assert.equal(i.state, 'waiting');
    assert.equal(i.ts, T0 + MIN + 7 * 24 * 60 * MIN);
});

test('échec d\'envoi : trois essais puis manqué', async () => {
    const log = [];
    scheduler._reset({}, null, makeDeps(log, { fail: true }));
    await scheduler.add({ kind: 'msg', chatId: 'a@s.whatsapp.net', text: 'x', ts: T0 + MIN }, T0);
    await scheduler.tick(T0 + 2 * MIN);
    assert.equal(scheduler.list()[0].state, 'waiting');
    await scheduler.tick(T0 + 3 * MIN);
    await scheduler.tick(T0 + 4 * MIN);
    const [i] = scheduler.list();
    assert.equal(i.state, 'missed');
    assert.equal(i.error, 'hors ligne');
});

test('pas d\'envoi tant que le bot n\'est pas connecté', async () => {
    const log = [];
    const deps = { ...makeDeps(log), isConnected: () => false };
    scheduler._reset({}, null, deps);
    await scheduler.add({ kind: 'msg', chatId: 'a@s.whatsapp.net', text: 'x', ts: T0 + MIN }, T0);
    assert.equal(await scheduler.tick(T0 + 2 * MIN), 0);
    assert.deepEqual(log, []);
    assert.equal(scheduler.list()[0].state, 'waiting');
});

test('envoyer maintenant et renvoyer un manqué', async () => {
    const log = [];
    scheduler._reset({}, null, makeDeps(log));
    const w = await scheduler.add({ kind: 'msg', chatId: 'a@s.whatsapp.net', text: 'go', ts: T0 + 60 * MIN }, T0);
    await scheduler.sendNow(w.id, T0);
    assert.equal(scheduler.list()[0].state, 'sent');
    await assert.rejects(scheduler.sendNow(w.id), { code: 'invalid' });
    await assert.rejects(scheduler.sendNow(999), { code: 'not-found' });
});

test('validation des demandes', async () => {
    scheduler._reset({}, null, makeDeps([]));
    const ok = { kind: 'msg', chatId: 'a@s.whatsapp.net', text: 'x', ts: T0 + MIN };
    await assert.rejects(scheduler.add({ ...ok, kind: 'zzz' }, T0), { code: 'invalid' });
    await assert.rejects(scheduler.add({ ...ok, text: '  ' }, T0), { code: 'invalid' });
    await assert.rejects(scheduler.add({ ...ok, ts: T0 - 10 * MIN }, T0), { code: 'invalid' });
    await assert.rejects(scheduler.add({ ...ok, chatId: 'pas-un-jid' }, T0), { code: 'invalid' });
    await assert.rejects(scheduler.add({ kind: 'st', text: 'x'.repeat(701), ts: T0 + MIN }, T0), { code: 'invalid' });
    assert.equal(scheduler.list().length, 0);
});

test('suppression et persistance', async () => {
    const saved = [];
    scheduler._reset({}, async (s) => { saved.push(s); }, makeDeps([]));
    const a = await scheduler.add({ kind: 'msg', chatId: 'a@s.whatsapp.net', text: 'x', ts: T0 + MIN }, T0);
    assert.equal(scheduler.remove(a.id), true);
    assert.equal(scheduler.remove(a.id), false);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(saved.at(-1).items.length, 0);
});

test('modifier le texte, l\'heure et relancer un manqué', async () => {
    const log = [];
    scheduler._reset({}, null, makeDeps(log));
    const w = await scheduler.add({ kind: 'msg', chatId: 'a@s.whatsapp.net', text: 'avant', ts: T0 + MIN }, T0);
    const u = scheduler.update(w.id, { text: ' après ', ts: T0 + 90 * MIN, repeat: 'daily' }, T0);
    assert.equal(u.text, 'après');
    assert.equal(u.ts, T0 + 90 * MIN);
    assert.equal(u.repeat, 'daily');
    assert.throws(() => scheduler.update(w.id, { text: '' }, T0), { code: 'invalid' });
    assert.throws(() => scheduler.update(w.id, { ts: T0 - 10 * MIN }, T0), { code: 'invalid' });
    assert.throws(() => scheduler.update(999, { text: 'x' }, T0), { code: 'not-found' });
    // un manqué repart avec une nouvelle heure
    scheduler._reset({}, null, makeDeps(log));
    const m = await scheduler.add({ kind: 'msg', chatId: 'a@s.whatsapp.net', text: 'x', ts: T0 + MIN }, T0);
    await scheduler.tick(T0 + 40 * MIN);
    assert.equal(scheduler.list()[0].state, 'missed');
    scheduler.update(m.id, { ts: T0 + 60 * MIN }, T0 + 41 * MIN);
    assert.equal(scheduler.list()[0].state, 'waiting');
});

function fakeStore() {
    const m = new Map();
    return {
        async put(id, buf) { m.set(id, buf); },
        async get(id) { if (!m.has(id)) throw new Error('absent'); return m.get(id); },
        async del(id) { m.delete(id); },
        has: (id) => m.has(id),
    };
}

test('un statut vocal ou vidéo garde son média et le transmet à l\'envoi', async () => {
    const sent = [];
    const store = fakeStore();
    scheduler._reset({}, null, { async sendStatus(s) { sent.push(s); } }, store);
    const data = Buffer.from('abc').toString('base64');
    const item = await scheduler.add({ kind: 'st', text: '', ts: T0 + MIN, media: { type: 'audio', mime: 'audio/mpeg', data } }, T0);
    assert.equal(item.media.type, 'audio');
    assert.equal(item.text, '');
    await scheduler.tick(T0 + 2 * MIN);
    assert.equal(sent[0].media.type, 'audio');
    assert.equal(sent[0].media.buffer.toString(), 'abc');
});

test('un média sans statut, trop lourd ou vide est refusé', async () => {
    scheduler._reset({}, null, null, fakeStore());
    const data = Buffer.from('x').toString('base64');
    await assert.rejects(scheduler.add({ kind: 'msg', chatId: 'a@s.whatsapp.net', text: 'x', ts: T0 + MIN, media: { type: 'audio', data } }, T0), /réservé/);
    await assert.rejects(scheduler.add({ kind: 'st', ts: T0 + MIN, media: { type: 'gif', data } }, T0), /inconnu/);
    await assert.rejects(scheduler.add({ kind: 'st', ts: T0 + MIN, media: { type: 'video', data: '' } }, T0), /vide/);
    const big = Buffer.alloc(scheduler.MAX_MEDIA + 1).toString('base64');
    await assert.rejects(scheduler.add({ kind: 'st', ts: T0 + MIN, media: { type: 'video', data: big } }, T0), /lourd/);
});

test('supprimer un statut programmé supprime son média', async () => {
    const store = fakeStore();
    scheduler._reset({}, null, null, store);
    const item = await scheduler.add({ kind: 'st', ts: T0 + MIN, media: { type: 'image', data: Buffer.from('i').toString('base64') } }, T0);
    assert.equal(store.has(item.id), true);
    scheduler.remove(item.id);
    await new Promise((r) => setImmediate(r));
    assert.equal(store.has(item.id), false);
});
