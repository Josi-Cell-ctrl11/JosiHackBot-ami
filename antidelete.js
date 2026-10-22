const { downloadMediaMessage, proto } = require('@whiskeysockets/baileys');
const config = require('./config.js');
const pino = require('pino');
const { withTimeout } = require('./withTimeout.js');
const botGroup = require('./botGroup.js');

let messageCache = new Map();
const CACHE_LIMIT = 2000;

/** Journal des messages supprimés pour l'API REST */
const deletedLogs = [];
const LOGS_LIMIT = 100;

// Une même suppression arrive par messages.upsert (protocolMessage) ET par
// messages.update (stub) : sans dédoublonnage, le rapport partait deux fois.
const reportedRevocations = new Map(); // id -> timestamp (ms)
const REPORTED_TTL_MS = 5 * 60 * 1000;

const REVOKE_TYPE = proto?.Message?.ProtocolMessage?.Type?.REVOKE ?? 0;
const EDIT_TYPE = proto?.Message?.ProtocolMessage?.Type?.MESSAGE_EDIT ?? 14;

// Une modification arrive par messages.upsert ET messages.update.
const reportedEdits = new Map(); // `${id}:${nouveau texte}` -> timestamp (ms)

function pushDeletedLog(entry) {
    deletedLogs.unshift(entry);
    if (deletedLogs.length > LOGS_LIMIT) deletedLogs.pop();
    try {
        const liveEvents = require('./liveEvents.js');
        liveEvents.pushEvent('antidelete', {
            id: entry.id,
            from: entry.from,
            preview: entry.preview,
            type: entry.type,
        });
    } catch (_) {}
}

function getLogs() {
    return deletedLogs.map(({ mediaBase64, ...rest }) => ({
        ...rest,
        hasMedia: !!mediaBase64,
    }));
}

function getLogById(id) {
    return deletedLogs.find(e => e.id === id) || null;
}

function destinationJid(sock) {
    const botJid = sock?.user?.id
        ? `${sock.user.id.split(':')[0].split('@')[0]}@s.whatsapp.net`
        : null;
    // Toujours préférer le numéro réellement connecté : antiDeleteChat peut
    // pointer vers un ancien compte et faire échouer l'envoi (et donc les logs).
    return botJid || config.antiDeleteChat || null;
}

function isRevokeProtocol(protocolMsg) {
    if (!protocolMsg) return false;
    const t = protocolMsg.type;
    return t === REVOKE_TYPE || t === 0 || t === 'REVOKE' || t === 3;
}

function isEditProtocol(protocolMsg) {
    if (!protocolMsg) return false;
    const t = protocolMsg.type;
    return t === EDIT_TYPE || t === 14 || t === 'MESSAGE_EDIT';
}

/** Texte (ou légende) d'un contenu de message, enveloppes éphémères comprises. */
function textOfContent(message) {
    let body = message || {};
    body = body.ephemeralMessage?.message || body;
    body = body.editedMessage?.message || body;
    return body.conversation
        || body.extendedTextMessage?.text
        || body.imageMessage?.caption
        || body.videoMessage?.caption
        || body.documentMessage?.caption
        || '';
}

const MEDIA_LABEL = { image: 'Image', video: 'Vidéo', document: 'Document' };

/**
 * Message modifié : renvoie l'ancienne et la nouvelle version dans le groupe
 * privé (ou la discussion avec soi-même s'il n'est pas activé).
 */
/**
 * Recherche de secours de l'original dans l'historique durable des
 * discussions (sauvegardé dans Supabase) : le cache en mémoire se vide à
 * chaque redémarrage du bot. Branchée par index.js, null dans les tests.
 */
let historyLookup = null;
function setHistoryLookup(fn) {
    historyLookup = typeof fn === 'function' ? fn : null;
}

