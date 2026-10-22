const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestWaWebVersion,
    makeCacheableSignalKeyStore,
    downloadMediaMessage,
    Browsers,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const config = require('./config.js');
const NodeCache = require('node-cache');
const { createClient } = require('@supabase/supabase-js');
const useSupabaseAuthState = require('./supabaseAuth');
const express = require('express');
const antiDelete = require('./antidelete.js');
antiDelete.setHistoryLookup((chatId, id) => findHistoryMessage(chatId, id));
const viewOnce = require('./viewonce.js');
const tagAll = require('./tagall.js');
const screenshot = require('./screenshot.js');
const facebook = require('./facebook.js');
const hostCmd = require('./host.js');
const youtube = require('./youtube.js');
const pingCmd = require('./ping.js');
const tiktok = require('./tiktok.js');
const botState = require('./botState.js');
const { setupApi, attachWebSocket, addMessageToHistory, updateHistoryMessage, broadcastMessage, getChatHistory, removeChat, flushChatHistory, hydrateChatHistory, getChatIds, findHistoryMessage } = require('./api.js');
const { withTimeout } = require('./withTimeout.js');
const { sendStatusReaction } = require('./statusReaction.js');

// ── Médias (images/vidéos/audio/documents) ─────────────────────────────────
/** Taille max d'un média stocké en base64 dans Discussions (10 Mo). */
const MEDIA_MAX_BYTES = 10 * 1024 * 1024;

/** Extrait le conteneur média d'un message WA (image/video/audio/document/sticker). */
function mediaContainer(message) {
    for (const k of ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage']) {
        const sub = message?.[k];
        if (sub && typeof sub === 'object') {
            return { type: k.replace('Message', '').toLowerCase(), sub };
        }
    }
    return null;
}

/** Télécharge un média capturé (async, décryptage Baileys) puis met à jour
 *  l'historique. Ignoré si le fichier déclaré dépasse la limite. */
function scheduleMediaDownload(rawMsg, chatId, mc) {
    const msgId = rawMsg.key?.id;
    if (!msgId) return;
    const declared = Number(mc.sub.fileLength || mc.sub.fileSize || 0);
    if (declared && declared > MEDIA_MAX_BYTES) {
        updateHistoryMessage(chatId, msgId, { mediaStatus: 'too-large' });
        console.log(`[MEDIA] ${mc.type} ${msgId} ignoré (${Math.round(declared / 1024)} Ko > 10 Mo)`);
        return;
    }
    updateHistoryMessage(chatId, msgId, { mediaStatus: 'decrypting' });
    (async () => {
        let buffer = null;
        try {
            buffer = await withTimeout(downloadMediaMessage(rawMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) }), 30_000, 'downloadMediaMessage');
        } catch (e) {
            console.log(`[MEDIA] échec download ${mc.type} ${msgId}:`, e?.message || e);
            updateHistoryMessage(chatId, msgId, { mediaStatus: 'failed' });
            return;
        }
        if (!buffer || !buffer.length) {
            updateHistoryMessage(chatId, msgId, { mediaStatus: 'empty' });
            return;
        }
        if (buffer.length > MEDIA_MAX_BYTES) {
            updateHistoryMessage(chatId, msgId, { mediaStatus: 'too-large' });
            return;
        }
        updateHistoryMessage(chatId, msgId, {
            mediaData: buffer.toString('base64'),
            mediaStatus: 'ready',
        });
        flushChatHistory().catch(() => { });
        const fromMeMedia = !!rawMsg.key.fromMe;
        const mediaName = contacts.getDisplayName(
            fromMeMedia ? chatId : (rawMsg.key.participant ? rawMsg.key.participant : chatId),
            null
        );
        broadcastMessage({
            chatId,
            text: '',
            fromMe: fromMeMedia,
            name: fromMeMedia ? 'Me' : (mediaName || 'Unknown'),
            avatar: null,
            id: msgId,
            mediaType: mc.type,
            mediaStatus: 'ready',
        });
    })();
}
const contacts = require('./contacts.js');
const statusSeenStore = require('./statusSeenStore.js');
const statusMedia = require('./statusMedia.js');
const botGroup = require('./botGroup.js');
const airplane = require('./airplane.js');
const ghost = require('./ghost.js');
const scheduler = require('./scheduler.js');
const { buildStatusAudience } = require('./statusAudience.js');
const { buildStatusContent } = require('./statusPublish.js');

/** Ce que le planificateur a besoin de faire avec le socket WhatsApp actif. */
function schedulerDeps() {
    const active = () => {
        const sock = botState.activeSocket;
        if (!sock?.user?.id) throw new Error('WhatsApp non connecté');
        return sock;
    };
    return {
        isConnected: () => !!botState.activeSocket?.user?.id,
        async sendMessage(chatId, text) {
            await active().sendMessage(chatId, { text });
        },
        async sendStatus(status) {
            const sock = active();
            const self = sock.user.id.split(':')[0].split('@')[0] + '@s.whatsapp.net';
            const jids = buildStatusAudience({
                self,
                contacts: contacts.getContacts(),
                chatIds: getChatIds(),
                resolvePn: contacts.resolvePn,
            });
            const { content, options } = await buildStatusContent(status);
            console.log(`[Programmation] Statut ${status.media ? status.media.type : 'texte'} → ${jids.length} destinataire(s)`);
            await sock.sendMessage('status@broadcast', content, { ...options, statusJidList: jids });
        },
    };
}
const statusSettingsStore = require('./statusSettingsStore.js');
const liveEvents = require('./liveEvents.js');
const filtersStore = require('./filtersStore.js');
const chatHistoryStore = require('./chatHistoryStore.js');
const sessionLock = require('./sessionLock.js');
const originalLog = console.log;
const originalError = console.error;
const noiseWords = [
    'Session error', 'Bad MAC', 'prekey bundle', 'Failed to decrypt',
    'Closing open session', 'Removing old closed session',
    '_chains', 'registrationId', 'currentRatchet', 'indexInfo', 'ephemeralKeyPair',
    'lastRemoteEphemeralKey', 'previousCounter', 'rootKey', 'baseKey', 'remoteIdentityKey',
    'SessionEntry', 'pendingPreKey', 'preKeyId', 'signedKeyId'
];
function isNoise(args) {
    try {
        const str = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        return noiseWords.some(w => str.includes(w));
    } catch (e) { return false; }
}
// libsignal affiche les sessions via console.info / console.warn, avec l'objet
// SessionEntry en 2e argument : on filtre sur tous les arguments et sur le type.
const isSessionDump = (args) =>
    args.some(a => a && typeof a === 'object' && a.constructor?.name === 'SessionEntry') ||
    (typeof args[0] === 'string' &&
        /^(Closing|Opening|Removing old closed|Migrating)\b.*session/i.test(args[0]));

for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
        if (isSessionDump(args) || isNoise(args)) return;
        orig(...args);
    };
}

// Setup memory cache to avoid performance/duplicate issues internally for Baileys
const msgRetryCounterCache = new NodeCache();

// Store des derniers messages reçus (signature clé -> message) alimenté dans
// messages.upsert, pour que `getMessage()` de Baileys rende un vrai contenu
// (retries de décryptage / agrégation de sondages) au lieu d'un placeholder.
const keySignature = (key) => `${key?.remoteJid || ''}|${key?.participant || ''}|${key?.id || ''}`;
const recentMessageStore = new NodeCache({ stdTTL: 600, maxKeys: 600 });

/** Mémorise un message reçu (max 600, TTL 10 min) pour getMessage. */
function rememberMessage(key, message) {
    if (!key?.id || !message) return;
    recentMessageStore.set(keySignature(key), message);
}

// --- STATE & CACHE ---
const reactedStatusCache = new Set();
const processedMsgCache = new Set(); // anti-doublon commandes
const CACHE_MAX_SIZE = 1000;

// État mutable partagé via botState.js (botState.isActivelyLiking, botState.fixedEmoji, botState.activeSocket, etc.)

// Cache des messages envoyés par le bot (pour la commande ?clear)
// Structure : { jid: [{ id, remoteJid }] }
const botMessageCache = new Map();
const BOT_MSG_CACHE_LIMIT = 200;

function trackBotMessage(remoteJid, msgId) {
    if (!botMessageCache.has(remoteJid)) botMessageCache.set(remoteJid, []);
    const list = botMessageCache.get(remoteJid);
    list.push(msgId);
    if (list.length > BOT_MSG_CACHE_LIMIT) list.shift();
}

// Helper to check if a number is allowed based on whitelist and blacklist.
// Accepte plusieurs identités candidates (LID, PN, participantPn) pour un même
// auteur : un contact peut être reçu en @lid alors que la liste contient son
// numéro — le suivi passe par resolvePn le cas échéant.
function isAllowed(...jids) {
    const candidates = new Set();
    for (const j of jids) {
        if (!j) continue;
        candidates.add(j);
        const num = j.split(':')[0].split('@')[0];
        if (num) candidates.add(num);
        const pn = contacts.resolvePn(j);
        if (pn) {
            candidates.add(pn);
            candidates.add(pn.split('@')[0]);
        }
    }
    if (candidates.size === 0) return true;
    const match = (entry) =>
        candidates.has(entry) ||
        candidates.has(entry.split(':')[0].split('@')[0]);

    if (config.blacklist && config.blacklist.length > 0) {
        if (config.blacklist.some(match)) return false;
    }
    if (config.whitelist && config.whitelist.length > 0) {
        return config.whitelist.some(match);
    }
    return true;
}

// --- Flux des statuts reçus (feed "Aujourd'hui" de l'app) ---
// Chaque entrée retrace ce que le bot a fait d'un statut : reçu, bloqué (liste
// blanche/noire), vu (readMessages) ou aimé (réaction). Alimente
// GET /api/status/feed pour que le module Statuts rende le bot "visible".
function detectStatusType(msg, workingMessage) {
    const w = workingMessage || msg?.message || {};
    if (w.imageMessage || w.imageWithCaptionMessage) return 'image';
    if (w.videoMessage) return 'video';
    if (w.audioMessage) return 'audio';
    if (w.documentMessage) return 'document';
    if (w.textMessage || w.conversation || w.extendedTextMessage) return 'texte';
    return 'autre';
}

function pushStatusFeed(entry) {
    botState.statusFeed.unshift(entry);
    if (botState.statusFeed.length > 100) botState.statusFeed.pop();
}

// Met à jour une entrée du feed déjà enregistrée (vu / aimé).
function markStatusFeed(id, patch) {
    const e = botState.statusFeed.find(x => x.id === id);
    if (e) Object.assign(e, patch);
}

// Clé du jour courant (YYYY-MM-DD, heure locale).
function todayKey() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Incrémente le compteur journalier du graphe "7 derniers jours".
function bumpDailyStat(name) {
    const key = todayKey();
    botState.dailyStats[key] = botState.dailyStats[key] || { liked: 0, viewed: 0 };
    botState.dailyStats[key][name]++;
}

/** Le bot doit-il réagir maintenant ? (programmateur d'activité) */
function isWithinSchedule() {
    if (!config.scheduleEnabled || !config.scheduleStart || !config.scheduleEnd) return true;
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    const parse = (t) => {
        const m = String(t).match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return null;
        return Number(m[1]) * 60 + Number(m[2]);
    };
    const start = parse(config.scheduleStart);
    const end = parse(config.scheduleEnd);
    if (start == null || end == null || start === end) return true;
    // Fenêtre classique (début < fin) ou chevauchant minuit (début > fin).
    if (start < end) return mins >= start && mins < end;
    return mins >= start || mins < end;
}

/** JID utilisateur sans suffixe d'appareil (`123:4@lid` → `123@lid`). */
function statusBareJid(jid) {
    if (!jid || typeof jid !== 'string' || !jid.includes('@')) return null;
    const at = jid.lastIndexOf('@');
    const server = jid.slice(at + 1);
    const user = jid.slice(0, at).split(':')[0];
    if (!user || !server || server === 'broadcast') return null;
    return `${user}@${server}`;
}

