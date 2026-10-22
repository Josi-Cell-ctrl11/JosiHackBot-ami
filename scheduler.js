'use strict';

/**
 * Messages et statuts programmés.
 *
 * Chaque élément est envoyé par le bot à l'heure choisie. Si le bot était éteint
 * à l'heure prévue, l'envoi part dès son retour pendant GRACE_MS ; passé ce
 * délai l'élément est marqué « missed » et l'utilisateur décide de le renvoyer.
 * Un élément répété (chaque jour, chaque semaine) saute les occurrences
 * ratées sans bruit et passe à la prochaine.
 *
 * Statuts : texte, photo, vidéo ou vocal, visibles par les contacts connus du bot.
 * Le média est gardé à part (par morceaux) pour ne pas alourdir la liste.
 *
 * Réglage persisté dans une ligne dédiée de whatsapp_auth.
 */

const ROW_ID = 'scheduled_items';
const GRACE_MS = 30 * 60 * 1000;
const TICK_MS = 30 * 1000;
const MAX_ATTEMPTS = 3;
const MAX_ITEMS = 100;
const KEEP_DONE_MS = 7 * 24 * 3600 * 1000;
const MAX_MESSAGE = 4096;
const MAX_STATUS = 700;
const MAX_MEDIA = 12 * 1024 * 1024;
const MEDIA_TYPES = ['image', 'video', 'audio'];
const CHUNK = 1500000;
const PERIOD = { daily: 24 * 3600 * 1000, weekly: 7 * 24 * 3600 * 1000 };

/** Fonds proposés dans l'app (indice -> couleur du statut texte). */
const STATUS_COLORS = ['#17814A', '#7B4FD0', '#C23B2A', '#1D6FC4', '#14201A'];

let items = [];
let nextId = 1;
let persist = defaultPersist;
let loaded = false;
let supabase = null;
let writeQueue = Promise.resolve();
let mediaStore = null;
let deps = null;
let timer = null;
let ticking = false;

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

/** Média par défaut : lignes whatsapp_auth `scheduled_media_<id>_<n>`. */
function defaultMediaStore() {
    return {
        async put(id, buf) {
            const b64 = buf.toString('base64');
            const parts = [];
            for (let i = 0; i < b64.length; i += CHUNK) parts.push(b64.slice(i, i + CHUNK));
            const rows = parts.map((data, n) => ({ id: `scheduled_media_${id}_${n}`, data: { n, data } }));
            rows.push({ id: `scheduled_media_${id}_meta`, data: { parts: parts.length } });
            const { error } = await getDb().from('whatsapp_auth').upsert(rows, { onConflict: 'id' });
            if (error) throw error;
        },
        async get(id) {
            const db = getDb();
            const meta = await db.from('whatsapp_auth').select('data').eq('id', `scheduled_media_${id}_meta`).maybeSingle();
            if (meta.error) throw meta.error;
            const count = meta.data?.data?.parts;
            if (!count) throw new Error('média introuvable');
            const ids = Array.from({ length: count }, (_, n) => `scheduled_media_${id}_${n}`);
            const { data, error } = await db.from('whatsapp_auth').select('id,data').in('id', ids);
            if (error) throw error;
            const byId = new Map(data.map((r) => [r.id, r.data.data]));
            return Buffer.from(ids.map((k) => byId.get(k) || '').join(''), 'base64');
        },
        async del(id) {
            const { data } = await getDb().from('whatsapp_auth').select('id').like('id', `scheduled_media_${id}_%`);
            const ids = (data || []).map((r) => r.id);
            if (ids.length) await getDb().from('whatsapp_auth').delete().in('id', ids);
        },
    };
}

function media() {
    if (!mediaStore) mediaStore = defaultMediaStore();
    return mediaStore;
}

function dropMedia(id) {
    media().del(id).catch((e) => console.warn('[Programmation] Nettoyage média échoué:', e.message));
}

function save() {
    const snapshot = JSON.parse(JSON.stringify({ items, nextId }));
    writeQueue = writeQueue.then(async () => {
        try {
            await persist(snapshot);
        } catch (e) {
            console.warn('[Programmation] Sauvegarde échouée:', e.message);
        }
    });
    return writeQueue;
}

