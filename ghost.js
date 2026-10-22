'use strict';

/**
 * Mode fantôme : le bot ne renvoie plus d'accusé de réception (« message
 * distribué ») pour les messages que tu reçois.
 *
 * Baileys en envoie un tout seul pour chaque message entrant. Un correctif
 * (scripts/patch-baileys.js, lancé à l'installation) lui fait consulter
 * `globalThis.__josiSkipReceipt` avant d'envoyer. Ici on tient ce réglage.
 *
 * Activé, le mode combine :
 *   - plus d'accusé de livraison envoyé par le bot;
 *   - le mode avion (présence indisponible, dernière connexion masquée).
 * Les accusés de lecture ne sont jamais envoyés par le bot, sauf pour la
 * commande de vue unique qui en a besoin.
 *
 * Limite : le téléphone envoie ses propres accusés tant qu'il a internet.
 *
 * Réglage persisté dans une ligne dédiée de whatsapp_auth.
 */

const ROW_ID = 'ghost_mode';

let state = { enabled: false };
let persist = defaultPersist;
let loaded = false;
let supabase = null;
let writeQueue = Promise.resolve();
let patchedCheck = null; // remplaçable dans les tests

function getDb() {
    if (!supabase) {
        const { createClient } = require('@supabase/supabase-js');
        const config = require('./config.js');
        supabase = createClient(config.supabaseUrl, config.supabaseKey);
    }
    return supabase;
}

async function defaultPersist(snapshot) {
    const { error } = await getDb().from('whatsapp_auth').upsert(
        { id: ROW_ID, data: snapshot },
        { onConflict: 'id' },
    );
    if (error) throw error;
}

function save() {
    const snapshot = { ...state };
    writeQueue = writeQueue.then(async () => {
        try {
            await persist(snapshot);
        } catch (e) {
            console.warn('[Fantôme] Sauvegarde échouée:', e.message);
        }
    });
    return writeQueue;
}

function isEnabled() {
    return state.enabled;
}

/** Branche le réglage sur le correctif de Baileys. */
function install() {
    globalThis.__josiSkipReceipt = () => state.enabled;
}

/** Vrai si le correctif de Baileys est bien présent dans la bibliothèque installée. */
function isPatched() {
    if (patchedCheck) return patchedCheck();
    try {
        const fs = require('fs');
        const path = require.resolve('@whiskeysockets/baileys');
        const file = path.replace(/lib[\\/]index\.js$/, 'lib/Socket/messages-recv.js');
        return fs.readFileSync(file, 'utf8').includes('__josiSkipReceipt');
    } catch (_) {
        return false;
    }
}

async function load() {
    install();
    if (loaded) return isEnabled();
    try {
        const { data, error } = await getDb().from('whatsapp_auth').select('data').eq('id', ROW_ID).maybeSingle();
        if (error) throw error;
        state = { enabled: data?.data?.enabled === true };
        loaded = true;
        console.log(`[Fantôme] Restauré : ${state.enabled ? 'actif' : 'inactif'} (correctif Baileys ${isPatched() ? 'présent' : 'ABSENT'})`);
    } catch (e) {
        console.warn('[Fantôme] Restauration échouée:', e.message);
    }
    return isEnabled();
}

/**
 * Active ou coupe le mode. `airplane` est le module du mode avion, passé en
 * paramètre pour pouvoir le simuler dans les tests.
 */
async function set(socket, enabled, airplane, getSocket) {
    install();
    if (enabled) {
        if (!isPatched()) {
            throw Object.assign(
                new Error('Correctif Baileys absent : relance l\'installation du serveur (npm install).'),
                { code: 'not-patched' },
            );
        }
        await airplane.set(socket, true, getSocket);
        state = { enabled: true };
    } else {
        state = { enabled: false };
        await airplane.set(socket, false, getSocket);
    }
    await save();
    return state.enabled;
}

module.exports = {
    load,
    install,
    isEnabled,
    isPatched,
    set,
    _reset(next = {}, fn, patched = null) {
        state = { enabled: next.enabled === true };
        persist = fn || (async () => {});
        patchedCheck = patched;
        loaded = true;
        install();
    },
};