/** Identifiants portés par la clé. Pour un statut, Baileys met le numéro dans remoteJidAlt, pas dans participant. */
function statusKeyJids(msgKey) {
    const out = [];
    for (const raw of [
        msgKey?.participant,
        msgKey?.participantAlt,
        msgKey?.participantPn,
        msgKey?.participantLid,
        msgKey?.remoteJidAlt,
    ]) {
        const bare = statusBareJid(raw);
        if (bare && !out.includes(bare)) out.push(bare);
        if (!bare) continue;
        for (const extra of contacts.jidCandidates(bare)) {
            const mapped = statusBareJid(extra);
            if (mapped && !out.includes(mapped)) out.push(mapped);
        }
    }
    return out;
}

function statusIsOwn(socket, msgKey) {
    if (msgKey?.fromMe) return true;
    const botPn = statusBareJid(contacts.normPn(socket.user?.id));
    const botLid = statusBareJid(socket.user?.lid);
    return statusKeyJids(msgKey).some((jid) => jid === botPn || (botLid && jid === botLid));
}

/**
 * Même envoi que les bots Baileys qui likent vraiment les statuts
 * (Silva, MMH, Bera, et l'exemple statusJidList) : la clé reçue, intacte,
 * et la liste [auteur, compte du bot]. Reconstruire la clé ou forcer un
 * mode d'adressage fait accepter le paquet sans afficher le cœur.
 */
async function sendStatusLike(socket, msg, emoji, extra = {}) {
    const msgKey = msg?.key || msg;
    const own = statusIsOwn(socket, msgKey);
    return sendStatusReaction(socket, msg, emoji, {
        ...extra,
        isOwn: own,
        resolvePn: (jid) => contacts.resolvePn(jid),
        logger: console,
    });
}

/**
 * Actions manuelles sur un statut déjà reçu, appelées par l'API (liste des
 * statuts de l'app) : réaction choisie par l'utilisateur et téléchargement.
 */
botState.statusActions = {
    async react(statusId, emoji) {
        const socket = botState.activeSocket;
        if (!socket?.user?.id) throw Object.assign(new Error('WhatsApp non connecté'), { code: 'offline' });
        const msg = statusMedia.getMessage(statusId);
        if (!msg) throw Object.assign(new Error('statut introuvable'), { code: 'not-found' });
        await sendStatusLike(socket, msg, emoji);
        botState.stats.statusesLiked++;
        bumpDailyStat('liked');
        markStatusFeed(statusId, { state: 'aimé', emoji });
        return true;
    },
    async unreact(statusId) {
        const socket = botState.activeSocket;
        if (!socket?.user?.id) throw Object.assign(new Error('WhatsApp non connecté'), { code: 'offline' });
        const msg = statusMedia.getMessage(statusId);
        if (!msg) throw Object.assign(new Error('statut introuvable'), { code: 'not-found' });
        const wasLiked = botState.statusFeed.find((x) => x.id === statusId)?.state === 'aimé';
        await sendStatusLike(socket, msg, '', { remove: true });
        if (wasLiked && botState.stats.statusesLiked > 0) botState.stats.statusesLiked--;
        markStatusFeed(statusId, { state: 'vu', emoji: null });
        return true;
    },
    async media(statusId) {
        return statusMedia.fetchMedia(statusId, (msg) => withTimeout(
            downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) }),
            30_000, 'downloadMediaMessage',
        ));
    },
};

/** Filtre par type de média : liste vide = réagit à tout. */
function mediaTypeAllowed(type) {
    const types = config.statusMediaTypes || [];
    if (!types.length) return true;
    return types.includes(type);
}

/**
 * Récupère la vue unique citée et l'envoie à `targetJid`, puis la journalise.
 * Utilisé par les commandes (vv, vv2, nice) et par les stickers déclencheurs.
 */
async function decodeQuotedViewOnce(socket, msg, remoteJid, contextInfo, quoted, targetJid, errorJid = remoteJid) {
    let mediaMsg = quoted;
    let type = Object.keys(quoted)[0];
    if (['viewOnceMessageV2', 'viewOnceMessage', 'viewOnceMessageV2Extension'].includes(type)) {
        mediaMsg = quoted[type].message;
        type = Object.keys(mediaMsg)[0];
    }

    // Reconstruire un faux message compatible Baileys
    const fakeMsg = {
        key: {
            remoteJid: remoteJid,
            id: contextInfo.stanzaId,
            participant: contextInfo.participant || null
        },
        message: mediaMsg
    };

    try {
        const buffer = await withTimeout(
            downloadMediaMessage(
                fakeMsg,
                'buffer', {},
                { logger: pino({ level: 'silent' }) }
            ), 30_000, 'downloadMediaMessage'
        );

        if (type === 'imageMessage') await socket.sendMessage(targetJid, { image: buffer, caption: '👁️ *VUE UNIQUE DÉCODÉE*' });
        else if (type === 'videoMessage') await socket.sendMessage(targetJid, { video: buffer, caption: '👁️ *VUE UNIQUE DÉCODÉE*' });
        else if (type === 'audioMessage') await socket.sendMessage(targetJid, { audio: buffer, mimetype: 'audio/mpeg', ptt: true });

        // Logger la capture manuelle pour le dashboard
        const vvSenderPhone = (contextInfo.participant || remoteJid).split('@')[0];
        viewOnce.logCapture({
            id: contextInfo.stanzaId,
            senderPhone: vvSenderPhone,
            pushName: '',
            messageTypeStr: type,
            remoteJid,
            buffer,
            force: true,
        });
    } catch (e) {
        console.error("[ERROR] Download failed:", e.message);
        // L'erreur va dans l'inbox ou le groupe privé, pas dans la discussion d'un tiers.
        await socket.sendMessage(errorJid, { text: "❌ Erreur de téléchargement." }, errorJid === remoteJid ? { quoted: msg } : {});
    }
}

/**
 * Traite un statut WhatsApp (vue + like). Extrait du lot messages.upsert pour
 * ne plus dépendre de messages[0] — un chat ordinaire avant un statut faisait
 * ignorer tous les likes.
 */
function handleIncomingStatus(socket, msg) {
    if (!msg?.key || msg.key.remoteJid !== 'status@broadcast') return;
    if (msg.message?.reactionMessage || msg.message?.protocolMessage) return;
    if (!botState.isActivelyLiking && !botState.isViewOnly) return;

    // Stub chiffré sans contenu : on tente quand même la lecture/réaction.
    const statusId = msg.key.id;
    if (!statusId || reactedStatusCache.has(statusId)) return;

    // Grace period : ignorer le backlog trop vieux (> 30 min avant boot)
    if (msg.messageTimestamp) {
        const msgTime = typeof msg.messageTimestamp === 'object' && msg.messageTimestamp.toNumber
            ? msg.messageTimestamp.toNumber()
            : Number(msg.messageTimestamp);
        if (msgTime < (botState.botStartTime - 30 * 60)) return;
    }

    let senderJid = msg.key.participantPn
        || msg.key.participant
        || msg.key.participantLid
        || msg.participant;

    if (statusIsOwn(socket, msg.key)) {
        if (!config.likeMyOwnStatus) return;
        senderJid = contacts.normPn(socket.user?.id) || senderJid;
    }
    if (!senderJid) {
        console.log(`[STATUS] senderJid vide, ignoré — id=${statusId}`);
        return;
    }

    // Différents message IDs peuvent représenter le même statut. La signature
    // combine auteur, horodatage et contenu stable, sans l'ID de transport.
    const statusTime = msg.messageTimestamp && typeof msg.messageTimestamp === 'object' && msg.messageTimestamp.toNumber
        ? msg.messageTimestamp.toNumber()
        : Number(msg.messageTimestamp || 0);
    const stableContent = (value) => {
        if (Array.isArray(value)) return value.map(stableContent);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.keys(value).sort()
            .filter(k => !['contextInfo', 'messageContextInfo', 'timestamp', 'messageTimestamp'].includes(k))
            .map(k => [k, stableContent(value[k])]));
    };
    const authorIdentity = contacts.resolvePn(senderJid) || senderJid;
    const semanticKey = `${authorIdentity}|${Math.floor(statusTime / 120)}|${JSON.stringify(stableContent(msg.message || {}))}`;
    if (!statusSeenStore.claim(semanticKey)) {
        reactedStatusCache.add(statusId);
        console.log(`[STATUS] doublon ignoré id=${statusId} auteur=${authorIdentity}`);
        return;
    }
    reactedStatusCache.add(statusId);
    if (reactedStatusCache.size > CACHE_MAX_SIZE) reactedStatusCache.delete(reactedStatusCache.values().next().value);

    let senderPhone = senderJid.split(':')[0].split('@')[0];
    try {
        const lookup = contacts.resolvePn(senderJid);
        if (lookup) senderPhone = lookup.split('@')[0];
        botState.recentStatusAuthors.set(senderJid, {
            jid: senderJid,
            phone: senderPhone,
            at: Date.now(),
        });
        if (botState.recentStatusAuthors.size > 40) {
            const first = botState.recentStatusAuthors.keys().next().value;
            botState.recentStatusAuthors.delete(first);
        }
    } catch (_) {}

    const _authorOverride = authorOverrideFor(senderJid, senderPhone);
    const _feedDelayMs = _authorOverride?.delayMs != null
        ? Math.max(200, _authorOverride.delayMs)
        : (botState.statusDelayMode === 'fixed'
            ? botState.statusDelayFixed
            : Math.floor(Math.random() * (botState.statusDelayMax - botState.statusDelayMin)) + botState.statusDelayMin);
    const _type = detectStatusType(msg, msg.message);
    const _feedPlanned = (botState.isViewOnly && !botState.isActivelyLiking) ? 'view' : 'like';
    pushStatusFeed({
        id: statusId,
        jid: senderJid,
        phone: senderPhone,
        at: Date.now(),
        type: _type,
        viewOnly: botState.isViewOnly,
        planned: _feedPlanned,
        delayMs: _feedDelayMs,
        state: 'reçu',
        name: msg.pushName || null,
        text: String(statusMedia.textOf(msg) || '').slice(0, 280),
        hasMedia: !!statusMedia.container(msg),
        timestamp: statusTime || Math.floor(Date.now() / 1000),
    });
    statusMedia.remember(statusId, msg);
    console.log(`[STATUS] reçu id=${statusId} from=${senderJid} type=${_type}`);

    if (!statusIsOwn(socket, msg.key) &&
        !isAllowed(msg.key.participantPn, msg.key.participantLid, msg.key.participant, msg.key.remoteJidAlt, msg.participant)) {
        markStatusFeed(statusId, { state: 'bloqué' });
        return;
    }
    if (!isWithinSchedule()) {
        markStatusFeed(statusId, { state: 'pause', delayMs: _authorOverride?.delayMs ?? _feedDelayMs });
        console.log(`[PAUSE] Hors plage ${config.scheduleStart}-${config.scheduleEnd} → statut ignoré (${senderPhone})`);
        return;
    }
    if (!mediaTypeAllowed(_type)) {
        markStatusFeed(statusId, { state: 'ignoré', delayMs: _authorOverride?.delayMs ?? _feedDelayMs });
        console.log(`[STATUS-IGNORÉ] Type "${_type}" exclu → (${senderPhone})`);
        return;
    }

    const _isViewOnly = botState.isViewOnly;
    const _isActivelyLiking = botState.isActivelyLiking;
    const _msgSnapshot = msg;
    const _socketSnapshot = socket;
    const _authorOverrideSnapshot = _authorOverride;

    setImmediate(async () => {
        try {
            const rawParticipant = _msgSnapshot.key.participantPn
                || _msgSnapshot.key.participant
                || _msgSnapshot.key.participantLid
                || _msgSnapshot.participant
                || senderJid;

            // PN réel via mapping LID↔PN ; ne JAMAIS inventer un @s.whatsapp.net
            // à partir d'un LID (ça cassait tous les likes sur les comptes récents).
            let participantForReact = rawParticipant;
            let senderPn = null;
            if (_msgSnapshot.key.participantPn) {
                const bare = String(_msgSnapshot.key.participantPn).split(':')[0].split('@')[0];
                senderPn = bare ? `${bare}@s.whatsapp.net` : null;
                participantForReact = senderPn || rawParticipant;
            } else {
                senderPn = contacts.resolvePn(rawParticipant);
                if (senderPn) participantForReact = senderPn;
            }

            const senderPhoneNumber = (senderPn || rawParticipant).split(':')[0].split('@')[0];
            const delayMs = _authorOverrideSnapshot?.delayMs != null
                ? Math.max(200, _authorOverrideSnapshot.delayMs)
                : (botState.statusDelayMode === 'fixed'
                    ? botState.statusDelayFixed
                    : Math.floor(Math.random() * (botState.statusDelayMax - botState.statusDelayMin)) + botState.statusDelayMin);

            console.log(`[STATUS] Traitement — sender=${senderPhoneNumber} reactAs=${participantForReact} delay=${delayMs}ms`);

            await new Promise(r => setTimeout(r, delayMs));

            // Mémoriser LID↔PN dès qu'on a les deux (sinon statusJidList chiffre vers un faux PN).
            try {
                const lidCand = _msgSnapshot.key.participantLid || _msgSnapshot.key.participant;
                const pnCand = _msgSnapshot.key.participantPn || senderPn;
                if (lidCand && String(lidCand).includes('@lid') && pnCand) {
                    contacts.recordLidPn(lidCand, pnCand);
                }
            } catch (_) {}

            try {
                await _socketSnapshot.readMessages([_msgSnapshot.key]);
                console.log(`[VIEW] readMessages OK ${senderPhoneNumber} id=${_msgSnapshot.key.id}`);
            } catch (readErr) {
                console.warn(`[VIEW] readMessages KO ${senderPhoneNumber}: ${readErr.message}`);
            }
            botState.stats.statusesViewed++;
            bumpDailyStat('viewed');
            markStatusFeed(_msgSnapshot.key.id, { state: 'vu' });

            // Mode like prioritaire : même si viewOnly a flipé entre réception et exécution.
            const wantLike = _isActivelyLiking || (!_isViewOnly && botState.isActivelyLiking);
            if (!wantLike) {
                console.log(`[VIEW] +${senderPhoneNumber} vu ✅ (view-only)`);
                return;
            }

            await new Promise(r => setTimeout(r, 1200));

            const emojis = config.reactionEmojis || ['❤️'];
            const selectedEmoji = String(
                _authorOverrideSnapshot?.emoji || botState.fixedEmoji ||
                emojis[Math.floor(Math.random() * emojis.length)] || '❤️',
            ).trim() || '❤️';

            try {
                await sendStatusLike(_socketSnapshot, _msgSnapshot, selectedEmoji);
            } catch (likeErr) {
                botState.lastReaction = {
                    id: null,
                    authorJid: senderJid,
                    emoji: selectedEmoji,
                    sentAt: Date.now(),
                    ack: null,
                    error: likeErr?.message || 'échec du like',
                };
                markStatusFeed(_msgSnapshot.key.id, { state: 'erreur' });
                throw likeErr;
            }
            botState.lastReaction = {
                id: _msgSnapshot.key.id,
                authorJid: senderJid,
                emoji: selectedEmoji,
                sentAt: Date.now(),
                ack: null,
                error: null,
            };
            botState.stats.statusesLiked++;
            bumpDailyStat('liked');
            markStatusFeed(_msgSnapshot.key.id, { state: 'aimé' });

            if (config.autoReplyMessage?.trim() && senderPn && !statusIsOwn(_socketSnapshot, _msgSnapshot.key)) {
                await _socketSnapshot.sendMessage(senderPn, { text: config.autoReplyMessage });
            }
        } catch (err) {
            console.error(`[ERROR] Status handling:`, err.message);
            markStatusFeed(statusId, { state: 'erreur' });
        }
    });
}