function sanitizeItem(raw) {
    if (!raw || (raw.kind !== 'msg' && raw.kind !== 'st')) return null;
    if (!Number.isFinite(raw.id) || !Number.isFinite(raw.ts)) return null;
    const m = raw.media;
    const hasMedia = raw.kind === 'st' && m && MEDIA_TYPES.includes(m.type);
    if (!hasMedia && (typeof raw.text !== 'string' || !raw.text.trim())) return null;
    return {
        id: raw.id,
        kind: raw.kind,
        chatId: raw.kind === 'msg' && typeof raw.chatId === 'string' ? raw.chatId : null,
        chatName: typeof raw.chatName === 'string' ? raw.chatName : '',
        text: typeof raw.text === 'string' ? raw.text : '',
        media: hasMedia
            ? { type: m.type, mime: typeof m.mime === 'string' ? m.mime : '', size: Number(m.size) || 0 }
            : null,
        bg: Number.isInteger(raw.bg) && raw.bg >= 0 && raw.bg < STATUS_COLORS.length ? raw.bg : 0,
        ts: raw.ts,
        repeat: raw.repeat === 'daily' || raw.repeat === 'weekly' ? raw.repeat : 'none',
        state: ['waiting', 'missed', 'sent'].includes(raw.state) ? raw.state : 'waiting',
        attempts: Number.isInteger(raw.attempts) ? raw.attempts : 0,
        error: typeof raw.error === 'string' ? raw.error : null,
        sentAt: Number.isFinite(raw.sentAt) ? raw.sentAt : null,
    };
}

async function load() {
    if (loaded) return list();
    try {
        const { data, error } = await getDb().from('whatsapp_auth').select('data').eq('id', ROW_ID).maybeSingle();
        if (error) throw error;
        const d = data?.data || {};
        items = (Array.isArray(d.items) ? d.items : []).map(sanitizeItem).filter(Boolean);
        nextId = Math.max(Number.isInteger(d.nextId) ? d.nextId : 1, ...items.map((i) => i.id + 1), 1);
        loaded = true;
        console.log(`[Programmation] Restauré : ${items.filter((i) => i.state === 'waiting').length} en attente`);
    } catch (e) {
        console.warn('[Programmation] Restauration échouée:', e.message);
    }
    return list();
}

function list() {
    return JSON.parse(JSON.stringify(items)).sort((a, b) => a.ts - b.ts);
}

/** Crée un élément. Lève une erreur `invalid` si la demande est incorrecte. */
async function add(input = {}, now = Date.now()) {
    const bad = (m) => Object.assign(new Error(m), { code: 'invalid' });
    const kind = input.kind;
    if (kind !== 'msg' && kind !== 'st') throw bad('type inconnu');
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    let mediaBuf = null;
    let mediaMeta = null;
    if (input.media) {
        if (kind !== 'st') throw bad('média réservé aux statuts');
        if (!MEDIA_TYPES.includes(input.media.type)) throw bad('type de média inconnu');
        mediaBuf = Buffer.from(String(input.media.data || ''), 'base64');
        if (!mediaBuf.length) throw bad('média vide');
        if (mediaBuf.length > MAX_MEDIA) throw bad('média trop lourd (12 Mo maximum)');
        mediaMeta = { type: input.media.type, mime: String(input.media.mime || ''), size: mediaBuf.length };
    }
    if (!text && !mediaBuf) throw bad('texte vide');
    if (text.length > (kind === 'st' ? MAX_STATUS : MAX_MESSAGE)) throw bad('texte trop long');
    if (!Number.isFinite(input.ts)) throw bad('heure invalide');
    if (input.ts < now - 60 * 1000) throw bad('heure déjà passée');
    if (kind === 'msg' && (typeof input.chatId !== 'string' || !input.chatId.includes('@'))) {
        throw bad('discussion invalide');
    }
    if (items.length >= MAX_ITEMS) throw bad('trop d\'éléments programmés');
    const item = sanitizeItem({
        id: nextId++,
        kind,
        chatId: input.chatId,
        chatName: String(input.chatName || '').slice(0, 80),
        text,
        media: mediaMeta,
        bg: input.bg,
        ts: Math.round(input.ts),
        repeat: input.repeat,
        state: 'waiting',
    });
    if (mediaBuf) {
        try {
            await media().put(item.id, mediaBuf);
        } catch (e) {
            throw Object.assign(new Error(`média non enregistré : ${e.message}`), { code: 'error' });
        }
    }
    items.push(item);
    save();
    return JSON.parse(JSON.stringify(item));
}

function remove(id) {
    const before = items.length;
    items = items.filter((i) => i.id !== id);
    if (items.length === before) return false;
    dropMedia(id);
    save();
    return true;
}

