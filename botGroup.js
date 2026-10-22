'use strict';

/**
 * Groupe privé « JosiHackBot » et stickers déclencheurs.
 *
 * Le groupe ne contient que le compte de l'utilisateur. Les captures de vues
 * uniques (vv2, nice, capture automatique) et les réponses aux commandes y
 * arrivent à la place de la discussion avec soi-même.
 *
 * Les stickers déclencheurs sont identifiés par leur empreinte (fileSha256) :
 * répondre à une vue unique avec l'un d'eux la capture, sans rien écrire.
 *
 * Réglages persistés dans une ligne dédiée de whatsapp_auth, comme
 * statusSettingsStore.
 */

const ROW_ID = 'bot_group';
const GROUP_SUBJECT = 'JosiHackBot';
const MAX_STICKERS = 8;
const MAX_STICKER_PREVIEW_BYTES = 150 * 1024;

const DEFAULTS = {
    groupJid: null,
    repliesToGroup: true,
    capturesToGroup: true,
    stickers: [], // { id (sha256 base64), preview (webp base64), active, addedAt }
};

let state = { ...DEFAULTS, stickers: [] };
let persist = defaultPersist;
let loaded = false;
let writeQueue = Promise.resolve();
let supabase = null;

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

function sanitizeStickers(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const s of list) {
        if (!s || typeof s.id !== 'string' || !s.id) continue;
        if (out.some((x) => x.id === s.id)) continue;
        out.push({
            id: s.id,
            preview: typeof s.preview === 'string' ? s.preview : null,
            active: s.active !== false,
            addedAt: Number.isFinite(s.addedAt) ? s.addedAt : Date.now(),
        });
        if (out.length >= MAX_STICKERS) break;
    }
    return out;
}

function sanitize(data = {}) {
    return {
        groupJid: typeof data.groupJid === 'string' && data.groupJid.endsWith('@g.us') ? data.groupJid : null,
        repliesToGroup: data.repliesToGroup !== false,
        capturesToGroup: data.capturesToGroup !== false,
        stickers: sanitizeStickers(data.stickers),
    };
}

async function load() {
    if (loaded) return get();
    try {
        const { data, error } = await getDb().from('whatsapp_auth').select('data').eq('id', ROW_ID).maybeSingle();
        if (error) throw error;
        state = sanitize(data?.data || {});
        loaded = true;
        console.log(`[BotGroup] Restauré : groupe=${state.groupJid || 'aucun'} stickers=${state.stickers.length}`);
    } catch (e) {
        console.warn('[BotGroup] Restauration échouée:', e.message);
    }
    return get();
}

function save() {
    const snapshot = JSON.parse(JSON.stringify(state));
    writeQueue = writeQueue.then(async () => {
        try {
            await persist(snapshot);
        } catch (e) {
            console.warn('[BotGroup] Sauvegarde échouée:', e.message);
        }
    });
    return writeQueue;
}

function get() {
    return JSON.parse(JSON.stringify(state));
}

/** Version pour l'app : sans le contenu des aperçus trop lourds pour une liste. */
function publicState() {
    const s = get();
    return {
        groupJid: s.groupJid,
        exists: !!s.groupJid,
        subject: GROUP_SUBJECT,
        repliesToGroup: s.repliesToGroup,
        capturesToGroup: s.capturesToGroup,
        stickers: s.stickers.map(({ id, preview, active }) => ({ id, preview, active })),
        maxStickers: MAX_STICKERS,
    };
}

function update(patch = {}) {
    if (patch.repliesToGroup !== undefined) state.repliesToGroup = !!patch.repliesToGroup;
    if (patch.capturesToGroup !== undefined) state.capturesToGroup = !!patch.capturesToGroup;
    save();
    return publicState();
}

/** Où envoyer une capture : le groupe si activé et créé, sinon `fallback`. */
function captureJid(fallback) {
    return state.capturesToGroup && state.groupJid ? state.groupJid : fallback;
}