/** Override personnalisé (emoji + délai) pour un expéditeur donné, sinon null. */
function authorOverrideFor(senderJid, senderPhone) {
    const overrides = config.authorReactions || [];
    if (!overrides.length) return null;
    const phoneDigits = senderPhone ? String(senderPhone).replace(/\D/g, '') : '';
    return overrides.find((r) => {
        if (!r) return false;
        if (r.uid && senderJid && (r.uid === senderJid || r.uid.split(':')[0] === senderJid.split(':')[0])) return true;
        if (r.phone && phoneDigits && String(r.phone).replace(/\D/g, '') === phoneDigits) return true;
        return false;
    }) || null;
}

let connectRetryTimer = null;

// Compteur de reconnexions PARTAGÉ entre tous les sockets. Déclaré ici, hors de
// connectToWhatsApp : sinon chaque nouveau socket repart à 0, le backoff
// reste bloqué à 10 s et Baileys boucle indéfiniment sur 428
// (connectionClosed) en fabriquant un socket toutes les 10 s.
let reconnectAttempts = 0;
let lastClosedSocket = null;

// ── Pénalité 428 ────────────────────────────────────────────────────────────
// WhatsApp ferme la connexion (428 connectionClosed) et pénalise l'IP quand on
// lui renvoie des sockets en rafale. Un backoff de 10 à 120 s ne suffit pas :
// au bout de quelques tentatives le compte est marqué et chaque nouvel essai
// se fait fermer aussitôt. On interrompt donc TOUTE création de socket pendant
// une pause franche, le temps que WhatsApp oublie. Un pairing demandé pendant
// la pause reçoit un 503 daté plutôt qu'un 500 « session fermée » opaque.
const WA_COOLDOWN_MS = 10 * 60 * 1000;

function waCooldownRemaining() {
    return Math.max(0, (botState.waCooldownUntil || 0) - Date.now());
}

function startWaCooldown(reason) {
    botState.waCooldownUntil = Date.now() + WA_COOLDOWN_MS;
    botState.waCooldownReason = reason || null;
    // Le compteur repart de zéro après une pause : le prochain cycle doit
    // reconsidérer son backoff de zéro, pas hériter de la saturation passée.
    reconnectAttempts = 0;
}

function clearWaCooldown() {
    botState.waCooldownUntil = 0;
    botState.waCooldownReason = null;
}

// Programme UNE seule tentative à la fin de la pause. Sans ce rappel, le bot
// resterait mort jusqu'au prochain déploiement : le cooldown ne doit pas
// annuler la reconnexion, il doit seulement la décaler. Un seul timer suffit,
// car toute tentative à son tour arme son propre rappel si elle est fermée.
let cooldownRetryTimer = null;
function scheduleCooldownRetry(delayMs) {
    if (cooldownRetryTimer) return;
    cooldownRetryTimer = setTimeout(() => {
        cooldownRetryTimer = null;
        triggerConnect();
    }, Math.max(1000, delayMs));
    cooldownRetryTimer.unref?.();
}

// Sérialise connectToWhatsApp : au plus UN socket à la fois dans ce process
// (testé aussi par le verrou, mais le verrou est ré-acquitté ici). Sans ça,
// un reconnect simultané crée un second socket → conflit 440/441.
let connectSerial = Promise.resolve();
function triggerConnect() {
    connectSerial = connectSerial
        .then(() => connectToWhatsApp())
        .catch(err => console.error('[CONNECT]', err?.message));
    return connectSerial;
}

