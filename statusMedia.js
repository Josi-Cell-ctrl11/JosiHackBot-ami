'use strict';

/**
 * Médias des statuts reçus, pour la liste, la prévisualisation et le
 * téléchargement dans l'app.
 *
 * Le bot garde le message brut de chaque statut (clé + contenu, quelques ko) et
 * ne télécharge le média qu'à la demande. Les médias téléchargés vont dans un
 * cache mémoire borné en octets : le service Render a peu de RAM.
 * Limite par média : 10 Mo, comme pour Discussions.
 */

const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const CACHE_BUDGET_BYTES = 48 * 1024 * 1024;
const MAX_REMEMBERED = 100;

const MIME_BY_TYPE = {
    image: 'image/jpeg',
    video: 'video/mp4',
    audio: 'audio/ogg',
};

const messages = new Map(); // statusId -> message brut
const cache = new Map(); // statusId -> { buffer, mime }
let cacheBytes = 0;
const inflight = new Map();

function remember(id, msg) {
    if (!id || !msg) return;
    messages.delete(id);
    messages.set(id, msg);
    while (messages.size > MAX_REMEMBERED) {
        const oldest = messages.keys().next().value;
        messages.delete(oldest);
        drop(oldest);
    }
}

function drop(id) {
    const hit = cache.get(id);
    if (!hit) return;
    cacheBytes -= hit.buffer.length;
    cache.delete(id);
}

function store(id, buffer, mime) {
    drop(id);
    cache.set(id, { buffer, mime });
    cacheBytes += buffer.length;
    while (cacheBytes > CACHE_BUDGET_BYTES && cache.size > 1) {
        drop(cache.keys().next().value);
    }
}

function getMessage(id) {
    return messages.get(id) || null;
}

/** Contenu média d'un statut : { type, sub } ou null pour un statut texte. */
function container(msg) {
    const m = msg?.message || {};
    const inner = m.imageWithCaptionMessage?.message || m;
    for (const key of ['imageMessage', 'videoMessage', 'audioMessage']) {
        if (inner[key]) return { type: key.replace('Message', ''), sub: inner[key] };
    }
    return null;
}

/** Texte d'un statut texte, ou légende d'un média. */
function textOf(msg) {
    const m = msg?.message || {};
    const inner = m.imageWithCaptionMessage?.message || m;
    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        inner.imageMessage?.caption ||
        inner.videoMessage?.caption ||
        ''
    );
}

/**
 * Renvoie { buffer, mime } ou lève une erreur avec un `code` exploitable par l'API :
 * not-found, no-media, too-large, download-failed.
 */
async function fetchMedia(id, download) {
    const msg = messages.get(id);
    if (!msg) throw Object.assign(new Error('statut introuvable'), { code: 'not-found' });
    const hit = cache.get(id);
    if (hit) return hit;
    const mc = container(msg);
    if (!mc) throw Object.assign(new Error('ce statut n\'a pas de média'), { code: 'no-media' });
    const declared = Number(mc.sub.fileLength || 0);
    if (declared > MAX_MEDIA_BYTES) {
        throw Object.assign(new Error('média de plus de 10 Mo'), { code: 'too-large' });
    }
    if (inflight.has(id)) return inflight.get(id);
    const job = (async () => {
        let buffer;
        try {
            buffer = await download(msg);
        } catch (e) {
            throw Object.assign(new Error(e?.message || 'téléchargement impossible'), { code: 'download-failed' });
        }
        if (!buffer || !buffer.length) {
            throw Object.assign(new Error('média vide'), { code: 'download-failed' });
        }
        if (buffer.length > MAX_MEDIA_BYTES) {
            throw Object.assign(new Error('média de plus de 10 Mo'), { code: 'too-large' });
        }
        const mime = mc.sub.mimetype || MIME_BY_TYPE[mc.type] || 'application/octet-stream';
        store(id, buffer, mime);
        return { buffer, mime };
    })().finally(() => inflight.delete(id));
    inflight.set(id, job);
    return job;
}

module.exports = {
    MAX_MEDIA_BYTES,
    remember,
    getMessage,
    container,
    textOf,
    fetchMedia,
    _cacheBytes: () => cacheBytes,
};