/** Où répondre à une commande de l'utilisateur. */
function replyJid({ remoteJid, fromMe, selfJid }) {
    if (state.groupJid && remoteJid === state.groupJid) return remoteJid;
    if (fromMe && state.repliesToGroup && state.groupJid) return state.groupJid;
    return fromMe ? selfJid : remoteJid;
}

function isGroup(jid) {
    return !!state.groupJid && jid === state.groupJid;
}

// ── Stickers ────────────────────────────────────────────────────────────────

function stickerId(fileSha256) {
    if (!fileSha256) return null;
    try {
        return Buffer.from(fileSha256).toString('base64');
    } catch (_) {
        return null;
    }
}

function isTrigger(id) {
    return !!id && state.stickers.some((s) => s.id === id && s.active);
}

/** Ajoute un sticker. Renvoie { added, reason } (reason : full | duplicate | invalid). */
function addSticker(id, previewBuffer) {
    if (!id) return { added: false, reason: 'invalid' };
    if (state.stickers.some((s) => s.id === id)) return { added: false, reason: 'duplicate' };
    if (state.stickers.length >= MAX_STICKERS) return { added: false, reason: 'full' };
    const preview = previewBuffer && previewBuffer.length <= MAX_STICKER_PREVIEW_BYTES
        ? Buffer.from(previewBuffer).toString('base64')
        : null;
    state.stickers.push({ id, preview, active: true, addedAt: Date.now() });
    save();
    return { added: true };
}

function setStickerActive(id, active) {
    const s = state.stickers.find((x) => x.id === id);
    if (!s) return false;
    s.active = !!active;
    save();
    return true;
}

function removeSticker(id) {
    const before = state.stickers.length;
    state.stickers = state.stickers.filter((s) => s.id !== id);
    if (state.stickers.length === before) return false;
    save();
    return true;
}

// ── Création du groupe ──────────────────────────────────────────────────────

function groupIsGone(err) {
    return /item-not-found|not-authorized|forbidden|\b40[34]\b|not.in.group/i.test(String(err?.message || err || ''));
}

/**
 * S'assure que le groupe existe et le renvoie. `recreate` en force un nouveau.
 * WhatsApp accepte rarement un groupe sans autre participant : on tente d'abord
 * une liste vide, puis le compte lui-même.
 */
async function ensureGroup(socket, { recreate = false } = {}) {
    const selfJid = (socket?.user?.id || '').split(':')[0] + '@s.whatsapp.net';
    if (!socket?.user?.id) throw Object.assign(new Error('WhatsApp non connecté'), { code: 'offline' });

    if (!recreate && state.groupJid) {
        try {
            await socket.groupMetadata(state.groupJid);
            return state.groupJid;
        } catch (e) {
            if (!groupIsGone(e)) return state.groupJid;
            console.warn('[BotGroup] Groupe introuvable, recréation:', e?.message || e);
        }
    }

    const previous = state.groupJid;
    if (recreate && previous) {
        try { await socket.groupLeave(previous); } catch (_) { /* déjà quitté */ }
    }

    let created = null;
    let lastError = null;
    for (const participants of [[], [selfJid]]) {
        try {
            created = await socket.groupCreate(GROUP_SUBJECT, participants);
            if (created?.id) break;
        } catch (e) {
            lastError = e;
        }
    }
    if (!created?.id) {
        throw Object.assign(
            new Error(`WhatsApp a refusé de créer le groupe : ${lastError?.message || 'réponse vide'}`),
            { code: 'create-failed' },
        );
    }
    state.groupJid = created.id;
    await save();
    try {
        await socket.sendMessage(created.id, {
            text: 'Groupe créé. Les réponses du bot et les vues uniques capturées arrivent ici.',
        });
    } catch (_) { /* message d'accueil facultatif */ }
    return created.id;
}

module.exports = {
    GROUP_SUBJECT,
    MAX_STICKERS,
    load,
    get,
    publicState,
    update,
    captureJid,
    replyJid,
    isGroup,
    stickerId,
    isTrigger,
    addSticker,
    setStickerActive,
    removeSticker,
    ensureGroup,
    _reset(next = {}, fn) {
        state = sanitize(next);
        persist = fn || (async () => {});
        loaded = true;
    },
};