async function connectToWhatsApp() {
    if (connectRetryTimer) { clearTimeout(connectRetryTimer); connectRetryTimer = null; }

    // Garde-fou anti-pénalité : WhatsApp nous a fermé une fois, on ne
    // réessaie pas avant la fin de la pause. Sans ce garde-fou, le backoff
    // (même plafonné à 120 s) recommence indéfiniment à fabriquer des
    // sockets et le 428 ne se lève jamais.
    const cooldownLeft = waCooldownRemaining();
    if (cooldownLeft > 0) {
        const at = new Date(botState.waCooldownUntil).toISOString().slice(11, 19);
        console.log(`[428] Pause en cours (${Math.round(cooldownLeft / 1000)}s restantes, reprise à ${at} UTC) — aucun socket créé.`);
        // La tentative est reportée, pas annulée : un pairing ou un cycle en
        // cours ne doit pas se retrouver sans relance après la pause.
        scheduleCooldownRetry(cooldownLeft + 2000);
        return;
    }

    // Verrou anti double-socket : pendant un redéploiement Render l'ancienne
    // instance vit encore quelques secondes. Deux sockets sur la même session
    // font déclarer le pairage invalide (440/401). On diffère sans créer de
    // socket tant qu'une autre instance tient le verrou.
    const lockHeld = await sessionLock.acquire();
    if (!lockHeld) {
        console.log('[LOCK] Session verrouillée par une autre instance — nouveau socket différé (15 s).');
        connectRetryTimer = setTimeout(() => triggerConnect(), 15_000);
        connectRetryTimer.unref?.();
        return;
    }

    const supabase = createClient(config.supabaseUrl, config.supabaseKey);

    console.log('[INFO] Loading WhatsApp Session from Supabase Cloud...');
    const { state, saveCreds } = await useSupabaseAuthState(supabase, 'whatsapp_auth');

    const { version, isLatest } = await fetchLatestWaWebVersion();
    console.log(`[INFO] Using WhatsApp v${version.join('.')}, isLatest: ${isLatest}`);

    const logger = pino({ level: process.env.WA_LOG_LEVEL || 'silent' });

    const socket = makeWASocket({
        version,
        logger,
        printQRInTerminal: !config.usePairingCode,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        markOnlineOnConnect: false,
        keepAliveIntervalMs: 15_000,
        // Identité client : WhatsApp rejette IMMÉDIATEMENT la connexion si le
        // libellé de navigateur n'est pas un vrai navigateur. Avec
        // Browsers.macOS('Desktop') (« Mac OS / Desktop / 14.4.1 ») le serveur
        // coupe le WebSocket ~400 ms après le handshake : fermeture 428
        // (« Connection Terminated »), sans jamais envoyer le QR ni le code —
        // donc JosiConnect ne peut rien produire. Vérifié sur 5 versions de
        // WhatsApp Web et 2 IP : seul le libellé change le verdict.
        // « Chrome » garde la même plateforme desktop (historique complet
        // synchronisé au login) tout en étant accepté.
        browser: Browsers.macOS('Chrome'),
        // v7 : demander la synchro COMPLÈTE de l'historique au moment de
        // l'appairage, pour que Discussions remonte les anciennes conversa-
        // tions (contacts, groupes et messages) — pas seulement le présent.
        syncFullHistory: true,
        connectTimeoutMs: 120_000,
        retryRequestDelayMs: 2000,
        maxMsgRetryCount: 8,
        // v7 : ne pas ignorer les JIDs @lid pour capter les vues uniques des nouveaux comptes
        shouldIgnoreJid: () => false,
        // v7 : fournir le message depuis le cache pour le placeholder resend.
        // Retourner `undefined` (comportement Baileys) si inconnu : un
        // placeholder {conversation:''} cassait les retries de décryptage et
        // l'agrégation des sondages (message vide re-encodé).
        getMessage: async (key) => recentMessageStore.get(keySignature(key)),
    });

    // Publie le nouveau socket comme courant AVANT de fermer l'ancien. L'ancien
    // peut émettre son événement close de façon synchrone; son handler doit alors
    // le reconnaître comme obsolète au lieu de lancer une reconnexion concurrente.
    const previousSocket = lastClosedSocket;
    lastClosedSocket = socket;
    botState.activeSocket = socket;
    if (previousSocket && previousSocket !== socket) {
        try { previousSocket.end(new Error('remplacé par un nouveau socket')); }
        catch (_) { /* socket déjà mort */ }
    }

    // Si un numéro attend une phase de réinitialisation (session périmée,
    // utilisateur en train de s'associer via JosiConnect), on génère le code
    // sur ce socket fraîchement recréé (session vierge) dès qu'il est prêt.
    if (botState.pendingPairPhone) {
        const phone = botState.pendingPairPhone;
        waitForSocketReady(socket, phone);
    }

    socket.ev.on('creds.update', () => {
        if (botState.activeSocket !== socket) return;
        saveCreds();
    });

    socket.ev.on('contacts.upsert', (list) => contacts.handleContactsUpsert(list));
    socket.ev.on('contacts.update', (list) => contacts.handleContactsUpdate(list));

    // Watcher ACK : suit le devenir de la dernière réaction envoyée pour savoir
    // si WhatsApp l'applique réellement (ackStatus croissant = livré/lu).
    socket.ev.on('messages.update', (updates) => {
        const last = botState.lastReaction;
        if (!last || !last.id) return;
        for (const u of updates) {
            if (u.key?.id === last.id && typeof u.update?.status === 'number') {
                if (u.update.status !== last.ack) {
                    last.ack = u.update.status;
                    last.ackedAt = Date.now();
                    console.log(`[LIKE-ACK] id=${last.id} status=${u.update.status}`);
                }
            }
        }
    });

    // --- IMPORT DE L'HISTORIQUE OCR : remonte les conversations existantes du
    // compte WhatsApp (envoi du téléphone lors de la (re)connexion). Sans ça,
    // Discussions ne voit que les messages reçus après le démarrage. ---
    socket.ev.on('messaging-history.set', (sync) => {
        try {
            const contactsList = sync?.contacts;
            if (Array.isArray(contactsList)) contacts.handleContactsUpsert(contactsList);

            const incoming = sync?.messages;
            if (!Array.isArray(incoming) || incoming.length === 0) return;

            let imported = 0;
            for (const im of incoming) {
                try {
                    const key = im.key;
                    if (!key?.remoteJid || !key?.id) continue;
                    if (key.remoteJid.endsWith('@newsletter') || key.remoteJid.endsWith('@broadcast') || key.remoteJid === 'status@broadcast') continue;
                    const msgBody = im.message || {};
                    try { rememberMessage(key, im.message); } catch (_) {}
                    const text = msgBody.conversation ||
                        msgBody.extendedTextMessage?.text ||
                        msgBody.imageMessage?.caption ||
                        msgBody.videoMessage?.caption ||
                        msgBody.documentMessage?.caption ||
                        "";
                    const mc = mediaContainer(msgBody);
                    if (!text && !mc) continue;

                    const existing = getChatHistory(key.remoteJid);
                    if (existing.some(m => m.id === key.id)) continue;

                    const fromMe = !!key.fromMe;
                    let name = 'Me';
                    if (!fromMe) {
                        const senderJid = key.remoteJid.endsWith('@g.us')
                            ? key.participant
                            : key.remoteJid;
                        if (contacts.isRealName(im.pushName)) {
                            contacts.upsertContact(senderJid, im.pushName, 'contact');
                        }
                        name = contacts.getDisplayName(senderJid, im.pushName) || 'Unknown';
                    }
                    const ts = im.messageTimestamp
                        ? (Number.isFinite(im.messageTimestamp)
                            ? im.messageTimestamp
                            : im.messageTimestamp.low)
                        : Math.floor(Date.now() / 1000);

                    addMessageToHistory(key.remoteJid, {
                        id: key.id,
                        text,
                        fromMe,
                        timestamp: new Date(Number(ts) * 1000).toISOString(),
                        name,
                        avatar: null,
                        mediaType: mc ? mc.type : null,
                        mediaName: mc ? (mc.sub.fileName || mc.sub.caption || null) : null,
                        mediaMime: mc ? (mc.sub.mimetype || null) : null,
                        mediaStatus: mc ? 'pending' : undefined,
                        quotedId: null,
                        quotedText: null,
                    });
                    // Télécharger aussi les médias de l'historique remonté, sinon
                    // Discussions affiche des pastilles mortes (404 définitifs).
                    if (mc) scheduleMediaDownload(im, key.remoteJid, mc);
                    imported++;
                } catch (_) { /* un message HS ne bloque pas le sync */ }
            }
            if (imported > 0) {
                console.log(`[HISTORY-SYNC] ${imported} messages importés (${incoming.length} reçus du téléphone)`);
                flushChatHistory().catch(() => { });
            }
        } catch (e) {
            console.error('[HISTORY-SYNC] erreur :', e.message);
        }
    });

    // --- ANTI-DELETE LOGIC ---
    socket.ev.on('messages.update', (update) => {
        antiDelete.handleUpdate(socket, update);
    });

    // --- VIEWONCE via messages.update (contenu chiffré livré après notification vide) ---
    socket.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            try {
                if (!update.update?.message) {
                    // Log pour voir ce qui arrive dans messages.update
                    if (update.key && !update.key.fromMe) {
                        console.log(`[UPDATE-RAW] id=${update.key?.id} keys=${JSON.stringify(Object.keys(update.update || {}))}`);
                    }
                    continue;
                }
                const updMsg = update.update.message;
                const msgKeys = Object.keys(updMsg).filter(k =>
                    !['senderKeyDistributionMessage','messageContextInfo'].includes(k)
                );
                const voKey = msgKeys.find(k => k.toLowerCase().includes('viewonce'));
                const hasVOFlag = ['imageMessage','videoMessage','audioMessage'].some(k => updMsg[k]?.viewOnce);

                if (!voKey && !hasVOFlag) continue;

                console.log(`[VIEWONCE-UPDATE] Clé: ${voKey || 'viewOnce:true'} jid=${update.key?.remoteJid}`);

                if (!viewOnce.isEnabled()) continue;

                let messageTypeStr = 'Media';
                let mediaPayload = updMsg;

                if (voKey) {
                    const inner = updMsg[voKey]?.message;
                    if (inner) {
                        messageTypeStr = Object.keys(inner).filter(k =>
                            !['senderKeyDistributionMessage','messageContextInfo'].includes(k)
                        )[0] || 'Media';
                        mediaPayload = inner;
                    }
                } else {
                    for (const k of ['imageMessage','videoMessage','audioMessage']) {
                        if (updMsg[k]?.viewOnce) { messageTypeStr = k; break; }
                    }
                }

                const fakeMsg = { key: update.key, message: mediaPayload, messageTimestamp: Math.floor(Date.now()/1000) };
                const senderPhone = (update.key.participant || update.key.remoteJid || '').split('@')[0];
                const ownerJid = botGroup.captureJid(socket.user.id.split(':')[0] + '@s.whatsapp.net');

                let buffer = null;
                try {
                    buffer = await withTimeout(downloadMediaMessage(fakeMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) }), 30_000, 'downloadMediaMessage');
                } catch (e) {
                    console.error('[VIEWONCE-UPDATE] Échec download:', e?.message);
                }

                if (buffer) {
                    const caption = `👁️ *VUE UNIQUE DÉTECTÉE*\n👤 +${senderPhone}`;
                    try {
                        if (messageTypeStr.includes('image')) await socket.sendMessage(ownerJid, { image: buffer, caption });
                        else if (messageTypeStr.includes('video')) await socket.sendMessage(ownerJid, { video: buffer, caption });
                        else if (messageTypeStr.includes('audio')) await socket.sendMessage(ownerJid, { audio: buffer, mimetype: 'audio/mpeg', ptt: true });
                    } catch(e) { console.error('[VIEWONCE-UPDATE] Échec envoi:', e?.message); }
                }

                viewOnce.logCapture({
                    id: update.key?.id || `${Date.now()}`,
                    senderPhone,
                    pushName: '',
                    messageTypeStr,
                    remoteJid: update.key?.remoteJid || '',
                    buffer,
                });
            } catch(e) {
                console.error('[VIEWONCE-UPDATE] Erreur:', e?.message);
            }
        }
    });

    // --- VIEWONCE v7 : capter le contenu après placeholder resend via messages.upsert ---
    // Le contenu viewonce arrive en messages.upsert (type vide) après requestPlaceholderResend
    // C'est le même event que déclenche .vv quand on cite le message manuellement
    socket.ev.on('messages.upsert', async (m) => {
        for (const msg of m.messages) {
            try {
                if (msg.key.fromMe || !msg.message) continue;
                const jid = msg.key.remoteJid || '';
                const keys = Object.keys(msg.message).filter(k =>
                    !['senderKeyDistributionMessage','messageContextInfo'].includes(k)
                );

                // Chercher imageMessage/videoMessage/audioMessage avec viewOnce:true
                // OU un wrapper viewOnce*
                const voKey = keys.find(k => k.toLowerCase().includes('viewonce'));
                const mediaKey = ['imageMessage','videoMessage','audioMessage'].find(k =>
                    msg.message[k]?.viewOnce === true
                );

                if (!voKey && !mediaKey) continue;

                // Éviter de traiter les messages déjà traités par le handler principal
                if (processedMsgCache.has('vo_' + msg.key.id)) continue;
                processedMsgCache.add('vo_' + msg.key.id);

                console.log(`[VIEWONCE-AUTO] ✅ Vue unique reçue! voKey=${voKey || mediaKey} jid=${jid} id=${msg.key.id}`);
                if (!viewOnce.isEnabled()) continue;

                let messageTypeStr = mediaKey || voKey || 'Media';
                let viewOnceMsg = msg;

                if (voKey) {
                    const inner = msg.message[voKey]?.message;
                    if (inner) {
                        messageTypeStr = Object.keys(inner).filter(k =>
                            !['senderKeyDistributionMessage','messageContextInfo'].includes(k)
                        )[0] || 'Media';
                        viewOnceMsg = { key: msg.key, message: inner, messageTimestamp: msg.messageTimestamp };
                    }
                }

                const senderPhone = (msg.key.participant || jid).split('@')[0];
                const ownerJid = botGroup.captureJid(socket.user.id.split(':')[0] + '@s.whatsapp.net');

                let buffer = null;
                try {
                    buffer = await withTimeout(
                        downloadMediaMessage(
                            viewOnceMsg, 'buffer', {},
                            { logger: pino({ level: 'silent' }) }
                        ), 30_000, 'downloadMediaMessage'
                    );
                    console.log(`[VIEWONCE-AUTO] Download OK, size=${buffer?.length}`);
                } catch(e) {
                    console.error('[VIEWONCE-AUTO] Échec download:', e?.message);
                }

                if (buffer) {
                    const caption = `👁️ *VUE UNIQUE DÉTECTÉE*\n👤 +${senderPhone}`;
                    try {
                        if (messageTypeStr.includes('image')) await socket.sendMessage(ownerJid, { image: buffer, caption });
                        else if (messageTypeStr.includes('video')) await socket.sendMessage(ownerJid, { video: buffer, caption });
                        else if (messageTypeStr.includes('audio')) await socket.sendMessage(ownerJid, { audio: buffer, mimetype: 'audio/mpeg', ptt: true });
                        console.log(`[VIEWONCE-AUTO] ✅ Envoyé sur WhatsApp!`);
                    } catch(e) { console.error('[VIEWONCE-AUTO] Échec envoi:', e?.message); }
                }

                viewOnce.logCapture({
                    id: msg.key.id,
                    senderPhone,
                    pushName: msg.pushName || '',
                    messageTypeStr,
                    remoteJid: jid,
                    buffer,
                });
            } catch(e) {
                console.error('[VIEWONCE-AUTO] Erreur:', e?.message);
            }
        }
    });

    // Handle pairing code — fallback au boot (aucune session), sauf si
    // /whatsapp/reset a demandé d'associer un autre numéro (autoPair = false).
    // Ne pas utiliser un délai fixe ici : le WebSocket peut mettre plus de
    // trois secondes à émettre le signal QR/ready, ce qui provoquait des
    // requestPairingCode() sur une session encore fermée (erreur 428).
    if (config.usePairingCode && !state.creds.me && botState.autoPair) {
        if (!config.phoneNumber || config.phoneNumber === "1234567890") {
            console.error('[ERROR] phone number issues in config.js');
            process.exit(1);
        }
        const phone = String(config.phoneNumber).replace(/\D/g, '');
        waitForSocketReady(socket, phone);
    }

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        // La fermeture tardive d'un socket remplacé ne doit pas remettre à OFF
        // l'état global, ni programmer un nouveau cycle de reconnexion.
        if (botState.activeSocket !== socket) return;

        if (connection === 'close') {
            botState.whatsappConnected = false;
            botState.pairingCode = null;
            botState.pairingPhone = null;
            liveEvents.pushEvent('connection', { status: 'disconnected' });
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            const isConflict = statusCode === 440;
            const is401 = statusCode === 401;
            const is428 = statusCode === DisconnectReason.connectionClosed;
            // Un reset (/whatsapp/reset) se traduit par un logout côté WhatsApp :
            // on relance malgré tout pour offrir une session vierge à associer.
            const shouldReconnect = !isLoggedOut || botState.forceReconnect;

            console.log('[INFO] Connection closed, code:', statusCode, '| Reconnecting:', shouldReconnect);

            // Pénalité WhatsApp : après un 428 on cesse immédiatement toute
            // création de socket. Le backoff exponentiel ci-dessous repartirait
            // de 10 s, ce qui suffit à se faire refermer la porte au nez
            // (et à boucler indéfiniment). On impose une pause franche.
            if (is428 && shouldReconnect) {
                startWaCooldown(`fermeture 428${botState.pendingPairPhone ? ' pendant l\'association' : ''}`);
                const at = new Date(botState.waCooldownUntil).toISOString().slice(11, 19);
                console.log(`[428] WhatsApp a fermé la connexion (pénalité). Pause ${WA_COOLDOWN_MS / 60000} min — reprise à ${at} UTC.`);
                scheduleCooldownRetry(WA_COOLDOWN_MS + 2000);
                return;
            }

            if (shouldReconnect) {
                reconnectAttempts++;
                let baseDelay = 10_000;
                if (isConflict) baseDelay = 30_000;
                if (is401) baseDelay = 5_000;
                const backoff = Math.min(baseDelay * Math.pow(1.5, reconnectAttempts - 1), 120_000);
                const reason = isConflict ? ' (conflit)' : is401 ? ' (invalide, retry)' : '';
                console.log(`[INFO] Reconnexion dans ${Math.round(backoff / 1000)}s (tentative #${reconnectAttempts})${reason}...`);

                if (botState.pendingPairPhone) {
                    // Phase d'association en cours : le redémarrage est géré par
                    // __restartBotConnection (socket unique, session vierge). Lancer
                    // un reconnect ici créerait un second socket en parallèle.
                    console.log('[CLOSE] Session fermée pendant l\'association — pas de reconnect parallèle (waitForSocketReady pend).');
                    return;
                }
                setTimeout(() => triggerConnect(), backoff);
            } else {
                console.log('[INFO] Session déconnectée (loggedOut). Nettoyez Supabase.');
            }
        } else if (connection === 'open') {
            botState.whatsappConnected = true;
            // Mode avion : on se redéclare indisponible à chaque (re)connexion.
            airplane.apply(socket, () => botState.activeSocket).catch(() => {});
            // Messages et statuts programmés : on (re)lance la vérification à chaque connexion.
            scheduler.start(schedulerDeps()).catch(() => {});
            botState.forceReconnect = false;
            botState.autoPair = true;
            botState.lastPairError = null;
            botState.pairingCode = null;
            botState.pairingPhone = null;
            // Connexion réussie : la pénalité est levée, on repart d'un cycle neuf.
            clearWaCooldown();
            // Mémorise le numéro effectivement pairé : les prochains
            // redémarrages demanderont le code pour CE numéro, pas celui de
            // config.js.
            if (botState.activeSocket?.user?.id) {
                config.phoneNumber = botState.activeSocket.user.id.split(':')[0];
            }
            reconnectAttempts = 0;
            botState.botStartTime = Math.floor(Date.now() / 1000); // Réinitialiser pour ignorer le backlog
            console.log('[INFO] Successfully connected to WhatsApp!');
            liveEvents.pushEvent('connection', { status: 'connected', phone: socket.user?.id?.split(':')[0] || '' });
            contacts.fetchGroupsFromSocket(socket).catch(() => {});
            const botJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
            // Nettoyer d'éventuels messages d'accueil stockés avant ce fix,
            // en gardant les vrais messages auto-envoyés.
            const selfMsgs = getChatHistory(botJid);
            if (selfMsgs.some(m => (m.text || '').includes('JOSIHACK BOT'))) {
                const kept = selfMsgs.filter(m => !(m.text || '').includes('JOSIHACK BOT'));
                removeChat(botJid);
                for (const m of kept) addMessageToHistory(botJid, m);
                flushChatHistory().catch(() => { });
            }
            const welcomeMsg = `╭───〔 🤖 *JOSIHACK BOT* 〕───⬣\n` +
                `│ ߷ *Etat*       ➜ Connecté ✅\n` +
                `│ ߷ *Mode*       ➜ Auto-Like\n` +
                `╰──────────────⬣`;
            console.log(welcomeMsg);
            try {
                if (config.sendWelcomeMessage) {
                    await socket.sendMessage(botJid, { text: welcomeMsg });
                    console.log('[INFO] Système synchronisé.');
                }
            } catch (e) { }
        }
    });

    socket.ev.on('messages.upsert', async (m) => {
        try {
            // Log brut pour debug viewonce
            for (const rawMsg of m.messages) {
                try { rememberMessage(rawMsg.key, rawMsg.message); } catch (_) {}
                if (!rawMsg.key.fromMe) {
                    const rawKeys = Object.keys(rawMsg.message || {});
                    const hasVO = rawKeys.some(k => k.toLowerCase().includes('viewonce'));
                    const hasVOFlag = ['imageMessage','videoMessage','audioMessage'].some(k => rawMsg.message?.[k]?.viewOnce);
                    if (hasVO || hasVOFlag) {
                        console.log(`[VIEWONCE-RAW] type=${m.type} keys=${JSON.stringify(rawKeys)} jid=${rawMsg.key.remoteJid}`);
                    } else if (rawKeys.length === 0) {
                        console.log(`[MSG-RAW] type=${m.type} keys=[] fromMe=${rawMsg.key.fromMe}`);
                    }
                    // Log append avec contenu pour voir si la vue unique y passe
                    if (m.type === 'append' && rawKeys.length > 0) {
                        console.log(`[APPEND-CONTENT] keys=${JSON.stringify(rawKeys)} jid=${rawMsg.key.remoteJid}`);
                    }
                }

                // Capture miroir : TOUS les messages texte ET médias (envoyés + reçus),
                // pour que Discussions reflète la conversation complète.
                try {
                    const chatId = rawMsg.key?.remoteJid;
                    if (!chatId) continue;
                    if (chatId.endsWith('@newsletter') || chatId.endsWith('@broadcast') || chatId === 'status@broadcast') continue;

                    const msgBody = rawMsg.message || {};
                    const textContent = msgBody.conversation ||
                        msgBody.extendedTextMessage?.text ||
                        msgBody.imageMessage?.caption ||
                        msgBody.videoMessage?.caption ||
                        msgBody.documentMessage?.caption ||
                        "";

                    // Type de média + métadonnées (image/vidéo/audio/document)
                    const mc = mediaContainer(msgBody);

                    if (textContent || mc) {
                        const fromMe = !!rawMsg.key.fromMe;
                        // Ne jamais enregistrer la bannière du compte (auto-envoyée),
                        // mais laisser passer les vrais messages (1:1, groupes, soi-même).
                        if (textContent.includes('JOSIHACK BOT')) continue;
                        // Nom exact WhatsApp : pushName, sinon répertoire (LID↔PN).
                        let senderName = 'Me';
                        if (!fromMe) {
                            const senderJid = chatId.endsWith('@g.us')
                                ? rawMsg.key.participant
                                : chatId;
                            if (contacts.isRealName(rawMsg.pushName)) {
                                contacts.upsertContact(senderJid, rawMsg.pushName, 'contact');
                            }
                            contacts.trackFromMessage(rawMsg);
                            senderName = contacts.getDisplayName(senderJid, rawMsg.pushName) || 'Unknown';
                        }
                        const ctx = msgBody.extendedTextMessage?.contextInfo
                            || msgBody.imageMessage?.contextInfo
                            || msgBody.videoMessage?.contextInfo
                            || null;
                        const quoted = ctx?.quotedMessage;
                        const quotedText = quoted
                            ? (quoted.conversation || quoted.extendedTextMessage?.text ||
                               quoted.imageMessage?.caption || quoted.videoMessage?.caption ||
                               quoted.documentMessage?.caption || '')
                            : null;

                        // Add to history (et miroir sous le PN si LID, pour
                        // que l'app ne rate pas le fil selon le JID utilisé).
                        const entry = {
                            id: rawMsg.key.id,
                            text: textContent,
                            fromMe,
                            timestamp: new Date().toISOString(),
                            name: senderName,
                            avatar: null,
                            mediaType: mc ? mc.type : null,
                            mediaName: mc ? (mc.sub.fileName || mc.sub.caption || null) : null,
                            mediaMime: mc ? (mc.sub.mimetype || null) : null,
                            mediaStatus: mc ? 'pending' : undefined,
                            quotedId: ctx?.stanzaId || null,
                            quotedText,
                        };
                        addMessageToHistory(chatId, entry);
                        const alt = contacts.resolvePn(chatId);
                        if (alt && alt !== chatId) {
                            addMessageToHistory(alt, { ...entry });
                        }

                        // Broadcast to WebSocket clients (chip immédiat)
                        broadcastMessage({
                            chatId: chatId,
                            text: textContent,
                            fromMe,
                            name: senderName,
                            avatar: null,
                            id: rawMsg.key.id,
                            mediaType: mc ? mc.type : null,
                            mediaStatus: mc ? 'pending' : undefined,
                            mediaName: mc ? (mc.sub.fileName || mc.sub.caption || null) : null,
                            mediaMime: mc ? (mc.sub.mimetype || null) : null,
                            quotedText,
                        });
                        if (alt && alt !== chatId) {
                            broadcastMessage({
                                chatId: alt,
                                text: textContent,
                                fromMe,
                                name: senderName,
                                avatar: null,
                                id: rawMsg.key.id,
                                mediaType: mc ? mc.type : null,
                                quotedText,
                            });
                        }

                        // Téléchargement asynchrone du média (déjà téléchargé -> patch)
                        if (mc) scheduleMediaDownload(rawMsg, chatId, mc);
                    }
                } catch (capErr) {
                    console.warn('[MIRROR] capture ignorée:', capErr?.message || capErr);
                }
            }

            // Tracker uniquement les vrais messages texte/média envoyés par le bot (pas les réactions/receipts)
            for (const msg of m.messages) {
                contacts.trackFromMessage(msg);
                if (msg.key.fromMe && msg.key.remoteJid && msg.key.id) {
                    const msgType = Object.keys(msg.message || {}).find(k => 
                        ['conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(k)
                    );
                    if (msgType) trackBotMessage(msg.key.remoteJid, msg.key.id);
                }
            }

            // Capturer les messages pour l'Anti-Delete AVANT tout traitement
            await antiDelete.handleUpsert(socket, m);

            // Statuts : TOUT le batch (messages[0] seul manquait les likes)
            for (const sm of m.messages) {
                if (sm?.key?.remoteJid === 'status@broadcast') {
                    try { handleIncomingStatus(socket, sm); }
                    catch (e) { console.error('[STATUS] dispatch:', e?.message || e); }
                }
            }

            const msg = m.messages.find(x =>
                x?.message && x.key?.remoteJid && x.key.remoteJid !== 'status@broadcast'
            );
            if (!msg) return;

            const remoteJid = msg.key.remoteJid;
            const participantJid = msg.key.participant;

            if (!msg.message) return;

            // --- ANTI VUE UNIQUE ---
            let isViewOnce = false;
            let messageTypeStr = "Media";
            let viewOnceMsg = msg;

            const msgKeys = Object.keys(msg.message || {}).filter(k =>
                !['senderKeyDistributionMessage', 'messageContextInfo'].includes(k)
            );

            // Déballer ephemeralMessage si présent
            let workingMessage = msg.message;
            let workingType = msgKeys[0] || '';
            if (workingType === 'ephemeralMessage') {
                workingMessage = workingMessage.ephemeralMessage?.message || workingMessage;
                workingType = Object.keys(workingMessage).filter(k =>
                    !['senderKeyDistributionMessage', 'messageContextInfo'].includes(k)
                )[0] || '';
            }

            // Cas 1 : clé viewOnce* directe (viewOnceMessage, viewOnceMessageV2, viewOnceMessageV2Extension)
            const viewOnceKey = Object.keys(workingMessage || {}).find(k => k.toLowerCase().includes('viewonce'));
            if (viewOnceKey) {
                console.log(`[VIEWONCE] Clé détectée: ${viewOnceKey}`);
                isViewOnce = true;
                const innerMsg = workingMessage[viewOnceKey]?.message;
                if (innerMsg) {
                    const innerType = Object.keys(innerMsg).filter(k =>
                        !['senderKeyDistributionMessage', 'messageContextInfo'].includes(k)
                    )[0] || '';
                    messageTypeStr = innerType;
                    viewOnceMsg = { key: msg.key, message: innerMsg, messageTimestamp: msg.messageTimestamp };
                }
            }

            // Cas 2 : imageMessage/videoMessage/audioMessage avec viewOnce: true
            if (!isViewOnce) {
                for (const key of ['imageMessage', 'videoMessage', 'audioMessage']) {
                    const mediaMsg = workingMessage?.[key];
                    if (mediaMsg?.viewOnce === true) {
                        isViewOnce = true;
                        messageTypeStr = key;
                        viewOnceMsg = { key: msg.key, message: workingMessage, messageTimestamp: msg.messageTimestamp };
                        console.log(`[VIEWONCE] viewOnce:true détecté dans ${key}`);
                        break;
                    }
                }
            }

            if (isViewOnce) {
                console.log(`[VIEWONCE] Vue unique détectée — from: ${participantJid || remoteJid} | type: ${messageTypeStr} | fromMe: ${msg.key.fromMe}`);
                try {
                    const senderPhoneNumber = (participantJid || remoteJid).split('@')[0];
                    const ownerJid = botGroup.captureJid(socket.user.id.split(':')[0] + '@s.whatsapp.net');
                    if (viewOnce.isEnabled()) {
                        let buffer = null;
                        try {
                            buffer = await withTimeout(
                                downloadMediaMessage(
                                    viewOnceMsg,
                                    'buffer', {},
                                    { logger: pino({ level: 'silent' }) }
                                ), 30_000, 'downloadMediaMessage'
                            );
                        } catch (dlErr) {
                            console.error('[VIEWONCE] Échec téléchargement média:', dlErr?.message || dlErr);
                        }

                        // Envoyer sur WhatsApp même si le buffer a échoué
                        if (buffer) {
                            const caption = `👁️ *VUE UNIQUE DÉTECTÉE*\n👤 +${senderPhoneNumber}`;
                            try {
                                if (messageTypeStr.includes('image')) {
                                    await socket.sendMessage(ownerJid, { image: buffer, caption });
                                } else if (messageTypeStr.includes('video')) {
                                    await socket.sendMessage(ownerJid, { video: buffer, caption });
                                } else if (messageTypeStr.includes('audio')) {
                                    await socket.sendMessage(ownerJid, { audio: buffer, mimetype: 'audio/mpeg', ptt: true });
                                }
                            } catch (sendErr) {
                                console.error('[VIEWONCE] Échec envoi WhatsApp:', sendErr?.message || sendErr);
                            }
                        }

                        // Logguer dans tous les cas (avec ou sans buffer)
                        viewOnce.logCapture({
                            id: msg.key.id,
                            senderPhone: senderPhoneNumber,
                            pushName: msg.pushName,
                            messageTypeStr,
                            remoteJid,
                            buffer, // null si le download a échoué
                        });
                    }
                } catch (e) {
                    console.error('[VIEWONCE] Erreur générale:', e?.message || e);
                }
            }

            // --- FILTERS ---
            const isStatus = remoteJid === 'status@broadcast';

            // --- GRACE PERIOD FOR STATUSES (OFFLINE CATCH-UP) ---
            if (msg.messageTimestamp) {
                const msgTime = typeof msg.messageTimestamp === 'object' && msg.messageTimestamp.toNumber ? msg.messageTimestamp.toNumber() : Number(msg.messageTimestamp);

                if (isStatus) {
                    // Pour les statuts, on accepte jusqu'à 30 minutes de retard
                    const thirtyMinutes = 30 * 60;
                    if (msgTime < (botState.botStartTime - thirtyMinutes)) {
                        return;
                    }
                    // Log silencieux pour le catch-up des statuts si nécessaire
                } else {
                    // Tolérance de 5 minutes pour absorber les micro-déconnexions et le clock drift.
                    // Au-delà, on considère que c'est du backlog de session éteinte qu'il faut ignorer.
                    const fiveMinutes = 5 * 60;
                    if (msgTime < (botState.botStartTime - fiveMinutes)) {
                        console.log(`[FILTER] Ignoré commande ancienne (${msg.key.id}) - Ecart: ${botState.botStartTime - msgTime}s`);
                        return;
                    }
                }
            }

            if (!isStatus && m.type !== 'notify') return;

            // Anti-doublon : ignorer si ce message a déjà été traité
            // Les statuts ont leur propre cache (reactedStatusCache), on ne les filtre pas ici
            if (!isStatus && msg.key.id) {
                if (processedMsgCache.has(msg.key.id)) return;
                processedMsgCache.add(msg.key.id);
                botState.stats.messagesProcessed++;
                if (processedMsgCache.size > CACHE_MAX_SIZE) processedMsgCache.delete(processedMsgCache.values().next().value);
            }

            const textContent = msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption ||
                msg.message?.videoMessage?.caption ||
                msg.message?.documentMessage?.caption ||
                "";
            const textLower = textContent.trim().toLowerCase();
            const currentPrefix = config.prefix || "?";
            // Accepte ? et . comme préfixes valides simultanément
            const PREFIXES = [currentPrefix, '.', '?'].filter((p, i, arr) => arr.indexOf(p) === i);
            const usedPrefix = PREFIXES.find(p => textLower.startsWith(p)) || null;
            const isCmd = usedPrefix !== null;
            const cmd = isCmd ? textLower.slice(usedPrefix.length).split(/\s+/)[0] : '';
            const textArgs = isCmd ? textContent.slice(usedPrefix.length + cmd.length).trim() : '';

            // --- COMMANDS ---
            const senderJid = participantJid || remoteJid;
            const isOwner = msg.key.fromMe || (config.owners && config.owners.some(o => senderJid.includes(o)));
            const cc = config.customCommands || { vv: 'vv', vv2: 'vv2', nice: 'nice' };

            // --- STICKER DÉCLENCHEUR : répondre à une vue unique avec un sticker enregistré ---
            const triggerSticker = workingMessage?.stickerMessage;
            if (triggerSticker && isOwner) {
                const triggerCtx = triggerSticker.contextInfo;
                if (triggerCtx?.quotedMessage && botGroup.isTrigger(botGroup.stickerId(triggerSticker.fileSha256))) {
                    const botJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                    console.log(`[STICKER] déclencheur reconnu dans ${remoteJid}`);
                    await decodeQuotedViewOnce(socket, msg, remoteJid, triggerCtx, triggerCtx.quotedMessage, botGroup.captureJid(botJid), botGroup.captureJid(botJid));
                    return;
                }
            }

            if (isCmd) {
                console.log(`[CMD] "${textContent}" de ${senderJid} (isOwner: ${isOwner})`);
                if (!isOwner) console.log(`[SECURITY] Command denied for ${senderJid}`);
            }

            if (isOwner && isCmd) {
                const selfJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                const targetChat = isStatus
                    ? selfJid
                    : botGroup.replyJid({ remoteJid, fromMe: !!msg.key.fromMe, selfJid });

                if (cmd === 'josistatus' || cmd === 'likestatus' || cmd === 'likestatusuni') {
                    const arg = textContent.slice(usedPrefix.length + cmd.length).trim();
                    const argLower = arg.toLowerCase();
                    const argWord = argLower.split(/\s+/)[0];
                    // Alias `likestatus` : mêmes trois formes que `josistatusuni`
                    // dans le bot de référence — emoji, off, ou rien.
                    if (cmd === 'likestatus' && !arg) {
                        await socket.sendMessage(targetChat, { text: statusSettingsHelp(currentPrefix) }, { quoted: msg });
                        return;
                    }

                    // Sans argument : affiche l'état, ne modifie RIEN (avant, cela
                    // basculait l'auto-like et le coupait lors d'un simple contrôle).
                    if (cmd === 'josistatus' && !argWord) {
                        const statusText = `📊 *STATUS BOT*\n` +
                            `- Auto-Like : ${botState.isActivelyLiking ? 'ON ✅' : 'OFF ❌'}\n` +
                            `- View-Only : ${botState.isViewOnly ? 'ON 👁️' : 'OFF ❌'}\n` +
                            `- Emoji Fixé : ${botState.fixedEmoji || 'Aléatoire 🎲'}`;
                        await socket.sendMessage(targetChat, { text: statusText }, { quoted: msg });
                        return;
                    }

                    if (argWord === 'on' || argWord === 'off') {
                        const on = argWord === 'on';
                        botState.isActivelyLiking = on;
                        if (on) botState.isViewOnly = false;
                        statusSettingsStore.save({
                            isActivelyLiking: botState.isActivelyLiking,
                            isViewOnly: botState.isViewOnly,
                        });
                        const statusText = `📊 *STATUS BOT*\n` +
                            `- Auto-Like : ${botState.isActivelyLiking ? 'ON ✅' : 'OFF ❌'}\n` +
                            `- View-Only : ${botState.isViewOnly ? 'ON 👁️' : 'OFF ❌'}\n` +
                            `- Emoji Fixé : ${botState.fixedEmoji || 'Aléatoire 🎲'}`;
                        await socket.sendMessage(targetChat, { text: statusText }, { quoted: msg });
                        return;
                    }

                    // `random` remet l'emoji en tirage au sort. Traité avant la
                    // validation d'emoji, sinon il tomberait sur l'aide : le
                    // mot n'est pas un émoji.
                    if (argWord === 'random') {
                        botState.fixedEmoji = null;
                        statusSettingsStore.save({ fixedEmoji: null });
                        await socket.sendMessage(targetChat, { text: `✅ Mode Aléatoire 🎲` }, { quoted: msg });
                        return;
                    }

                    // josistatus on/off et josistatusuni on/off sont couverts
                    // ci-dessus. Pour un emoji, on valide qu'il s'agit bien d'un
                    // seul émoji avant de l'enregistrer.
                    if (arg) {
                        const isEmojiOnly = /^(?:\p{Emoji}(?:\p{Emoji_Modifier}?|\uFE0F)?(?:\u200D\p{Emoji})*)$/u.test(arg);
                        if (!isEmojiOnly) {
                            await socket.sendMessage(targetChat, { text: statusSettingsHelp(currentPrefix) }, { quoted: msg });
                            return;
                        }
                        botState.fixedEmoji = arg;
                        botState.isActivelyLiking = true;
                        botState.isViewOnly = false;
                        statusSettingsStore.save({
                            fixedEmoji: botState.fixedEmoji,
                            isActivelyLiking: true,
                            isViewOnly: false,
                        });
                        await socket.sendMessage(targetChat, { text: `✅ Emoji fixé : ${botState.fixedEmoji}` }, { quoted: msg });
                        return;
                    }

                    const statusText = `📊 *STATUS BOT*\n` +
                        `- Auto-Like : ${botState.isActivelyLiking ? 'ON ✅' : 'OFF ❌'}\n` +
                        `- View-Only : ${botState.isViewOnly ? 'ON 👁️' : 'OFF ❌'}\n` +
                        `- Emoji Fixé : ${botState.fixedEmoji || 'Aléatoire 🎲'}`;
                    await socket.sendMessage(targetChat, { text: statusText }, { quoted: msg });
                } else if (cmd === 'josiview') {
                    const arg = textLower.split(/\s+/)[1];
                    if (arg === 'on') {
                        botState.isViewOnly = true;
                        botState.isActivelyLiking = false;
                        await socket.sendMessage(targetChat, { text: `[SYSTEM] View-Only : ON ✅` }, { quoted: msg });
                    } else if (arg === 'off') {
                        botState.isViewOnly = false;
                        await socket.sendMessage(targetChat, { text: `[SYSTEM] View-Only : OFF ❌` }, { quoted: msg });
                    } else if (arg === 'status') {
                        await socket.sendMessage(targetChat, { text: `📊 Status View-Only: ${botState.isViewOnly ? "ON ✅" : "OFF ❌"}` }, { quoted: msg });
                    } else {
                        botState.isViewOnly = !botState.isViewOnly;
                        if (botState.isViewOnly) botState.isActivelyLiking = false;
                        await socket.sendMessage(targetChat, { text: `[SYSTEM] View-Only : ${botState.isViewOnly ? "ON ✅" : "OFF ❌"}` }, { quoted: msg });
                    }
                } else if (cmd === 'josiconnect') {
                    const arg = textLower.split(/\s+/)[1];
                    if (arg === 'on') {
                        config.sendWelcomeMessage = true;
                        await socket.sendMessage(targetChat, { text: `✅ Message de connexion activé.` }, { quoted: msg });
                    } else if (arg === 'off') {
                        config.sendWelcomeMessage = false;
                        await socket.sendMessage(targetChat, { text: `❌ Message de connexion désactivé.` }, { quoted: msg });
                    }
                } else if (cmd === 'josidelay') {
                    const args = textLower.split(/\s+/).slice(1);
                    if (args.length === 0 || args[0] === 'status') {
                        // Afficher le délai actuel
                        const modeText = botState.statusDelayMode === 'fixed'
                            ? `Fixe : *${botState.statusDelayFixed / 1000}s*`
                            : `Aléatoire : *${botState.statusDelayMin / 1000}s* → *${botState.statusDelayMax / 1000}s*`;
                        await socket.sendMessage(targetChat, {
                            text: `⏱️ *DÉLAI STATUTS*\n` +
                                  `- Mode : ${botState.statusDelayMode === 'fixed' ? 'Fixe ⏰' : 'Aléatoire 🎲'}\n` +
                                  `- Délai : ${modeText}\n\n` +
                                  `💡 *Utilisation :*\n` +
                                  `• \`${currentPrefix}josidelay <secondes>\` → délai fixe\n` +
                                  `• \`${currentPrefix}josidelay <min> <max>\` → délai aléatoire\n` +
                                  `• \`${currentPrefix}josidelay random\` → reset aléatoire (2s-6s)`
                        }, { quoted: msg });
                    } else if (args[0] === 'random') {
                        // Reset au mode aléatoire par défaut
                        botState.statusDelayMode = 'random';
                        botState.statusDelayMin = 2000;
                        botState.statusDelayMax = 6000;
                        await socket.sendMessage(targetChat, {
                            text: `✅ Délai remis en mode *Aléatoire* (2s → 6s) 🎲`
                        }, { quoted: msg });
                    } else if (args.length === 1) {
                        // Délai fixe : ?josidelay 5
                        const seconds = parseFloat(args[0]);
                        if (isNaN(seconds) || seconds < 0 || seconds > 300) {
                            await socket.sendMessage(targetChat, {
                                text: `❌ Valeur invalide. Entrez un nombre entre *0* et *300* secondes.`
                            }, { quoted: msg });
                        } else {
                            botState.statusDelayMode = 'fixed';
                            botState.statusDelayFixed = Math.round(seconds * 1000);
                            await socket.sendMessage(targetChat, {
                                text: `✅ Délai fixé à *${seconds}s* ⏰`
                            }, { quoted: msg });
                        }
                    } else if (args.length >= 2) {
                        // Délai aléatoire : ?josidelay 3 10
                        const minSec = parseFloat(args[0]);
                        const maxSec = parseFloat(args[1]);
                        if (isNaN(minSec) || isNaN(maxSec) || minSec < 0 || maxSec > 300 || minSec >= maxSec) {
                            await socket.sendMessage(targetChat, {
                                text: `❌ Valeurs invalides. Le minimum doit être inférieur au maximum, entre *0* et *300* secondes.`
                            }, { quoted: msg });
                        } else {
                            botState.statusDelayMode = 'random';
                            botState.statusDelayMin = Math.round(minSec * 1000);
                            botState.statusDelayMax = Math.round(maxSec * 1000);
                            await socket.sendMessage(targetChat, {
                                text: `✅ Délai aléatoire : *${minSec}s* → *${maxSec}s* 🎲`
                            }, { quoted: msg });
                        }
                    }
                } else if (cmd === 'setprefix') {
                    const newPrefix = textArgs.split(/\s+/)[0];
                    if (newPrefix) {
                        config.prefix = newPrefix;
                        const fs = require('fs');
                        let configStr = fs.readFileSync('./config.js', 'utf8');
                        configStr = configStr.replace(/prefix:\s*['"][^'"]*['"]/, `prefix: "${newPrefix}"`);
                        fs.writeFileSync('./config.js', configStr);
                        await socket.sendMessage(targetChat, { text: `✅ Préfixe changé pour '${newPrefix}'.` }, { quoted: msg });
                    } else {
                        await socket.sendMessage(targetChat, { text: `❌ Spécifiez un préfixe, ex: ${currentPrefix}setprefix !` }, { quoted: msg });
                    }
                } else if (cmd === 'tagall') {
                    await tagAll.executeTagAll(socket, msg);
                } else if (cmd === 'ss') {
                    await screenshot.executeScreenshot(socket, msg);
                } else if (cmd === 'fb' || cmd === 'facebook' || cmd === 'fbdl') {
                    await facebook.executeFacebook(socket, msg);
                } else if (cmd === 'yt' || cmd === 'play' || cmd === 'song') {
                    await youtube.executeYouTube(socket, msg, 'audio');
                } else if (cmd === 'playvid' || cmd === 'ytv' || cmd === 'video') {
                    await youtube.executeYouTube(socket, msg, 'video');
                } else if (cmd === 'host') {
                    await hostCmd.executeHost(socket, msg, config);
                } else if (cmd === 'ping') {
                    await pingCmd.executePing(socket, msg);
                } else if (cmd === 'tiktok' || cmd === 'tk' || cmd === 'tt') {
                    await tiktok.executeTikTok(socket, msg);
                } else if (cmd === 'clear') {
                    const list = botMessageCache.get(targetChat) || [];
                    if (list.length === 0) {
                        await socket.sendMessage(targetChat, { text: "🧹 Aucun message du bot à supprimer." }, { quoted: msg });
                    } else {
                        let deleted = 0;
                        for (const msgId of list) {
                            try {
                                await socket.sendMessage(targetChat, {
                                    delete: { remoteJid: targetChat, id: msgId, fromMe: true }
                                });
                                deleted++;
                                await new Promise(r => setTimeout(r, 300)); // petit délai pour éviter le rate limit
                            } catch (e) { /* message déjà supprimé ou expiré */ }
                        }
                        botMessageCache.set(targetChat, []);
                        await socket.sendMessage(targetChat, { text: `🧹 ${deleted} message(s) du bot supprimé(s).` }, { quoted: msg });
                    }
                } else if (cmd === 'antidelete') {
                    const arg = textLower.split(/\s+/)[1];
                    if (arg === 'on') {
                        config.antiDeleteEnabled = true;
                        await socket.sendMessage(targetChat, { text: `✅ Anti-Delete activé.` }, { quoted: msg });
                    } else if (arg === 'off') {
                        config.antiDeleteEnabled = false;
                        await socket.sendMessage(targetChat, { text: `❌ Anti-Delete désactivé.` }, { quoted: msg });
                    } else if (arg === 'status') {
                        await socket.sendMessage(targetChat, { text: `📊 Status Anti-Delete: ${config.antiDeleteEnabled ? "ON ✅" : "OFF ❌"}` }, { quoted: msg });
                    }
                } else if (cmd === 'menu') {
                    const arg = textLower.split(/\s+/)[1];
                    const uptimeSeconds = process.uptime();
                    const uptime = `${Math.floor(uptimeSeconds / 3600)}ʜ ${Math.floor((uptimeSeconds % 3600) / 60)}ᴍ ${Math.floor(uptimeSeconds % 60)}s`;
                    const now = new Date();
                    const year = now.getFullYear();
                    const date = now.toLocaleDateString('fr-FR');
                    const heure = now.toLocaleTimeString('fr-FR');

                    const categories = {
                        '1': { name: 'ᴄᴏɴғɪɢᴜʀᴀᴛɪᴏɴ', cmds: [
                            `├ ߷ ${currentPrefix}setprefix   ➜ ᴄʜᴀɴɢᴇʀ ʟᴇ ᴘʀéғɪxᴇ`,
                            `├ ߷ ${currentPrefix}josiconnect ➜ ᴍsɢ ᴄᴏɴɴᴇxɪᴏɴ ᴏɴ/ᴏғғ`,
                        ]},
                        '2': { name: 'sᴛᴀᴛᴜᴛs', cmds: [
                            `├ ߷ ${currentPrefix}josistatus    ➜ ᴀᴜᴛᴏ-ʟɪᴋᴇ ᴏɴ/ᴏғғ`,
                            `├ ߷ ${currentPrefix}josiview      ➜ ᴠɪᴇᴡ-ᴏɴʟʏ ᴏɴ/ᴏғғ`,
                            `├ ߷ ${currentPrefix}josistatusuni ➜ ᴇᴍᴏᴊɪ ғɪxé / ʀᴀɴᴅᴏᴍ`,
                            `├ ߷ ${currentPrefix}likestatus   ➜ ᴀʟɪᴀs ᴇᴍᴏᴊɪ / ʜᴇʟᴘ`,
                            `├ ߷ ${currentPrefix}josidelay     ➜ ᴅéʟᴀɪ ᴀᴠᴀɴᴛ ʟɪᴋᴇ/ᴠᴜᴇ`,
                        ]},
                        '3': { name: 'ᴛéʟéᴄʜᴀʀɢᴇᴍᴇɴᴛ', cmds: [
                            `├ ߷ ${currentPrefix}fb     ➜ ᴠɪᴅéᴏ ғᴀᴄᴇʙᴏᴏᴋ`,
                            `├ ߷ ${currentPrefix}tiktok ➜ ᴠɪᴅéᴏ ᴛɪᴋᴛᴏᴋ`,
                        ]},
                        '4': { name: 'ɢʀᴏᴜᴘᴇ', cmds: [
                            `├ ߷ ${currentPrefix}tagall ➜ ᴍᴇɴᴛɪᴏɴɴᴇʀ ᴛᴏᴜs`,
                        ]},
                        '5': { name: 'sʏsᴛèᴍᴇ', cmds: [
                            `├ ߷ ${currentPrefix}host  ➜ ɪɴғᴏs sᴇʀᴠᴇᴜʀ`,
                            `├ ߷ ${currentPrefix}ping  ➜ ʟᴀᴛᴇɴᴄᴇ ʙᴏᴛ`,
                            `├ ߷ ${currentPrefix}clear ➜ sᴜᴘᴘʀɪᴍᴇʀ ᴍsɢs ʙᴏᴛ`,
                        ]},
                        '6': { name: 'ᴀɴᴛɪ-ᴅᴇʟᴇᴛᴇ', cmds: [
                            `├ ߷ ${currentPrefix}antidelete ➜ ᴏɴ / ᴏғғ / sᴛᴀᴛᴜs`,
                        ]},
                        '7': { name: 'ᴠᴜᴇ ᴜɴɪQᴜᴇ', cmds: [
                            `├ ߷ ${currentPrefix}${cc.vv}   ➜ ᴇɴᴠᴏʏᴇʀ ɪᴄɪ`,
                            `├ ߷ ${currentPrefix}${cc.vv2}  ➜ ᴍᴏɴ ɪɴʙᴏx`,
                            `├ ߷ ${currentPrefix}${cc.nice} ➜ ᴀᴅᴍɪɴ ɪɴʙᴏx`,
                        ]},
                    };

                    let catKey = null;
                    if (arg) {
                        catKey = categories[arg] ? arg : Object.keys(categories).find(k =>
                            categories[k].name.toLowerCase().includes(arg.toLowerCase())
                        );
                    }

                    if (catKey) {
                        const cat = categories[catKey];
                        const catText = `╭──⟪ ${cat.name} ⟫──╮\n${cat.cmds.join('\n')}\n╰────────────────────╯\n\n> ©️ ${year} ᴊᴏsɪʜᴀᴄᴋ ʙᴏᴛ`;
                        await socket.sendMessage(targetChat, { text: catText }, { quoted: msg });
                    } else {
                        const menuText = `╭──⟪ ᴊᴏsɪʜᴀᴄᴋ ʙᴏᴛ ⟫──╮\n├ ߷ ᴘʀéғɪxᴇ    : ${currentPrefix}\n├ ߷ ᴏᴡɴᴇʀ      : ᴊᴏsɪ-ʜᴀᴄᴋ\n├ ߷ ᴜᴘᴛɪᴍᴇ     : ${uptime}\n├ ߷ ᴅᴀᴛᴇ       : ${date}\n├ ߷ ʜᴇᴜʀᴇ      : ${heure}\n├ ߷ ᴠᴇʀsɪᴏɴ    : 2.0.0\n╰──────────────────╯\n\n╭───⟪ ᴄᴀᴛéɢᴏʀɪᴇs ⟫───╮\n├ ߷ 1 • ᴄᴏɴғɪɢᴜʀᴀᴛɪᴏɴ\n├ ߷ 2 • sᴛᴀᴛᴜᴛs\n├ ߷ 3 • ᴛéʟéᴄʜᴀʀɢᴇᴍᴇɴᴛ\n├ ߷ 4 • ɢʀᴏᴜᴘᴇ\n├ ߷ 5 • sʏsᴛèᴍᴇ\n├ ߷ 6 • ᴀɴᴛɪ-ᴅᴇʟᴇᴛᴇ\n├ ߷ 7 • ᴠᴜᴇ ᴜɴɪQᴜᴇ\n╰───────────────────╯\n\n💡 *?menu <numéro>* ᴘᴏᴜʀ ᴠᴏɪʀ ʟᴇs ᴄᴏᴍᴍᴀɴᴅᴇs\n\n> ©️ ${year} ᴊᴏsɪʜᴀᴄᴋ ʙᴏᴛ`;
                        await socket.sendMessage(targetChat, { text: menuText }, { quoted: msg });
                    }
                }

                // --- STICKERS DÉCLENCHEURS : ajouter / retirer en répondant au sticker ---
                if (cmd === 'addsticker' || cmd === 'delsticker') {
                    const stCtx = msg.message.extendedTextMessage?.contextInfo;
                    const stQuoted = stCtx?.quotedMessage?.stickerMessage;
                    if (!stQuoted) {
                        return await socket.sendMessage(targetChat, { text: `❌ Réponds à un sticker avec ${usedPrefix}${cmd}.` }, { quoted: msg });
                    }
                    const stId = botGroup.stickerId(stQuoted.fileSha256);
                    if (cmd === 'delsticker') {
                        const removed = botGroup.removeSticker(stId);
                        return await socket.sendMessage(targetChat, { text: removed ? '✅ Sticker retiré.' : '❌ Ce sticker n\'est pas enregistré.' }, { quoted: msg });
                    }
                    let preview = null;
                    try {
                        preview = await withTimeout(downloadMediaMessage(
                            { key: { remoteJid, id: stCtx.stanzaId, participant: stCtx.participant || null }, message: { stickerMessage: stQuoted } },
                            'buffer', {}, { logger: pino({ level: 'silent' }) },
                        ), 20_000, 'downloadMediaMessage');
                    } catch (e) {
                        console.warn('[STICKER] aperçu indisponible:', e?.message || e);
                    }
                    const res = botGroup.addSticker(stId, preview);
                    const text = res.added ? '✅ Sticker déclencheur ajouté.'
                        : res.reason === 'duplicate' ? 'ℹ️ Ce sticker est déjà enregistré.'
                        : res.reason === 'full' ? `❌ Maximum atteint (${botGroup.MAX_STICKERS} stickers).`
                        : '❌ Sticker illisible.';
                    return await socket.sendMessage(targetChat, { text }, { quoted: msg });
                }

                // --- DOWNLOADER COMMANDS ---
                const vCommands = [cc.vv, cc.vv2, cc.nice];
                if (vCommands.includes(cmd)) {
                    const contextInfo = msg.message.extendedTextMessage?.contextInfo;
                    const quoted = contextInfo?.quotedMessage;
                    if (!quoted) return await socket.sendMessage(targetChat, { text: "❌ Répondez à une Vue Unique." }, targetChat === remoteJid ? { quoted: msg } : {});

                    const botJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                    const ownerJid = (config.owners ? config.owners[0] : "") + '@s.whatsapp.net';
                    let targetJid = remoteJid;
                    if (cmd === cc.vv2) targetJid = botGroup.captureJid(botJid);
                    if (cmd === cc.nice) targetJid = botGroup.captureJid(ownerJid);
                    await decodeQuotedViewOnce(socket, msg, remoteJid, contextInfo, quoted, targetJid, targetChat);
                }
            }

            // --- STATUS HANDLING : déplacé en tête de lot (handleIncomingStatus) ---
        } catch (error) { console.error('[ERROR] Upsert loop:', error.message); }
    });
}

