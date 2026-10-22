'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sendStatusReaction } = require('../statusReaction');

const logger = { info() {}, warn() {} };

function makeSocket(sendMessage, overrides = {}) {
    return {
        user: { id: '229600000001:1@s.whatsapp.net', lid: '880000000001@lid', ...overrides.user },
        signalRepository: overrides.signalRepository,
        sendMessage,
    };
}

test('résout un auteur LID et réessaie une audience PN/LID si WhatsApp refuse la première', async () => {
    const status = {
        key: {
            remoteJid: 'status@broadcast',
            id: 'status-1',
            participant: '880000000099@lid',
        },
    };
    const calls = [];
    const socket = makeSocket(async (...args) => {
        calls.push(args);
        if (calls.length === 1) throw new Error('audience PN rejetée');
        return {};
    }, {
        signalRepository: {
            lidMapping: {
                getPNForLID: async () => '229600000099@s.whatsapp.net',
            },
        },
    });

    const result = await sendStatusReaction(socket, status, '❤️', { logger });

    assert.equal(result, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], 'status@broadcast');
    assert.deepEqual(calls[0][2].statusJidList, [
        '229600000099@s.whatsapp.net',
        '229600000001:1@s.whatsapp.net',
    ]);
    assert.deepEqual(calls[1][2].statusJidList, [
        '880000000099@lid',
        '229600000001:1@s.whatsapp.net',
    ]);
    assert.strictEqual(calls[1][1].react.key, status.key);
});

test('utilise remoteJidAlt quand participant est absent', async () => {
    const status = {
        key: {
            remoteJid: 'status@broadcast',
            id: 'status-2',
            remoteJidAlt: '229600000002@s.whatsapp.net',
        },
    };
    let audience;
    const socket = makeSocket(async (_jid, _message, options) => {
        audience = options.statusJidList;
    });

    await sendStatusReaction(socket, status, '💙', { logger });

    assert.deepEqual(audience, [
        '229600000002@s.whatsapp.net',
        '229600000001:1@s.whatsapp.net',
    ]);
});

test('force fromMe pour son propre statut et garde la clé autrement intacte', async () => {
    const status = {
        key: {
            remoteJid: 'status@broadcast',
            id: 'status-own',
            participant: '229600000001:1@s.whatsapp.net',
            fromMe: false,
        },
    };
    let sentKey;
    const socket = makeSocket(async (_jid, message) => {
        sentKey = message.react.key;
    });

    await sendStatusReaction(socket, status, '❤️', { isOwn: true, logger });

    assert.equal(sentKey.fromMe, true);
    assert.equal(sentKey.remoteJid, 'status@broadcast');
    assert.equal(status.key.fromMe, false);
});

test('retourne une erreur utile si aucune audience ne fonctionne', async () => {
    const status = {
        key: {
            remoteJid: 'status@broadcast',
            id: 'status-fail',
            participant: '229600000099@s.whatsapp.net',
        },
    };
    const socket = makeSocket(async () => { throw new Error('not-authorized'); });

    await assert.rejects(
        sendStatusReaction(socket, status, '❤️', { logger }),
        /WhatsApp a refusé le like après 2 tentative\(s\): not-authorized/,
    );
});

test('refuse une clé/auteur absent sans tenter d’envoyer', async () => {
    let calls = 0;
    const socket = makeSocket(async () => { calls += 1; });

    await assert.rejects(
        sendStatusReaction(socket, { key: { id: 'status-no-author' } }, '❤️', { logger }),
        /auteur ou audience du statut introuvable/,
    );
    assert.equal(calls, 0);
});

test('retirer une réaction renvoie un texte vide au lieu de refuser', async () => {
    const calls = [];
    const socket = makeSocket(async (...args) => { calls.push(args); return {}; });
    const status = { key: { remoteJid: 'status@broadcast', id: 's-9', participant: '229600000099@s.whatsapp.net' } };
    await sendStatusReaction(socket, status, '', { logger, remove: true });
    assert.equal(calls[0][1].react.text, '');
    await assert.rejects(sendStatusReaction(socket, status, '', { logger }), /emoji de like invalide/);
});