/** Modifie le texte, l'heure, la répétition ou le fond d'un élément en attente. */
function update(id, patch = {}, now = Date.now()) {
    const bad = (m) => Object.assign(new Error(m), { code: 'invalid' });
    const item = items.find((i) => i.id === id);
    if (!item) throw Object.assign(new Error('introuvable'), { code: 'not-found' });
    if (patch.text !== undefined) {
        const text = typeof patch.text === 'string' ? patch.text.trim() : '';
        if (!text && !item.media) throw bad('texte vide');
        if (text.length > (item.kind === 'st' ? MAX_STATUS : MAX_MESSAGE)) throw bad('texte trop long');
        item.text = text;
    }
    if (patch.ts !== undefined) {
        if (!Number.isFinite(patch.ts)) throw bad('heure invalide');
        if (patch.ts < now - 60 * 1000) throw bad('heure déjà passée');
        item.ts = Math.round(patch.ts);
        // Une nouvelle heure relance un élément manqué.
        if (item.state === 'missed') item.state = 'waiting';
        item.attempts = 0;
        item.error = null;
    }
    if (patch.repeat !== undefined) {
        item.repeat = patch.repeat === 'daily' || patch.repeat === 'weekly' ? patch.repeat : 'none';
    }
    if (patch.bg !== undefined && Number.isInteger(patch.bg) && patch.bg >= 0 && patch.bg < STATUS_COLORS.length) {
        item.bg = patch.bg;
    }
    save();
    return JSON.parse(JSON.stringify(item));
}

function nextOccurrence(item, now) {
    const step = PERIOD[item.repeat];
    let ts = item.ts;
    while (ts <= now) ts += step;
    return ts;
}

async function deliver(item) {
    if (!deps) throw new Error('bot non prêt');
    if (item.kind === 'msg') {
        await deps.sendMessage(item.chatId, item.text);
    } else {
        const status = { text: item.text, backgroundColor: STATUS_COLORS[item.bg] };
        if (item.media) {
            status.media = { ...item.media, buffer: await media().get(item.id) };
        }
        await deps.sendStatus(status);
    }
}

/** Passe en revue les éléments échus. Renvoie le nombre d'envois réussis. */
async function tick(now = Date.now()) {
    if (ticking || !deps) return 0;
    if (deps.isConnected && !deps.isConnected()) return 0;
    ticking = true;
    let sent = 0;
    let changed = false;
    try {
        for (const item of items) {
            if (item.state !== 'waiting' || item.ts > now) continue;
            if (now - item.ts > GRACE_MS) {
                if (item.repeat !== 'none') item.ts = nextOccurrence(item, now);
                else item.state = 'missed';
                changed = true;
                continue;
            }
            try {
                await deliver(item);
                sent++;
                item.error = null;
                item.attempts = 0;
                if (item.repeat !== 'none') {
                    item.sentAt = now;
                    item.ts = nextOccurrence(item, now);
                } else {
                    item.state = 'sent';
                    item.sentAt = now;
                }
            } catch (e) {
                item.attempts += 1;
                item.error = e?.message || String(e);
                console.warn(`[Programmation] Envoi ${item.id} échoué (${item.attempts}/${MAX_ATTEMPTS}): ${item.error}`);
                if (item.attempts >= MAX_ATTEMPTS) item.state = 'missed';
            }
            changed = true;
        }
        const cutoff = now - KEEP_DONE_MS;
        const kept = items.filter((i) => !(i.state !== 'waiting' && (i.sentAt || i.ts) < cutoff));
        if (kept.length !== items.length) {
            for (const gone of items) if (!kept.includes(gone) && gone.media) dropMedia(gone.id);
            items = kept;
            changed = true;
        }
        if (changed) await save();
    } finally {
        ticking = false;
    }
    return sent;
}

/** Envoie tout de suite (aussi pour « Renvoyer » un élément manqué). */
async function sendNow(id, now = Date.now()) {
    const item = items.find((i) => i.id === id);
    if (!item) throw Object.assign(new Error('introuvable'), { code: 'not-found' });
    if (item.state === 'sent') throw Object.assign(new Error('déjà envoyé'), { code: 'invalid' });
    await deliver(item);
    item.error = null;
    item.attempts = 0;
    item.sentAt = now;
    if (item.repeat === 'none') item.state = 'sent';
    await save();
    return JSON.parse(JSON.stringify(item));
}

function start(nextDeps) {
    deps = nextDeps;
    stop();
    timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
    if (timer.unref) timer.unref();
    return tick().catch(() => 0);
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

module.exports = {
    GRACE_MS,
    MAX_MEDIA,
    STATUS_COLORS,
    load,
    list,
    add,
    remove,
    update,
    tick,
    sendNow,
    start,
    stop,
    _reset(next = {}, fn, d = null, store = null) {
        mediaStore = store;
        items = (next.items || []).map(sanitizeItem).filter(Boolean);
        nextId = Math.max(next.nextId || 1, ...items.map((i) => i.id + 1), 1);
        persist = fn || (async () => {});
        deps = d;
        loaded = true;
        ticking = false;
        stop();
    },
};
