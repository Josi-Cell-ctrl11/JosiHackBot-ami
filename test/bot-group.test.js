'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const botGroup = require('../botGroup');

const GROUP = '120363000000000001@g.us';
const SELF = '33612345678@s.whatsapp.net';

test('captures et réponses restent dans la discussion tant que le groupe n\'existe pas', () => {
    botGroup._reset({});
    assert.equal(botGroup.captureJid(SELF), SELF);
    assert.equal(botGroup.replyJid({ remoteJid: SELF, fromMe: true, selfJid: SELF }), SELF);
});

test('avec un groupe : captures et réponses aux commandes y vont', () => {
    botGroup._reset({ groupJid: GROUP });
    assert.equal(botGroup.captureJid(SELF), GROUP);
    assert.equal(botGroup.replyJid({ remoteJid: SELF, fromMe: true, selfJid: SELF }), GROUP);
    assert.equal(botGroup.replyJid({ remoteJid: GROUP, fromMe: true, selfJid: SELF }), GROUP);
});

test('commande d\'un tiers dans son propre chat : on répond là où elle a été envoyée', () => {
    botGroup._reset({ groupJid: GROUP });
    const other = '33698765432@s.whatsapp.net';
    assert.equal(botGroup.replyJid({ remoteJid: other, fromMe: false, selfJid: SELF }), other);
});

test('interrupteurs : désactiver renvoie vers la discussion', () => {
    botGroup._reset({ groupJid: GROUP });
    botGroup.update({ capturesToGroup: false, repliesToGroup: false });
    assert.equal(botGroup.captureJid(SELF), SELF);
    assert.equal(botGroup.replyJid({ remoteJid: SELF, fromMe: true, selfJid: SELF }), SELF);
    assert.equal(botGroup.replyJid({ remoteJid: GROUP, fromMe: true, selfJid: SELF }), GROUP);
});

test('stickers : ajout, doublon, désactivation, suppression, limite', () => {
    const saved = [];
    botGroup._reset({}, async (snap) => { saved.push(snap); });
    const id = botGroup.stickerId(new Uint8Array([1, 2, 3]));
    assert.equal(id, 'AQID');
    assert.deepEqual(botGroup.addSticker(id, Buffer.from('webp')), { added: true });
    assert.deepEqual(botGroup.addSticker(id), { added: false, reason: 'duplicate' });
    assert.equal(botGroup.isTrigger(id), true);
    botGroup.setStickerActive(id, false);
    assert.equal(botGroup.isTrigger(id), false);
    assert.equal(botGroup.removeSticker(id), true);
    assert.equal(botGroup.removeSticker(id), false);
    for (let i = 0; i < botGroup.MAX_STICKERS; i += 1) botGroup.addSticker(`s${i}`);
    assert.deepEqual(botGroup.addSticker('extra'), { added: false, reason: 'full' });
});

test('création : essaie une liste vide puis le compte lui-même', async () => {
    botGroup._reset({});
    const calls = [];
    const socket = {
        user: { id: '33612345678:4@s.whatsapp.net' },
        async groupCreate(subject, participants) {
            calls.push(participants);
            if (!participants.length) throw new Error('bad-request');
            return { id: GROUP };
        },
        async sendMessage() {},
    };
    assert.equal(await botGroup.ensureGroup(socket), GROUP);
    assert.deepEqual(calls, [[], [SELF]]);
    assert.equal(botGroup.get().groupJid, GROUP);
});

test('groupe supprimé côté WhatsApp : il est recréé, une erreur réseau ne recrée rien', async () => {
    botGroup._reset({ groupJid: GROUP });
    const created = [];
    const socket = {
        user: { id: '33612345678:4@s.whatsapp.net' },
        async groupMetadata() { throw new Error('item-not-found'); },
        async groupCreate() { created.push(1); return { id: '120363000000000002@g.us' }; },
        async sendMessage() {},
    };
    assert.equal(await botGroup.ensureGroup(socket), '120363000000000002@g.us');
    botGroup._reset({ groupJid: GROUP });
    socket.groupMetadata = async () => { throw new Error('timeout'); };
    assert.equal(await botGroup.ensureGroup(socket), GROUP);
    assert.equal(created.length, 1);
});

test('échec de création : erreur explicite', async () => {
    botGroup._reset({});
    const socket = { user: { id: '1:2@s.whatsapp.net' }, async groupCreate() { throw new Error('refusé'); } };
    await assert.rejects(botGroup.ensureGroup(socket), { code: 'create-failed' });
});