/** Attend que le WebSocket d'un socket Baileys soit ouvert (session vierge),
 *  puis demande le code d'association pour `phone` et le livre au deferred. */
function waitForSocketReady(socket, phone) {
    let timer = null;
    let pairingRequestSent = false;
    let finished = false;
    const requestCode = async () => {
        if (finished || pairingRequestSent) return;
        pairingRequestSent = true;
        try {
            const code = await socket.requestPairingCode(phone);
            finish(null, code);
        } catch (e) {
            finish(e);
        }
    };
    const onConnectionUpdate = (update) => {
        // En session vierge, `open` n'arrive qu'après l'association. Baileys
        // émet d'abord `qr`, qui signifie que le canal est prêt pour
        // requestPairingCode (documentation officielle).
        if (update?.qr) requestCode();
        if (update?.connection === 'close' && !finished) {
            const statusCode = update.lastDisconnect?.error?.output?.statusCode;
            finish(new Error(`Session fermée pendant l'association (${statusCode || 'socket'}).`));
        }
    };
    const finish = (err, code) => {
        if (finished) return;
        finished = true;
        if (err) console.error('[PAIR-PENDING]', err?.message || err);
        if (botState.pendingPairPhone === phone) botState.pendingPairPhone = null;
        clearTimeout(timer);
        socket.ev.off?.('connection.update', onConnectionUpdate);
        if (err) {
            botState.lastPairError = String(err?.message || err);
            botState.pairingDeferred?.reject(err);
        } else if (code) {
            botState.pairingCode = code;
            botState.pairingPhone = phone;
            botState.pairingRequestedAt = Date.now();
            botState.lastPairError = null;
            console.log(`\n========================================`);
            console.log(`[ACTION REQUIRED] Your Pairing Code: ${code}`);
            console.log(`========================================\n`);
            botState.pairingDeferred?.resolve({ code, expiresIn: botState.pairingExpiresIn });
        }
        botState.pairingDeferred = null;
    };
    socket.ev.on('connection.update', onConnectionUpdate);
    timer = setTimeout(
        () => finish(new Error('Le serveur tardait à établir le canal WhatsApp.')),
        60_000,
    );
    timer.unref?.();
}

