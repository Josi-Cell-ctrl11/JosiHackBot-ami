'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function loadWithBaileysStub(request, parent, isMain) {
    if (request === '@whiskeysockets/baileys') {
        return {
            BufferJSON: {
                replacer: (_key, value) => value,
                reviver: (_key, value) => value,
            },
            initAuthCreds: () => ({ registered: false, lid: null, lidDeviceID: null }),
            proto: {
                Message: {
                    AppStateSyncKeyData: { fromObject: (value) => value },
                },
            },
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const createAuthState = require('../supabaseAuth');
Module._load = originalLoad;

function makeSupabase(seed = []) {
    const rows = new Map(seed.map((row) => [row.id, row]));
    const calls = { selects: [], upserts: [], deletes: [], likes: [], equals: [] };

    return {
        calls,
        from(table) {
            const query = {
                action: null,
                filter: null,
                select(columns) {
                    this.action = 'select';
                    calls.selects.push({ table, columns });
                    return this;
                },
                eq(column, value) {
                    this.filter = { column, value };
                    if (this.action === 'delete') {
                        calls.equals.push({ table, column, value });
                        rows.delete(value);
                        return Promise.resolve({ error: null });
                    }
                    return this;
                },
                like(column, pattern) {
                    calls.likes.push({ table, column, pattern });
                    const prefix = pattern.slice(0, -1);
                    for (const id of rows.keys()) {
                        if (id.startsWith(prefix)) rows.delete(id);
                    }
                    return Promise.resolve({ error: null });
                },
                maybeSingle() {
                    const row = rows.get(this.filter.value) || null;
                    return Promise.resolve({ data: row, error: null });
                },
                in(column, ids) {
                    if (this.action === 'delete') {
                        calls.deletes.push({ table, ids: [...ids] });
                        ids.forEach((id) => rows.delete(id));
                        return Promise.resolve({ error: null });
                    }
                    return Promise.resolve({
                        data: ids.map((id) => rows.get(id)).filter(Boolean),
                        error: null,
                    });
                },
                delete() {
                    this.action = 'delete';
                    return this;
                },
                upsert(values, options) {
                    const batch = Array.isArray(values) ? values : [values];
                    calls.upserts.push({ table, rows: batch, options });
                    batch.forEach((row) => rows.set(row.id, row));
                    return Promise.resolve({ error: null });
                },
            };
            return query;
        },
    };
}

const seedCreds = { id: 'creds', data: { registered: false, lid: null, lidDeviceID: null } };

test('keys.set regroupe les écritures et suppressions en lots de 100', async () => {
    const supabase = makeSupabase([seedCreds]);
    const { state } = await createAuthState(supabase);
    const entries = {};
    for (let i = 0; i < 450; i += 1) {
        entries[`k${i}`] = i % 2 === 0 ? { value: i } : null;
    }

    await state.keys.set({ 'pre-key': entries });

    assert.deepEqual(supabase.calls.upserts.map((call) => call.rows.length), [100, 100, 25]);
    assert.deepEqual(supabase.calls.deletes.map((call) => call.ids.length), [100, 100, 25]);
    assert.ok(supabase.calls.upserts.every((call) => call.options.onConflict === 'id'));
});

test('keys.get lit les identifiants en lots et conserve null pour les clés absentes', async () => {
    const seed = [seedCreds];
    for (let i = 0; i < 225; i += 1) {
        if (i % 3 !== 0) seed.push({ id: `pre-key-k${i}`, data: { value: i } });
    }
    const supabase = makeSupabase(seed);
    const { state } = await createAuthState(supabase);
    const ids = Array.from({ length: 225 }, (_unused, i) => `k${i}`);

    const values = await state.keys.get('pre-key', ids);

    assert.equal(values.k0, null);
    assert.deepEqual(values.k1, { value: 1 });
    assert.equal(values.k3, null);
    assert.deepEqual(values.k224, { value: 224 });
    assert.equal(supabase.calls.selects.filter((call) => call.columns === 'id,data').length, 3);
});

test('wipeAuthTable supprime par préfixe sans balayer ni effacer les autres lignes', async () => {
    const supabase = makeSupabase([
        seedCreds,
        { id: 'pre-key-1', data: {} },
        { id: 'app-state-sync-key-1', data: {} },
        { id: 'chat-history', data: {} },
        { id: 'status-settings', data: {} },
    ]);

    await createAuthState.wipeAuthTable(supabase);

    assert.equal(supabase.calls.selects.length, 0);
    assert.deepEqual(supabase.calls.equals.map((call) => call.value), ['creds']);
    assert.deepEqual(supabase.calls.likes.map((call) => call.pattern), [
        'app-state-sync-key%',
        'session%',
        'pre-key%',
        'sender-key%',
    ]);
});
