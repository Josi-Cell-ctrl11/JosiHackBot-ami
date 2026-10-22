/**
 * Persistance durable de l'historique des discussions (table whatsapp_auth).
 * L'onglet Discussions survit ainsi aux redémarrages / re-déploiements Render,
 * contrairement au Map en mémoire qui se vidait à chaque boot.
 */
const { createClient } = require('@supabase/supabase-js');
const config = require('./config.js');

const ROW_ID = 'chat_history';
let supabase = null;

function getDb() {
    if (!supabase) {
        supabase = createClient(config.supabaseUrl, config.supabaseKey);
    }
    return supabase;
}

/** Injection d'un client Supabase factice (tests hors-ligne). */
function _setDb(fake) {
    supabase = fake;
}

/** Lit l'historique sauvegardé. Retourne null si jamais rien été sauvegardé. */
async function loadChatHistory() {
    try {
        const { data, error } = await getDb()
            .from('whatsapp_auth')
            .select('data')
            .eq('id', ROW_ID)
            .maybeSingle();
        if (error || !data || !data.data) return null;
        const chats = data.data.chats;
        if (!chats || typeof chats !== 'object') return null;
        return chats;
    } catch (e) {
        console.warn('[History] Lecture échouée:', e.message);
        return null;
    }
}

/** Sauvegarde l'historique (fire-and-forget côté appelant). */
async function saveChatHistory(chats) {
    try {
        await getDb().from('whatsapp_auth').upsert(
            { id: ROW_ID, data: { chats } },
            { onConflict: 'id' }
        );
    } catch (e) {
        console.warn('[History] Sauvegarde échouée:', e.message);
    }
}

module.exports = { loadChatHistory, saveChatHistory, _setDb };