/** Forcé par api.js après avoir effacé la session : redémarre la connexion
 *  Baileys immédiatement (annule tout reconnect programmé). */
botState.__restartBotConnection = () => {
    if (connectRetryTimer) { clearTimeout(connectRetryTimer); connectRetryTimer = null; }
    triggerConnect();
};

// --- EXPRESS SERVER + API REST ---
const app = express();
const PORT = process.env.PORT || config.apiPort || 3000;

setupApi(app);

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] ✅ Serveur prêt sur le port ${PORT}`);
    bootBot().catch(err => console.log("[FATAL]", err));
});
attachWebSocket(server);

/** Démarrage : charge les listes blanche/noire durables, puis connecte WhatsApp. */
/** Aide des commandes de like de statuts, dans l'esprit du bot de référence. */
function statusSettingsHelp(prefix) {
    return `🔧 *Paramètres du like auto sur statuts :*\n\n` +
        `• *${prefix}josistatus* ➜ affiche l'état (on|off pour changer)\n` +
        `• *${prefix}josistatus on|off* ➜ active / désactive\n` +
        `• *${prefix}josistatusuni <emoji>* ➜ emoji fixe\n` +
        `• *${prefix}josistatusuni random* ➜ emoji aléatoire\n` +
        `• *${prefix}josiview on|off* ➜ voir sans aimer\n` +
        `• *${prefix}likestatus <emoji>* ➜ alias de josistatusuni\n\n` +
        `📌 *Exemple :* ${prefix}likestatus 🤣`;
}

