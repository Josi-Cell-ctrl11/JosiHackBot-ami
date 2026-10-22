'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const antiDelete = require('../antidelete');
const botGroup = require('../botGroup');

function makeSock(sent) {
    return {
        user: { id: '33612345678:1@s.whatsapp.net' },
        async sendMessage(jid, content) { sent.push([jid, content]); },
    };
}

const original = {
    key: { id: 'A1', remoteJid: '120363000000000001@g.us', participant: '33699999999@s.whatsapp.net', fromMe: false },
    pushName: 'Léo',
    messageTimestamp: 1760000000,
    message: { conversation: 'rdv à 18h' },
};

const editEvent = (text, fromMe = false) => ({
    key: { id: 'A1', remoteJid: original.key.remoteJid, fromMe },
    update: { message: { editedMessage: { message: { conversation: text } } } },
});

test('modification : l\'ancienne et la nouvelle version vont dans le groupe privé', async () => {
    antiDelete._reset();
    botGroup._reset({ groupJid: '120363111111111111@g.us', capturesToGroup: true });
    const sent = [];
    const sock = makeSock(sent);
    await antiDelete.handleUpsert(sock, { messages: [original] });
    await antiDelete.handleUpdate(sock, [editEvent('rdv à 19h')]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], '120363111111111111@g.us');
    assert.match(sent[0][1].text, /MESSAGE MODIFIÉ/);
    assert.match(sent[0][1].text, /Avant:\* rdv à 18h/);
    assert.match(sent[0][1].text, /Après:\* rdv à 19h/);
    assert.match(sent[0][1].text, /Léo/);
});

test('sans groupe privé : discussion avec soi-même', async () => {
    antiDelete._reset();
    botGroup._reset({});
    const sent = [];
    const sock = makeSock(sent);
    await antiDelete.handleUpsert(sock, { messages: [original] });
    await antiDelete.handleUpdate(sock, [editEvent('rdv à 19h')]);
    assert.equal(sent[0][0], '33612345678@s.whatsapp.net');
});

test('le même événement reçu deux fois n\'envoie qu\'un rapport', async () => {
    antiDelete._reset();
    botGroup._reset({});
    const sent = [];
    const sock = makeSock(sent);
    await antiDelete.handleUpsert(sock, { messages: [original] });
    await antiDelete.handleUpdate(sock, [editEvent('rdv à 19h')]);
    await antiDelete.handleUpsert(sock, { messages: [{
        key: { id: 'E9', remoteJid: original.key.remoteJid, fromMe: false },
        message: { protocolMessage: { type: 14, key: { id: 'A1' }, editedMessage: { conversation: 'rdv à 19h' } } },
    }] });
    assert.equal(sent.length, 1);
});

test('deux modifications de suite : chacune se compare à la précédente', async () => {
    antiDelete._reset();
    botGroup._reset({});
    const sent = [];
    const sock = makeSock(sent);
    await antiDelete.handleUpsert(sock, { messages: [original] });
    await antiDelete.handleUpdate(sock, [editEvent('rdv à 19h')]);
    await antiDelete.handleUpdate(sock, [editEvent('rdv à 20h')]);
    assert.equal(sent.length, 2);
    assert.match(sent[1][1].text, /Avant:\* rdv à 19h/);
    assert.match(sent[1][1].text, /Après:\* rdv à 20h/);
});

test('ses propres modifications sont ignorées', async () => {
    antiDelete._reset();
    botGroup._reset({});
    const sent = [];
    const sock = makeSock(sent);
    await antiDelete.handleUpsert(sock, { messages: [original] });
    await antiDelete.handleUpdate(sock, [editEvent('rdv à 19h', true)]); // modifié par moi
    assert.equal(sent.length, 0);
});

test('original perdu au redémarrage : retrouvé dans l\'historique des discussions', async () => {
    antiDelete._reset();
    botGroup._reset({});
    antiDelete.setHistoryLookup((chatId, id) => (
        id === 'A1' ? { chatId, text: 'rdv à 18h', name: 'Léo' } : null
    ));
    const sent = [];
    const sock = makeSock(sent);
    await antiDelete.handleUpdate(sock, [editEvent('rdv à 19h')]); // pas en cache
    assert.equal(sent.length, 1);
    assert.match(sent[0][1].text, /Avant:\* rdv à 18h/);
    assert.match(sent[0][1].text, /Après:\* rdv à 19h/);
    assert.match(sent[0][1].text, /Léo/);
});

test('original introuvable : le rapport part quand même, ancien texte marqué inconnu', async () => {
    antiDelete._reset();
    botGroup._reset({});
    const sent = [];
    const sock = makeSock(sent);
    await antiDelete.handleUpdate(sock, [editEvent('rdv à 19h')]);
    assert.equal(sent.length, 1);
    assert.match(sent[0][1].text, /Avant:\* \(inconnu/);
    assert.match(sent[0][1].text, /Après:\* rdv à 19h/);
});

test('chaque modification apparaît dans la liste de l\'app avec avant et après', async () => {
    antiDelete._reset();
    botGroup._reset({});
    const sock = makeSock([]);
    await antiDelete.handleUpsert(sock, { messages: [original] });
    await antiDelete.handleUpdate(sock, [editEvent('rdv à 19h')]);
    const logs = antiDelete.getLogs();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].type, 'Modifié');
    assert.equal(logs[0].before, 'rdv à 18h');
    assert.equal(logs[0].preview, 'rdv à 19h');
    assert.equal(logs[0].from, 'Léo');
});
