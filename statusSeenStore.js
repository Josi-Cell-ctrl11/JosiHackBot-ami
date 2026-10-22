/** Cache durable des statuts traités, stocké dans une ligne dédiée de whatsapp_auth. */
const { createClient } = require('@supabase/supabase-js');
const config = require('./config.js');

const ROW_ID = 'status_seen_cache';
const TTL_MS = 30 * 60 * 1000;
const LIMIT = 1000;
let supabase = null;
const seen = new Map();
let writeQueue = Promise.resolve();

function getDb() {
    if (!supabase) supabase = createClient(config.supabaseUrl, config.supabaseKey);
    return supabase;
}

function prune(now = Date.now()) {
    for (const [key, at] of seen) if (now - at > TTL_MS) seen.delete(key);
    while (seen.size > LIMIT) seen.delete(seen.keys().next().value);
}

async function load() {
    try {
        const { data, error } = await getDb().from('whatsapp_auth').select('data').eq('id', ROW_ID).maybeSingle();
        if (error) throw error;
        const records = Array.isArray(data?.data?.records) ? data.data.records : [];
        for (const record of records) {
            if (typeof record?.key === 'string' && Number.isFinite(record.at)) seen.set(record.key, record.at);
        }
        prune();
    } catch (e) {
        console.warn('[StatusCache] Restauration échouée:', e.message);
    }
}

function claim(key) {
    prune();
    if (seen.has(key)) return false;
    seen.set(key, Date.now());
    prune();
    writeQueue = writeQueue.then(async () => {
        try {
            const { error } = await getDb().from('whatsapp_auth').upsert(
                { id: ROW_ID, data: { records: [...seen].map(([recordKey, at]) => ({ key: recordKey, at })) } },
                { onConflict: 'id' }
            );
            if (error) throw error;
        } catch (e) {
            console.warn('[StatusCache] Sauvegarde échouée:', e.message);
        }
    });
    return true;
}

module.exports = { load, claim, TTL_MS };