async function bootBot() {
    await statusSeenStore.load();
    // Réglages du like de statuts : ils vivaient en mémoire, donc un
    // redéploiement remettait l'auto-like et l'emoji à zéro. On les restaure
    // avant de connecter WhatsApp, sinon handleIncomingStatus tournerait avec
    // les valeurs par défaut pendant toute la phase de connexion.
    try {
        await botGroup.load();
        await airplane.load();
        await ghost.load();
        await scheduler.load();
        const saved = await statusSettingsStore.load();
        botState.isActivelyLiking = saved.isActivelyLiking;
        botState.isViewOnly = saved.isViewOnly;
        botState.fixedEmoji = saved.fixedEmoji;
        botState.statusDelayMode = saved.statusDelayMode;
        botState.statusDelayMin = saved.statusDelayMin;
        botState.statusDelayMax = saved.statusDelayMax;
        botState.statusDelayFixed = saved.statusDelayFixed;
    } catch (e) {
        console.warn('[StatusSettings] Application ignorée:', e.message);
    }
    try {
        const saved = await filtersStore.loadFilters();
        if (saved) {
            if (Array.isArray(saved.whitelist)) config.whitelist = saved.whitelist;
            if (Array.isArray(saved.blacklist)) config.blacklist = saved.blacklist;
            console.log(`[Filters] Listes durables chargées — blanc: ${config.whitelist.length}, noir: ${config.blacklist.length}`);
        }
    } catch (e) {
        console.warn('[Filters] Chargement ignoré:', e.message);
    }
    try {
        const restored = await chatHistoryStore.loadChatHistory();
        if (restored) {
            hydrateChatHistory(restored);
            console.log(`[History] Discussions restaurées — ${Object.keys(restored).length} fil(s)`);
        }
    } catch (e) {
        console.warn('[History] Restauration ignorée:', e.message);
    }
    await connectToWhatsApp();
}