const reportEdit = async (sock, { id, newMessage, key }) => {
    if (!config.antiDeleteEnabled) return;
    if (!id || key?.fromMe) return;

    const newText = textOfContent(newMessage);
    if (!newText) return;

    let cached = messageCache.get(id);
    if (!cached) {
        // Le bot a redémarré depuis l'arrivée du message : on cherche
        // l'ancien texte dans l'historique des discussions.
        let found = null;
        try { found = historyLookup ? historyLookup(key?.remoteJid, id) : null; } catch (_) { found = null; }
        const chat = key?.remoteJid || found?.chatId || '';
        const from = key?.participant || key?.participantPn || chat;
        cached = {
            from,
            pushName: found?.name && found.name !== 'Unknown' ? found.name : '',
            chat,
            content: found?.text || '',
            timestamp: null,
            id,
            mediaType: null,
            unknownBefore: !found?.text,
        };
        messageCache.set(id, cached);
        console.log(`[ANTIEDIT] ${id} — pas en cache, ${found?.text ? 'retrouvé dans l\'historique' : 'ancien texte inconnu'}`);
    }

    const label = MEDIA_LABEL[cached.mediaType];
    const before = cached.content;
    const after = label ? `[${label}] ${newText}` : newText;
    if (after === before) return;

    // Réserve avant tout await : le 2e événement doit être ignoré.
    const nowMs = Date.now();
    for (const [k, t] of reportedEdits) {
        if (nowMs - t > REPORTED_TTL_MS) reportedEdits.delete(k);
    }
    const dedupKey = `${id}:${newText}`;
    if (reportedEdits.has(dedupKey)) return;
    reportedEdits.set(dedupKey, nowMs);

    // La prochaine modification se compare à cette version-ci.
    const unknownBefore = !!cached.unknownBefore;
    cached.content = after;
    cached.unknownBefore = false;

    const sender = String(cached.from || '').split('@')[0].split(':')[0];
    const senderName = cached.pushName || sender || '?';
    const source = cached.chat?.endsWith('@g.us')
        ? 'Groupe'
        : (cached.chat === 'status@broadcast' ? 'Statut' : 'Privé');
    const time = new Date().toLocaleString('fr-FR');
    const beforeText = unknownBefore
        ? '(inconnu : message reçu avant le redémarrage du bot)'
        : before;

    pushDeletedLog({
        id: `edit-${id}-${nowMs}`,
        from: senderName,
        phone: sender,
        type: 'Modifié',
        preview: after,
        before: beforeText,
        time,
        timestamp: Math.floor(nowMs / 1000),
        chat: cached.chat,
        mediaBase64: null,
        mediaMime: null,
    });

    const text = `━━━━❪ ✏️ *MESSAGE MODIFIÉ* ❫━━━━\n` +
        `👤 *Auteur:* ${senderName} (+${sender})\n` +
        `📍 *Source:* ${source}\n` +
        `⏰ *Heure:* ${time}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `❌ *Avant:* ${beforeText}\n` +
        `✅ *Après:* ${after}`;

    const fallback = destinationJid(sock);
    const destination = botGroup.captureJid(fallback);
    if (!destination) return;
    try {
        await sock.sendMessage(destination, { text });
        console.log(`[ANTIEDIT] Rapport envoyé pour ${id} → ${destination}`);
    } catch (e) {
        console.error('[ANTIEDIT] Send error:', e?.message || e);
    }
};

const reportRevocation = async (sock, deletedId) => {
    if (!config.antiDeleteEnabled) return;
    if (!deletedId) return;

    const cached = messageCache.get(deletedId);
    if (!cached) {
        console.log(`[ANTIDELETE] revoke ${deletedId} — pas en cache`);
        return;
    }

    // Réserve l'id AVANT tout await : le 2e événement (upsert/update) arrive
    // quelques millisecondes après et doit être ignoré.
    const nowMs = Date.now();
    for (const [k, t] of reportedRevocations) {
        if (nowMs - t > REPORTED_TTL_MS) reportedRevocations.delete(k);
    }
    if (reportedRevocations.has(deletedId)) {
        console.log(`[ANTIDELETE] doublon ignoré ${deletedId}`);
        return;
    }
    reportedRevocations.set(deletedId, nowMs);

    const sender = String(cached.from || '').split('@')[0].split(':')[0];
    const senderName = cached.pushName || sender || '?';
    const chatName = cached.chat?.endsWith('@g.us')
        ? 'Groupe'
        : (cached.chat === 'status@broadcast' ? 'Statut' : 'Privé');
    const time = new Date((Number(cached.timestamp) || Date.now() / 1000) * 1000)
        .toLocaleString('fr-FR');

    const mediaMime = cached.mediaType === 'image' ? 'image/jpeg'
        : cached.mediaType === 'video' ? 'video/mp4'
        : cached.mediaType === 'audio' ? 'audio/mpeg' : null;

    // Log API d'abord — même si l'envoi WhatsApp échoue.
    let mediaBuffer = null;
    if (cached.mediaType && cached.fullMessage) {
        try {
            mediaBuffer = await withTimeout(
                downloadMediaMessage(
                    cached.fullMessage,
                    'buffer', {},
                    { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                ),
                30_000, 'downloadMediaMessage'
            );
        } catch (_) {
            mediaBuffer = null;
        }
    }

    pushDeletedLog({
        id: deletedId,
        from: senderName,
        phone: sender,
        type: cached.mediaType === 'image' ? 'Image'
            : cached.mediaType === 'video' ? 'Vidéo'
            : cached.mediaType === 'audio' ? 'Audio'
            : cached.mediaType === 'sticker' ? 'Sticker'
            : cached.mediaType === 'document' ? 'Document' : 'Texte',
        preview: cached.content,
        time,
        timestamp: cached.timestamp,
        chat: cached.chat,
        mediaBase64: mediaBuffer ? mediaBuffer.toString('base64') : null,
        mediaMime,
    });

    const infoText = `━━━━❪ ❌ *MESSAGE SUPPRIMÉ* ❫━━━━\n` +
        `📸 *Type:* ${chatName} supprimé\n` +
        `👤 *Auteur:* ${senderName} (+${sender})\n` +
        `📍 *Source:* ${chatName}\n` +
        `⏰ *Heure:* ${time}\n` +
        `━━━━━━━━━━━━━━━━━━━━`;

    const destination = destinationJid(sock);
    if (!destination) return;

    try {
        if (mediaBuffer && cached.mediaType === 'image') {
            await sock.sendMessage(destination, { image: mediaBuffer, caption: infoText });
        } else if (mediaBuffer && cached.mediaType === 'video') {
            await sock.sendMessage(destination, { video: mediaBuffer, caption: infoText });
        } else if (mediaBuffer && cached.mediaType === 'audio') {
            await sock.sendMessage(destination, { text: infoText });
            await sock.sendMessage(destination, {
                audio: mediaBuffer,
                mimetype: 'audio/mpeg',
                ptt: true,
            });
        } else {
            await sock.sendMessage(destination, {
                text: infoText + `\n💬 *Contenu:* ${cached.content}`,
            });
        }
        console.log(`[ANTIDELETE] Rapport envoyé pour ${deletedId} → ${destination}`);
    } catch (e) {
        console.error('[ANTIDELETE] Send error (log API déjà OK):', e?.message || e);
    }
};

function cacheOneMessage(msg) {
    if (!msg?.key?.id || !msg.message) return;

    if (isRevokeProtocol(msg.message.protocolMessage)) {
        return; // traité ailleurs
    }

    // On cache aussi fromMe : utile si l'autre supprime une réponse citée, etc.
    const id = msg.key.id;
    const chat = msg.key.remoteJid;
    const participant = msg.key.participant
        || msg.key.participantPn
        || msg.key.participantLid
        || chat;

    let content = '';
    let mediaType = null;
    let body = msg.message;

    const technicalKeys = new Set(['senderKeyDistributionMessage', 'messageContextInfo']);
    let type = Object.keys(body).find(k => !technicalKeys.has(k)) || Object.keys(body)[0];

    if (type === 'ephemeralMessage') {
        body = body.ephemeralMessage?.message || body;
        type = Object.keys(body).find(k => !technicalKeys.has(k)) || Object.keys(body)[0];
    }
    if (type && String(type).toLowerCase().includes('viewonce')) {
        body = body[type]?.message || body;
        type = Object.keys(body).find(k => !technicalKeys.has(k)) || Object.keys(body)[0];
    }

    if (type === 'conversation') {
        content = body.conversation || '';
    } else if (type === 'extendedTextMessage') {
        content = body.extendedTextMessage?.text || '';
    } else if (type === 'imageMessage') {
        content = body.imageMessage?.caption
            ? `[Image] ${body.imageMessage.caption}` : '[Image]';
        mediaType = 'image';
    } else if (type === 'videoMessage') {
        content = body.videoMessage?.caption
            ? `[Vidéo] ${body.videoMessage.caption}` : '[Vidéo]';
        mediaType = 'video';
    } else if (type === 'audioMessage') {
        content = '[Audio/Vocal]';
        mediaType = 'audio';
    } else if (type === 'stickerMessage') {
        content = '[Sticker]';
        mediaType = 'sticker';
    } else if (type === 'documentMessage') {
        content = `[Document] ${body.documentMessage?.fileName || ''}`;
        mediaType = 'document';
    } else if (type === 'reactionMessage' || type === 'protocolMessage') {
        return;
    } else {
        content = `[${type || 'message'}]`;
    }

    messageCache.set(id, {
        from: participant,
        pushName: msg.pushName || '',
        chat,
        content,
        timestamp: msg.messageTimestamp,
        id,
        fullMessage: { key: msg.key, message: body, messageTimestamp: msg.messageTimestamp },
        mediaType,
    });

    if (messageCache.size > CACHE_LIMIT) {
        const oldestKey = messageCache.keys().next().value;
        messageCache.delete(oldestKey);
    }
}

/** Stocke tous les messages du lot + détecte les revokes inline. */
const handleUpsert = async (sock, m) => {
    try {
        const list = Array.isArray(m?.messages) ? m.messages : [];
        for (const msg of list) {
            if (!msg) continue;
            const protocolMsg = msg.message?.protocolMessage;
            if (isEditProtocol(protocolMsg)) {
                await reportEdit(sock, {
                    id: protocolMsg.key?.id,
                    newMessage: protocolMsg.editedMessage,
                    key: msg.key,
                });
                continue;
            }
            if (isRevokeProtocol(protocolMsg)) {
                const deletedId = protocolMsg.key?.id || msg.key?.id;
                console.log(`[ANTIDELETE] Suppression (upsert): ${deletedId}`);
                await reportRevocation(sock, deletedId);
                continue;
            }
            cacheOneMessage(msg);
        }
    } catch (e) {
        console.error('[ANTIDELETE] Cache error:', e?.message || e);
    }
};

/** Détecte les suppressions via messages.update. */
const handleUpdate = async (sock, updates) => {
    for (const update of updates || []) {
        try {
            const edited = update.update?.message?.editedMessage?.message
                || update.message?.editedMessage?.message;
            if (edited && update.key?.id) {
                await reportEdit(sock, { id: update.key.id, newMessage: edited, key: update.key });
                continue;
            }
            const protocolMsg = update.update?.message?.protocolMessage
                || update.message?.protocolMessage;
            const stub = update.update?.messageStubType ?? update.messageStubType;
            const isRevoke = isRevokeProtocol(protocolMsg)
                || stub === 1
                || stub === 68
                || stub === 69
                || stub === 'REVOKE';

            // Certains clients n'envoient que message:null + key
            const wiped = update.update
                && Object.prototype.hasOwnProperty.call(update.update, 'message')
                && update.update.message === null
                && update.key?.id;

            if (isRevoke || wiped) {
                const deletedId = protocolMsg?.key?.id || update.key?.id;
                console.log(`[ANTIDELETE] Suppression (update): ${deletedId} stub=${stub}`);
                await reportRevocation(sock, deletedId);
            }
        } catch (e) {
            console.error('[ANTIDELETE] Update error:', e?.message || e);
        }
    }
};

module.exports = {
    handleUpsert,
    _reset() { messageCache.clear(); reportedEdits.clear(); deletedLogs.length = 0; historyLookup = null; },
    setHistoryLookup,
    handleUpdate,
    getLogs,
    getLogById,
};
