'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const airplane = require('../airplane');

function makeSocket(log, privacy = { last: 'contacts', online: 'all' }) {
    return {
        user: { id: '33612345678:1@s.whatsapp.net' },
        async fetchPrivacySettings() { return privacy; },
        async updateLastSeenPrivacy(v) { log.push(['last', v]); },
        async updateOnlinePrivacy(v) { log.push(['online', v]); },
        async sendPresenceUpdate(v) { log.push(['presence', v]); },
    };
}

test('activer : présence indisponible et confidentialité masquée', async () => {
    airplane._reset({});
    const log = [];
    assert.equal(await airplane.set(makeSocket(log), true), true);
    assert.deepEqual(log, [['last', 'none'], ['online', 'match_last_seen'], ['presence', 'unavailable']]);
    airplane._reset({});
});

test('couper : remet les valeurs d\'origine', async () => {
    airplane._reset({});
    const log = [];
    const socket = makeSocket(log, { last: 'contact_blacklist', online: 'all' });
    await airplane.set(socket, true);
    log.length = 0;
    assert.equal(await airplane.set(socket, false), false);
    assert.deepEqual(log, [['last', 'contact_blacklist'], ['online', 'all']]);
});

test('activer deux fois ne change pas les valeurs mémorisées', async () => {
    airplane._reset({});
    const log = [];
    const socket = makeSocket(log);
    await airplane.set(socket, true);
    log.length = 0;
    await airplane.set(socket, true);
    assert.deepEqual(log, []);
    airplane._reset({});
});

test('sans connexion WhatsApp : erreur explicite', async () => {
    airplane._reset({});
    await assert.rejects(airplane.set(null, true), { code: 'offline' });
});
