/**
 * Persistance des réglages du like de statuts.
 *
 * Ces réglages vivaient uniquement dans botState, donc en mémoire : chaque
 * redéploiement Render — ou plus simplement chaque redémarrage du service —
 * remettait l'auto-like à son valeur par défaut et effaçait l'emoji choisi.
 * Sur mobile c'est le genre de réglage qu'on règle une fois et qu'on ne
 *_parameterise plus jamais.
 *
 * Même modèle que statusSeenStore : une ligne dédiée dans whatsapp_auth, dont
 * la colonne `data` (jsonb) porte l'objet de réglages.
 */
const { createClient } = require('@supabase/supabase-js');
const config = require('./config.js');

const ROW_ID = 'status_settings';

let supabase = null;

// Champs persistés, avec leur valeur par défaut. La liste sert aussi de filtre
// : rien d'autre ne doit atterrir en base.
//
// Les valeurs par défaut doivent rester identiques à celles de botState.js.
// Comme load() renvoie FIELDS quand la ligne n'existe pas encore, une divergence
// ici remplacerait les vrais seuils de délai par d'autres au premier démarrage.
const FIELDS = {
    isActivelyLiking: true,
    isViewOnly: false,
    fixedEmoji: null,
    statusDelayMode: 'random',
    statusDelayMin: 2000,
    statusDelayMax: 6000,
    statusDelayFixed: 3000,
};

let settings = { ...FIELDS };
let loaded = false;
let writeQueue = Promise.resolve();

function getDb() {
    if (!supabase) supabase = createClient(config.supabaseUrl, config.supabaseKey);
    return supabase;
}

/** Ne conserve que les champs connus, avec le bon type. */
function sanitize(patch = {}) {
    const out = {};
    for (const [key, fallback] of Object.entries(FIELDS)) {
        if (patch[key] === undefined) continue;
        const value = patch[key];
        if (typeof fallback === 'boolean') out[key] = !!value;
        else if (typeof fallback === 'number') {
            const num = Number(value);
            if (Number.isFinite(num)) out[key] = num;
        } else out[key] = value === null ? null : String(value);
    }
    return out;
}

/** Lit la ligne et renvoie les réglages. Silencieux : un échec réseau ne doit pas
 *  empêcher le bot de démarrer, il repart alors des valeurs par défaut. */
async function load() {
    if (loaded) return { ...settings };
    try {
        const { data, error } = await getDb()
            .from('whatsapp_auth')
            .select('data')
            .eq('id', ROW_ID)
            .maybeSingle();
        if (error) throw error;
        settings = { ...FIELDS, ...sanitize(data?.data || {}) };
        loaded = true;
        console.log(`[StatusSettings] Réglages restaurés : like=${settings.isActivelyLiking} vue=${settings.isViewOnly} emoji=${settings.fixedEmoji || 'aléatoire'}`);
    } catch (e) {
        console.warn('[StatusSettings] Restauration échouée:', e.message);
    }
    return { ...settings };
}

/** Applique un correctif en mémoire puis l'écrit. Les écritures sont sérialisées
 *  pour éviter deux upserts concurrents sur la même ligne. */
function save(patch) {
    const clean = sanitize(patch);
    if (!Object.keys(clean).length) return { ...settings };
    settings = { ...settings, ...clean };
    const snapshot = { ...settings };
    writeQueue = writeQueue.then(async () => {
        try {
            const { error } = await getDb().from('whatsapp_auth').upsert(
                { id: ROW_ID, data: snapshot },
                { onConflict: 'id' }
            );
            if (error) throw error;
        } catch (e) {
            console.warn('[StatusSettings] Sauvegarde échouée:', e.message);
        }
    });
    return { ...settings };
}

/** État courant, sans lecture réseau. */
function get() {
    return { ...settings };
}

module.exports = { load, save, get, ROW_ID };