// --- SHUTDOWN HANDLING ---
process.on('SIGTERM', async () => {
    console.log('[SIGTERM] Arrêt propre...');
    try { if (botState.activeSocket) botState.activeSocket.ws.close(); } catch (e) { }
    await flushChatHistory().catch(() => { });
    await sessionLock.release();
    server.close(() => process.exit(0));
});

process.on('SIGINT', async () => {
    console.log('[SIGINT] Arrêt propre...');
    try { if (botState.activeSocket) botState.activeSocket.ws.close(); } catch (e) { }
    await flushChatHistory().catch(() => { });
    await sessionLock.release();
    server.close(() => process.exit(0));
});

// --- KEEP ALIVE OPTIMISÉ POUR RENDER ---
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || "";
if (RENDER_URL) {
    console.log(`[KEEP-ALIVE] 🔄 Pinging ${RENDER_URL} toutes les 4 minutes`);
    // Toutes les 4 minutes (moins que le timeout de 15min de Render)
    setInterval(async () => {
        try {
            await fetch(`${RENDER_URL}/health`, {
                method: 'GET',
                headers: { 'User-Agent': 'JosiHackBot/1.0 (Keep-Alive)' }
            });
        } catch (e) {
            console.error('[KEEP-ALIVE] ❌ Erreur:', e.message);
        }
    }, 4 * 60 * 1000); // 4 minutes
}
