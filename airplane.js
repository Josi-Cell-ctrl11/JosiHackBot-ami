'use strict';

/**
 * Mode avion : le compte donne l'impression de ne jamais être allé sur WhatsApp.
 *
 * Activé, le bot
 *   - se déclare indisponible (présence « unavailable ») dès la connexion puis
 *     toutes les 5 minutes, pour ne jamais apparaître « en ligne »;
 *   - règle « Dernière connexion » sur personne et « En ligne » sur
 *     « comme dernière connexion ». Les valeurs d'origine sont gardées et
 *     remises quand on coupe le mode.
 *
 * Les vues et likes de statuts continuent normalement. Les accusés de lecture
 * du compte ne sont pas touchés : les couper cacherait aussi les vues de
 * statuts. La coche de livraison des messages reçus dépend du téléphone : s'il
 * est connecté, c'est lui qui la renvoie.
 *
 * Réglage persisté dans une ligne dédiée de whatsapp_auth.
 */

const ROW_ID = 'airplane_mode';
const REFRESH_MS = 5 * 60 * 1000;

let state = { enabled: false, previous: null };
let persist = defaultPersist;
let loaded = false;
let supabase = null;
let timer = null;
let writeQueue = Promise.resolve();

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
    const snapshot = JSON.parse(JSON.stringify(state));
    writeQueue = writeQueue.then(async () => {
        try {
            await persist(snapshot);
        } catch (e) {
            console.warn('[Avion] Sauvegarde échouée:', e.message);
        }
    });
    return writeQueue;
}

function sanitize(data = {}) {
    const prev = data.previous;
    return {
        enabled: data.enabled === true,
        previous: prev && typeof prev === 'object'
            ? { last: String(prev.last || 'contacts'), online: String(prev.online || 'all') }
            : null,
    };
}

async function load() {
    if (loaded) return isEnabled();
    try {
        const { data, error } = await getDb().from('whatsapp_auth').select('data').eq('id', ROW_ID).maybeSingle();
        if (error) throw error;
        state = sanitize(data?.data || {});
        loaded = true;
        console.log(`[Avion] Restauré : ${state.enabled ? 'actif' : 'inactif'}`);
    } catch (e) {
        console.warn('[Avion] Restauration échouée:', e.message);
    }
    return isEnabled();
}

function isEnabled() {
    return state.enabled;
}

async function setUnavailable(socket) {
    try {
        await socket.sendPresenceUpdate('unavailable');
    } catch (e) {
        console.warn('[Avion] Présence non envoyée:', e?.message || e);
    }
}

function startTimer(getSocket) {
    stopTimer();
    timer = setInterval(() => {
        const socket = getSocket();
        if (state.enabled && socket?.user?.id) setUnavailable(socket);
    }, REFRESH_MS);
    if (timer.unref) timer.unref();
}

function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
}

/** Applique le mode à un socket connecté (appelé à chaque connexion). */
async function apply(socket, getSocket = () => socket) {
    if (!state.enabled || !socket?.user?.id) return;
    await setUnavailable(socket);
    startTimer(getSocket);
}

/**
 * Active ou coupe le mode. Les réglages de confidentialité sont modifiés ici,
 * une seule fois, avec mémorisation des valeurs d'origine.
 */
async function set(socket, enabled, getSocket = () => socket) {
    if (!socket?.user?.id) throw Object.assign(new Error('WhatsApp non connecté'), { code: 'offline' });
    if (enabled && !state.enabled) {
        let previous = null;
        try {
            const current = await socket.fetchPrivacySettings(true);
            previous = { last: current?.last || 'contacts', online: current?.online || 'all' };
        } catch (_) {
            previous = { last: 'contacts', online: 'all' };
        }
        await socket.updateLastSeenPrivacy('none');
        await socket.updateOnlinePrivacy('match_last_seen');
        state = { enabled: true, previous };
        await save();
        await apply(socket, getSocket);
    } else if (!enabled && state.enabled) {
        const previous = state.previous || { last: 'contacts', online: 'all' };
        stopTimer();
        await socket.updateLastSeenPrivacy(previous.last);
        await socket.updateOnlinePrivacy(previous.online);
        state = { enabled: false, previous: null };
        await save();
    }
    return state.enabled;
}

module.exports = {
    load,
    isEnabled,
    apply,
    set,
    _reset(next = {}, fn) {
        state = sanitize(next);
        persist = fn || (async () => {});
        loaded = true;
        stopTimer();
    },
};
