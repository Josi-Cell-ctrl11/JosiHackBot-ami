'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStatusAudience } = require('../statusAudience');
const { buildStatusContent } = require('../statusPublish');

test('audience : soi, contacts, discussions privées et LID résolus, sans groupes ni doublons', () => {
    const jids = buildStatusAudience({
        self: '33600000000:5@s.whatsapp.net',
        contacts: [{ jid: '33611111111@s.whatsapp.net' }, { jid: '999@lid' }],
        chatIds: ['33611111111@s.whatsapp.net', '33622222222@s.whatsapp.net', '1203@g.us', 'status@broadcast', '1234567890123456@s.whatsapp.net', '777@lid'],
        resolvePn: (j) => (j === '999@lid' ? '33633333333@s.whatsapp.net' : null),
    });
    assert.deepEqual(jids.sort(), [
        '33600000000@s.whatsapp.net',
        '33611111111@s.whatsapp.net',
        '33622222222@s.whatsapp.net',
        '33633333333@s.whatsapp.net',
    ]);
});

test('contenu : texte avec fond, photo et vidéo avec légende', async () => {
    const t = await buildStatusContent({ text: 'yo', backgroundColor: '#fff' });
    assert.deepEqual(t, { content: { text: 'yo' }, options: { backgroundColor: '#fff' } });
    const buf = Buffer.from('x');
    const i = await buildStatusContent({ text: 'cap', media: { type: 'image', buffer: buf } });
    assert.equal(i.content.image, buf);
    assert.equal(i.content.caption, 'cap');
    const v = await buildStatusContent({ text: '', media: { type: 'video', mime: 'video/mp4', buffer: buf } });
    assert.equal(v.content.caption, undefined);
    assert.equal(v.content.mimetype, 'video/mp4');
});

test('contenu : un vocal non OGG est converti, ou envoyé tel quel si la conversion échoue', async () => {
    const buf = Buffer.from('mp3');
    const ok = await buildStatusContent({ backgroundColor: '#123', media: { type: 'audio', mime: 'audio/mpeg', buffer: buf } }, async () => Buffer.from('ogg'));
    assert.equal(ok.content.audio.toString(), 'ogg');
    assert.equal(ok.content.ptt, true);
    assert.equal(ok.options.backgroundColor, '#123');
    const ko = await buildStatusContent({ backgroundColor: '#123', media: { type: 'audio', mime: 'audio/mpeg', buffer: buf } }, async () => { throw new Error('non'); });
    assert.equal(ko.content.audio, buf);
    assert.equal(ko.content.mimetype, 'audio/mpeg');
});
