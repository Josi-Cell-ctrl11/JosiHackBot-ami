/**
 * Persistance durable des listes blanche/noire (table Supabase whatsapp_auth).
 * Les listes survivent ainsi aux redémarrages / re-déploiements Render, alors
 * que config.js sur disque est éphémère en environnement hosté.
 */
const { createClient } = require('@supabase/supabase-js');
const config = require('./config.js');

const ROW_ID = 'filters';
let supabase = null;

function getDb() {
    if (!supabase) {
        supabase = createClient(config.supabaseUrl, config.supabaseKey);
    }
    return supabase;
}

/** Lit les listes sauvegardées. Retourne null si jamais rien été sauvegardé. */
async function loadFilters() {
    try {
        const { data, error } = await getDb()
            .from('whatsapp_auth')
            .select('data')
            .eq('id', ROW_ID)
            .maybeSingle();
        if (error || !data || !data.data) return null;
        return {
            whitelist: Array.isArray(data.data.whitelist) ? data.data.whitelist : [],
            blacklist: Array.isArray(data.data.blacklist) ? data.data.blacklist : [],
        };
    } catch (e) {
        console.warn('[Filters] Lecture échouée:', e.message);
        return null;
    }
}

/** Sauvegarde les listes (fire-and-forget côté appelant). */
async function saveFilters(whitelist, blacklist) {
    try {
        await getDb().from('whatsapp_auth').upsert(
            { id: ROW_ID, data: { whitelist, blacklist } },
            { onConflict: 'id' }
        );
    } catch (e) {
        console.warn('[Filters] Sauvegarde échouée:', e.message);
    }
}

module.exports = { loadFilters, saveFilters };