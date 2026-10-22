const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const config = require('./config.js');
const botState = require('./botState.js');
const { wipeAuthTable } = require('./supabaseAuth.js');
const antiDelete = require('./antidelete.js');
const filtersStore = require('./filtersStore.js');
const chatHistoryStore = require('./chatHistoryStore.js');
const statusSettingsStore = require('./statusSettingsStore.js');
const viewOnce = require('./viewonce.js');
const botGroup = require('./botGroup.js');
const airplane = require('./airplane.js');
const ghost = require('./ghost.js');
const scheduler = require('./scheduler.js');
const tagAll = require('./tagall.js');
const tiktok = require('./tiktok.js');
const youtube = require('./youtube.js');
const facebook = require('./facebook.js');
const screenshot = require('./screenshot.js');
const host = require('./host.js');
const contacts = require('./contacts.js');
const liveEvents = require('./liveEvents.js');
const ytNative = require('./ytNative.js');
const { withTimeout } = require('./withTimeout.js');

// Client Supabase pour l'export/import de session (même table que l'auth).
const supabaseAdmin = createClient(config.supabaseUrl, config.supabaseKey);
const CONTROL_ROWS = new Set(['filters', 'session_lock', 'chat_history']);

// Message history storage for chat heads
const messageHistory = new Map(); // chatId -> Array of messages
const MAX_HISTORY_PER_CHAT = 300;
// Antenne mémoire : on ne garde en mémoire que les conversations les plus
// récentes (Map inséré dans l'ordre → éviction FIFO des plus anciennes).
const MAX_CHATS = 500;

const evictOldestChat = () => {
    const oldest = messageHistory.keys().next().value;
    if (oldest !== undefined) messageHistory.delete(oldest);
};

// WebSocket clients
const wsClients = new Set();

// Message history functions
let historySeq = 0;
function addMessageToHistory(chatId, message) {
    if (!messageHistory.has(chatId)) {
        if (messageHistory.size >= MAX_CHATS) evictOldestChat();
        messageHistory.set(chatId, []);
    }
    const history = messageHistory.get(chatId);
    if (!message.id) {
        historySeq++;
        message.id = `m${Date.now()}-${historySeq}`;
    }
    // Déduplication par id : l'écho WhatsApp du message envoyé (vrai id) ne
    // doit pas recréer une seconde bulle à côté de l'optimiste.
    if (history.some(x => x.id === message.id)) return;
    history.push(message);
    if (history.length > MAX_HISTORY_PER_CHAT) {
        history.shift();
    }
    scheduleHistorySave();
}

// ── Persistance durable de l'historique (survit aux redémarrages Render) ─────
let historySaveTimer = null;

/** Debounce la sauvegarde (max 1 écriture/3 s, même rafale de messages). */
function scheduleHistorySave() {
    if (historySaveTimer) clearTimeout(historySaveTimer);
    historySaveTimer = setTimeout(() => {
        historySaveTimer = null;
        flushChatHistory().catch(() => { });
    }, 3000);
}

/** Sérialise toute l'historique en mémoire et l'écrit dans la table Supabase.
 *  Les flushes concurrents sont chaînés (une seule écriture à la fois) pour
 *  ne jamais perdre de messages récents lors d'une rafale. */
let flushChain = Promise.resolve();
function flushChatHistory() {
    if (historySaveTimer) { clearTimeout(historySaveTimer); historySaveTimer = null; }
    if (messageHistory.size === 0) return flushChain;
    const chats = {};
    for (const [chatId, msgs] of messageHistory.entries()) {
        if (!msgs || !msgs.length) continue;
        // Ne pas persister les gros binaires média (base64) — trop lourd pour
        // Supabase et provoquait des échecs silencieux de sauvegarde.
        chats[chatId] = msgs.map((m) => {
            if (!m || !m.mediaData) return m;
            const { mediaData, ...rest } = m;
            return { ...rest, mediaStatus: rest.mediaStatus === 'ready' ? 'evicted' : rest.mediaStatus };
        });
    }
    const snapshot = chats;
    flushChain = flushChain.then(async () => {
        try {
            await chatHistoryStore.saveChatHistory(snapshot);
        } catch (e) {
            console.warn('[History] flush échoué:', e.message);
        }
    });
    return flushChain;
}

/** Restaure l'historique au boot (avant connexion WhatsApp). */
function hydrateChatHistory(chats) {
    if (!chats || typeof chats !== 'object') return;
    for (const [chatId, msgs] of Object.entries(chats)) {
        if (!Array.isArray(msgs) || !msgs.length) continue;
        // Ne pas écraser des messages déjà capturés dans ce processus.
        const existing = messageHistory.get(chatId);
        if (existing && existing.length) continue;
        messageHistory.set(chatId, msgs.slice(-MAX_HISTORY_PER_CHAT));
    }
    while (messageHistory.size > MAX_CHATS) evictOldestChat();
}

/** Cherche un message par id : d'abord dans [chatId], puis partout. */
function findHistoryMessage(chatId, id) {
    const look = (cid) => {
        const m = (messageHistory.get(cid) || []).find((x) => x.id === id);
        return m ? { chatId: cid, text: m.text || '', name: m.name || '' } : null;
    };
    if (chatId) {
        const hit = look(chatId);
        if (hit) return hit;
    }
    for (const cid of messageHistory.keys()) {
        if (cid === chatId) continue;
        const hit = look(cid);
        if (hit) return hit;
    }
    return null;
}

function getChatIds() {
    return [...messageHistory.keys()];
}

function getChatHistory(chatId) {
    return messageHistory.get(chatId) || [];
}

function removeChat(chatId) {
    messageHistory.delete(chatId);
}

/** Applique un patch sur un message de l'historique (ex: média téléchargé). */
function updateHistoryMessage(chatId, msgId, patch) {
    const history = messageHistory.get(chatId);
    if (!history) return false;
    const m = history.find(x => x.id === msgId);
    if (!m) return false;
    Object.assign(m, patch);
    scheduleHistorySave();
    return true;
}

function getAllChats() {
    const chats = [];
    for (const [chatId, messages] of messageHistory.entries()) {
        if (messages.length > 0) {
            const lastMessage = messages[messages.length - 1];
            chats.push({
                id: chatId,
                name: lastMessage.name || 'Unknown',
                lastMessage: lastMessage.text || '',
                avatar: lastMessage.avatar || null,
                unread: messages.filter(m => !m.fromMe).length,
            });
        }
    }
    return chats;
}

// Broadcast message to all WebSocket clients (Discussions temps réel)
function broadcastMessage(message) {
    const data = JSON.stringify({
        type: 'chat',
        ...message,
        t: message.t || (message.timestamp
            ? new Date(message.timestamp).getTime()
            : Date.now()),
    });
    wsClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(data); } catch (_) {}
        }
    });
}

/** Formate l'uptime en chaîne lisible (ex: 3h42m15s) */
function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h${m.toString().padStart(2, '0')}`;
    if (m > 0) return `${m}m${s.toString().padStart(2, '0')}s`;
    return `${s}s`;
}

/** Retourne le numéro de téléphone connecté */
function getPhoneNumber() {
    if (!botState.activeSocket?.user?.id) return '';
    return botState.activeSocket.user.id.split(':')[0];
}

/** Baileys 6 expose isOpen sur son WebSocketClient, pas seulement readyState. */
function isSocketOpen() {
    const ws = botState.activeSocket?.ws;
    return ws?.isOpen === true || ws?.readyState === 1;
}

/** Pénalité 428 en cours (index.js) : ms restantes avant de retenter un socket. */
function waCooldownLeft() {
    return Math.max(0, (botState.waCooldownUntil || 0) - Date.now());
}

/** Réponse 503 uniformisée quand WhatsApp nous tient en pause. */
function cooldownResponse(res) {
    const left = waCooldownLeft();
    return res.status(503).json({
        error: `WhatsApp a fermé la connexion et impose une pause de sécurité. Réessayez dans ${Math.ceil(left / 60000)} min.`,
        cooldown: true,
        retryInSeconds: Math.ceil(left / 1000),
        cooldownUntil: new Date(botState.waCooldownUntil).toISOString(),
    });
}

/** Traduit les erreurs Baileys de requestPairingCode en message utilisable */
function pairErrorMessage(raw) {
    const msg = String(raw || '');
    if (/already logged in|already logged|existing session/i.test(msg)) {
        return 'Ce compte est déjà associé. Enregistrez-le d\'abord (Changer de numéro).';
    }
    if (/invalid.*phone|phone number.*invalid|not a registered/i.test(msg)) {
        return 'Numéro invalide ou non enregistré sur WhatsApp.';
    }
    if (/timeout|timed out|slow/i.test(msg)) {
        return 'Le serveur tardait à répondre, réessayez dans 30 s.';
    }
    if (/pairing/i.test(msg)) {
        return `Association impossible pour l'instant (${msg}). Réessayez dans 30 s.`;
    }
    if (/closed|end|offline/i.test(msg)) {
        return 'La session WhatsApp est fermée : réessayez dans 30 s.';
    }
    return msg.slice(0, 200);
}

// ── Session WhatsApp périmée : repartir sur une session vierge ──────────────
const sb = createClient(config.supabaseUrl, config.supabaseKey);

/** true si une session (creds.me) est encore stockée en base. */
async function hasStoredSession() {
    try {
        const { data, error } = await sb.from('whatsapp_auth').select('data').eq('id', 'creds').maybeSingle();
        // Erreur de lecture (Supabase injoignable…) : on ne peut pas confirmer
        // que la session est vierge → par prudence on passe par la remise à neuf.
        if (error) return true;
        return !!(data?.data && data.data.me);
    } catch (e) {
        return true; // en cas de doute on passe par la remise à neuf
    }
}

/** Efface entièrement la table d'auth (creds + clés). */
async function wipeStoredSession() {
    try { await wipeAuthTable(sb, 'whatsapp_auth'); }
    catch (e) { console.warn('[WIPE]', e?.message); }
}

/** Attente du deferred rempli par index.js (code généré sur le socket frais). */
function waitForPairingCode(ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            botState.pairingDeferred = null;
            reject(new Error('L\'association a pris trop de temps, réessayez.'));
        }, ms);
        botState.pairingDeferred = {
            resolve: (v) => { clearTimeout(timer); resolve(v); },
            reject: (e) => { clearTimeout(timer); reject(new Error(pairErrorMessage(String(e?.message || e)))); },
        };
    });
}

/**
 * Associe un numéro en repartant d'une session VIERGE : efface la session
 * périmée stockée, recrée le socket, puis génère le code pour `phone`.
 * C'est le chemin utilisé quand le bot a une session morte en cache
 * (whatsappConnected=false + creds.me présent) — sinon requestPairingCode
 * échoue avec "session fermée / logged out".
 */
async function pairWithCleanSession(phone) {
    botState.pendingPairPhone = phone;
    botState.autoPair = false;      // pas de code auto pour config.phoneNumber
    botState.forceReconnect = true;
    botState.lastPairError = null;
    await wipeStoredSession();
    // On enregistre le deferred AVANT de relancer la connexion : le code pourra
    // être résolu même si le redémarrage se déclenche de façon synchrone.
    const promise = waitForPairingCode(90_000);
    try { await botState.activeSocket?.end?.(new Error('pair-refresh')); } catch (_) {}
    if (typeof botState.__restartBotConnection === 'function') {
        try { botState.__restartBotConnection(); } catch (e) { console.warn('[PAIR] restart:', e?.message); }
    }
    return await promise;
}

/** Construit l'objet de configuration bot pour l'API */
function getBotConfig() {
    return {
        reactionEmojis: config.reactionEmojis || [],
        fixedEmoji: botState.fixedEmoji,
        likeMyOwnStatus: config.likeMyOwnStatus ?? true,
        statusDelayMin: botState.statusDelayMin / 1000,
        statusDelayMax: botState.statusDelayMax / 1000,
        statusDelayFixed: botState.statusDelayFixed / 1000,
        statusDelayMode: botState.statusDelayMode,
        scheduleEnabled: config.scheduleEnabled ?? false,
        scheduleStart: config.scheduleStart || '07:00',
        scheduleEnd: config.scheduleEnd || '23:00',
        authorReactions: config.authorReactions || [],
        statusMediaTypes: config.statusMediaTypes || [],
        whitelist: config.whitelist || [],
        blacklist: config.blacklist || [],
        autoReplyMessage: config.autoReplyMessage || '',
        antiDeleteEnabled: config.antiDeleteEnabled ?? true,
        viewOnceEnabled: config.viewOnceEnabled ?? true,
        prefix: config.prefix || '?',
    };
}

/** Normalise une heure "HH:MM" (24 h). Retourne null si le format est invalide. */
function normalizeScheduleTime(value) {
    const m = String(value).trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!m) return null;
    return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/** Met à jour config.js sur disque pour les champs persistants */
function persistConfigFields(fields) {
    const configPath = path.join(__dirname, 'config.js');
    let configStr = fs.readFileSync(configPath, 'utf8');

    if (fields.prefix !== undefined) {
        configStr = configStr.replace(/prefix:\s*['"][^'"]*['"]/, `prefix: "${fields.prefix}"`);
    }
    if (fields.autoReplyMessage !== undefined) {
        const escaped = fields.autoReplyMessage.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        configStr = configStr.replace(/autoReplyMessage:\s*"[^"]*"/, `autoReplyMessage: "${escaped}"`);
    }
    if (fields.likeMyOwnStatus !== undefined) {
        configStr = configStr.replace(/likeMyOwnStatus:\s*(true|false)/, `likeMyOwnStatus: ${fields.likeMyOwnStatus}`);
    }
    if (fields.antiDeleteEnabled !== undefined) {
        configStr = configStr.replace(/antiDeleteEnabled:\s*(true|false)/, `antiDeleteEnabled: ${fields.antiDeleteEnabled}`);
    }
    if (fields.viewOnceEnabled !== undefined) {
        configStr = configStr.replace(/viewOnceEnabled:\s*(true|false)/, `viewOnceEnabled: ${fields.viewOnceEnabled}`);
    }
    if (fields.whitelist !== undefined) {
        configStr = configStr.replace(/whitelist:\s*\[[^\]]*\]/, `whitelist: ${JSON.stringify(fields.whitelist)}`);
    }
    if (fields.blacklist !== undefined) {
        configStr = configStr.replace(/blacklist:\s*\[[^\]]*\]/, `blacklist: ${JSON.stringify(fields.blacklist)}`);
    }
    if (fields.reactionEmojis !== undefined) {
        configStr = configStr.replace(/reactionEmojis:\s*\[[^\]]*\]/, `reactionEmojis: ${JSON.stringify(fields.reactionEmojis)}`);
    }
    if (fields.scheduleEnabled !== undefined) {
        configStr = configStr.replace(/scheduleEnabled:\s*(true|false)/, `scheduleEnabled: ${fields.scheduleEnabled}`);
    }
    if (fields.scheduleStart !== undefined) {
        configStr = configStr.replace(/scheduleStart:\s*"[^"]*"/, `scheduleStart: "${fields.scheduleStart}"`);
    }
    if (fields.scheduleEnd !== undefined) {
        configStr = configStr.replace(/scheduleEnd:\s*"[^"]*"/, `scheduleEnd: "${fields.scheduleEnd}"`);
    }
    if (fields.authorReactions !== undefined) {
        configStr = configStr.replace(/authorReactions:\s*\[[^\]]*\]/, `authorReactions: ${JSON.stringify(fields.authorReactions)}`);
    }
    if (fields.statusMediaTypes !== undefined) {
        configStr = configStr.replace(/statusMediaTypes:\s*\[[^\]]*\]/, `statusMediaTypes: ${JSON.stringify(fields.statusMediaTypes)}`);
    }

    fs.writeFileSync(configPath, configStr);
}

/** Normalise un UID/JID pour whitelist ou blacklist */
function toListJid(input) {
    const raw = String(input).trim();
    if (!raw) return null;
    if (raw.includes('@')) return raw;
    const id = raw.replace(/\D/g, '');
    if (!id) return null;
    return `${id}@lid`;
}

// ── Auth / Messages (Discussions) ────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || config.jwtSecret || 'josi-jwt-dev-secret';
const JWT_TTL_S = 60 * 60;

function b64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signJwt(sub) {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ sub, iat: now, exp: now + JWT_TTL_S }));
    const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest().toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${header}.${payload}.${sig}`;
}

function verifyJwt(token) {
    try {
        const [h, p, s] = String(token || '').split('.');
        if (!h || !p || !s) return null;
        // Comparaison en temps constant (anti-timing-attack), buffers de même taille
        const expected = crypto
            .createHmac('sha256', JWT_SECRET)
            .update(`${h}.${p}`)
            .digest();
        const provided = Buffer.from(s, 'base64url');
        if (Buffer.byteLength(expected) !== Buffer.byteLength(provided)) return null;
        if (!crypto.timingSafeEqual(expected, provided)) return null;
        const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
        if (!claims.exp || Date.now() / 1000 > claims.exp) return null;
        return claims;
    } catch (e) {
        return null;
    }
}

function authRequired(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : header;
    const claims = verifyJwt(token);
    if (!claims) return res.status(401).json({ error: 'Non autorisé' });
    req.jwt = claims;
    next();
}

// Rafraîchissement : chaque réponse protégée renvoie un JWT frais (x-refresh-token)
function attachRefresh(req, res, next) {
    if (req.jwt) {
        res.setHeader('x-refresh-token', signJwt(req.jwt.sub));
    }
    next();
}

// Rate limit simple (429) sur la router messages
function rateLimit(limit, windowMs) {
    // Compteur propre à chaque limiteur : lectures et envois ne se mélangent pas.
    const rateBuckets = new Map();
    return (req, res, next) => {
        const ip = req.ip || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        const alive = (rateBuckets.get(ip) || []).filter(t => now - t < windowMs);
        if (alive.length >= limit) {
            res.setHeader('Retry-After', '1');
            return res.status(429).json({ error: 'Trop de requêtes', retryAfter: 1 });
        }
        alive.push(now);
        rateBuckets.set(ip, alive);
        next();
    };
}

function formatJid(jid) {
    const num = String(jid).split('@')[0].split(':')[0];
    if (!num) return String(jid);
    return num.startsWith('+') ? num : `+${num}`;
}

// Ordre de résolution : répertoire (LID↔PN) → pushName → numéro
function resolveDisplayName(chatId, fallback) {
    const fromDir = contacts.getDisplayName(chatId);
    if (fromDir) return fromDir;
    if (contacts.isRealName(fallback) && fallback !== 'Me' && fallback !== 'Unknown') {
        return fallback;
    }
    return formatJid(chatId);
}

function toMessageDto(m, chatId) {
    const t = m.timestamp ? new Date(m.timestamp).getTime() : 0;
    const hasMedia = !!m.mediaType;
    const mediaReady = hasMedia && (m.mediaStatus === 'ready' ||
        (m.mediaStatus == null && !!m.mediaData));
    const displayName = m.fromMe
        ? (m.name || 'Me')
        : resolveDisplayName(chatId, m.name);
    return {
        id: m.id || `${chatId}:${t}:${m.fromMe ? 'o' : 'i'}`,
        chatId,
        fromMe: !!m.fromMe,
        text: m.text || '',
        t,
        name: displayName,
        pushName: displayName,
        mediaType: m.mediaType || null,
        mediaStatus: m.mediaStatus || null,
        mediaMime: m.mediaMime || null,
        mediaName: m.mediaName || null,
        mediaUrl: mediaReady
            ? `/api/messages/media/${encodeURIComponent(chatId)}/${encodeURIComponent(m.id || '')}`
            : null,
        quotedId: m.quotedId || null,
        quotedText: m.quotedText || null,
    };
}

function dedupeMessages(items) {
    const seen = new Set();
    const out = [];
    for (const m of items || []) {
        if (!m.id) continue;
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        out.push(m);
    }
    return out;
}

function isNoiseChat(chatId) {
    return !chatId
        || chatId === 'status@broadcast'
        || chatId.endsWith('@newsletter')
        || chatId.endsWith('@broadcast')
        || contacts.isBogusPnChat(chatId);
}

function conversationsList() {
    const convs = [];
    const ownJid = (() => {
        const u = botState.activeSocket?.user?.id;
        if (!u) return null;
        const num = u.split(':')[0].split('@')[0].replace(/\D/g, '');
        return num ? `${num}@s.whatsapp.net` : null;
    })();

    // Fusionne les fils LID + PN d'un même contact (sinon 2 Batman, messages « perdus »).
    const buckets = new Map(); // canonicalId -> { chatId, msgs[] }
    for (const [chatId, msgs] of messageHistory.entries()) {
        if (!msgs || !msgs.length) continue;
        if (isNoiseChat(chatId)) continue;
        if (ownJid && chatId === ownJid) continue;
        const pn = contacts.resolvePn(chatId);
        const canonical = (pn && !chatId.endsWith('@g.us')) ? pn : chatId;
        const bucket = buckets.get(canonical) || { chatId: canonical, msgs: [] };
        // Préférer un chatId @lid s'il a plus de messages nommés, sinon PN.
        if (chatId.endsWith('@lid') && !bucket.chatId.endsWith('@lid')) {
            bucket.chatId = chatId;
        }
        bucket.msgs.push(...msgs);
        buckets.set(canonical, bucket);
    }

    for (const { chatId, msgs } of buckets.values()) {
        const unique = dedupeMessages(msgs);
        if (!unique.length) continue;
        const last = unique[unique.length - 1];
        const lastIncoming = [...unique].reverse().find(
            (m) => !m.fromMe && contacts.isRealName(m.name) && m.name !== 'Unknown'
        );
        const peerName = lastIncoming?.name || null;
        const isGroup = chatId.endsWith('@g.us');
        const name = isGroup
            ? resolveDisplayName(chatId, peerName)
            : (peerName && contacts.isRealName(peerName)
                ? peerName
                : resolveDisplayName(chatId, peerName));
        convs.push({
            chatId,
            name,
            lastMessage: last.text || (last.mediaType ? `[${last.mediaType}]` : ''),
            lastAt: last.timestamp ? new Date(last.timestamp).getTime() : 0,
            count: unique.length,
            fromMe: !!last.fromMe,
        });
    }
    convs.sort((a, b) => b.lastAt - a.lastAt);
    return convs;
}

/**
 * Monte toutes les routes API sur l'application Express existante
 * @param {import('express').Express} app
 */
function setupApi(app) {
    console.log('[API] Initialisation des routes REST...');
    // Derrière un reverse proxy (Render) : req.ip suit l'entête X-Forwarded-For
    app.set('trust proxy', 1);
    app.use(cors({
        origin: true,
        credentials: false,
        exposedHeaders: ['x-refresh-token'],
    }));
    app.use(helmet({ contentSecurityPolicy: false }));
    app.use(express.json({ limit: '24mb' }));

    // Routes publiques (santé Render)
    app.get('/', (req, res) => res.status(200).send('🤖 JosiHack Bot - OK'));
    app.get('/health', (req, res) => {
        res.status(200).json({
            status: 'ok',
            botConnected: !!botState.activeSocket,
            uptime: process.uptime(),
        });
    });

    const api = express.Router();

    // Toutes les routes /api/* sont authentifiées par JWT, SAUF les endpoints
    // publiés en lecture seule (santé, feed statuts, contacts, logs live).
    // L'app Flutter envoie désormais le Bearer sur chaque requête (intercepteur).
    api.use((req, res, next) => {
        const PUBLIC_API = [
            '/auth/login', '/status', '/status/authors', '/status/feed',
            '/status/history', '/whatsapp/connection', '/contacts', '/directory',
            '/groups', '/live/feed', '/live/stream',
        ];
        // Téléchargement natif yt-dlp : JWT OU clé machine→machine vérifiés
        // dans le handler ; le fichier servi est un id aléatoire court-vécu.
        if (
            PUBLIC_API.includes(req.path) ||
            req.path === '/video/native' ||
            req.path.startsWith('/video/file/')
        ) return next();
        return authRequired(req, res, next);
    });

    // POST /api/auth/login — échange la clé d'app contre un JWT (sec. 9.2)
    api.post('/auth/login', (req, res) => {
        const { token } = req.body || {};
        const provided = Buffer.from(String(token || ''), 'utf8');
        const expected = Buffer.from(String(config.apiKey || ''), 'utf8');
        const valid = provided.length === expected.length &&
            crypto.timingSafeEqual(provided, expected);
        if (!valid) {
            return res.status(401).json({ error: 'Clé invalide' });
        }
        res.json({ token: signJwt('app'), expiresIn: JWT_TTL_S });
    });

    // GET /api/status
    api.get('/status', async (req, res) => {
        const voLogs = await viewOnce.getLogs().catch(() => []);
        res.json({
            connected: botState.whatsappConnected,
            botActive: botState.isActivelyLiking,
            whatsappConnected: botState.whatsappConnected,
            uptime: formatUptime(process.uptime()),
            stats: {
                statusesLiked: botState.stats.statusesLiked,
                statusesViewed: botState.stats.statusesViewed,
                messagesProcessed: botState.stats.messagesProcessed,
                viewOnceCaptured: voLogs.length,
            },
            viewOnly: botState.isViewOnly,
            phoneNumber: getPhoneNumber(),
            reactKeyMode: config.reactKeyMode,
            lastReaction: botState.lastReaction,
        });
    });

    // POST /api/bot/toggle
    api.post('/bot/toggle', (req, res) => {
        const { active } = req.body;
        if (typeof active !== 'boolean') {
            return res.status(400).json({ error: 'Le champ active (bool) est requis' });
        }
        botState.isActivelyLiking = active;
        if (active) botState.isViewOnly = false;
        statusSettingsStore.save({
            isActivelyLiking: botState.isActivelyLiking,
            isViewOnly: botState.isViewOnly,
        });
        res.json({
            success: true,
            botActive: botState.isActivelyLiking,
            viewOnly: botState.isViewOnly,
        });
    });

    // POST /api/bot/emoji
    api.post('/bot/emoji', (req, res) => {
        const { emoji } = req.body;
        if (emoji === null || emoji === 'random' || emoji === undefined) {
            botState.fixedEmoji = null;
        } else {
            botState.fixedEmoji = emoji;
            botState.isActivelyLiking = true;
            botState.isViewOnly = false;
        }
        statusSettingsStore.save({
            fixedEmoji: botState.fixedEmoji,
            isActivelyLiking: botState.isActivelyLiking,
            isViewOnly: botState.isViewOnly,
        });
        res.json({ success: true, fixedEmoji: botState.fixedEmoji });
    });

    // GET /api/bot/config
    api.get('/bot/config', (req, res) => {
        res.json(getBotConfig());
    });

    // PUT /api/bot/config
    api.put('/bot/config', (req, res) => {
        const body = req.body || {};
        const persist = {};

        if (body.reactionEmojis !== undefined) {
            config.reactionEmojis = body.reactionEmojis;
            persist.reactionEmojis = body.reactionEmojis;
        }
        if (body.fixedEmoji !== undefined) {
            botState.fixedEmoji = body.fixedEmoji === 'random' ? null : body.fixedEmoji;
        }
        if (body.likeMyOwnStatus !== undefined) {
            config.likeMyOwnStatus = body.likeMyOwnStatus;
            persist.likeMyOwnStatus = body.likeMyOwnStatus;
        }
        if (body.statusDelayMin !== undefined) {
            botState.statusDelayMin = Math.round(body.statusDelayMin * 1000);
        }
        if (body.statusDelayMax !== undefined) {
            botState.statusDelayMax = Math.round(body.statusDelayMax * 1000);
        }
        if (body.statusDelayFixed !== undefined) {
            botState.statusDelayFixed = Math.round(body.statusDelayFixed * 1000);
        }
        if (body.statusDelayMode !== undefined) {
            botState.statusDelayMode = body.statusDelayMode;
        }
        // Les délais sont dans botState, donc en mémoire : sans cette sauvegarde
        // ils retrouvaient leurs valeurs par défaut au prochain déploiement.
        if (body.statusDelayMin !== undefined || body.statusDelayMax !== undefined ||
            body.statusDelayFixed !== undefined || body.statusDelayMode !== undefined) {
            statusSettingsStore.save({
                statusDelayMode: botState.statusDelayMode,
                statusDelayMin: botState.statusDelayMin,
                statusDelayMax: botState.statusDelayMax,
                statusDelayFixed: botState.statusDelayFixed,
            });
        }
        if (body.scheduleEnabled !== undefined) {
            config.scheduleEnabled = !!body.scheduleEnabled;
            persist.scheduleEnabled = config.scheduleEnabled;
        }
        if (body.scheduleStart !== undefined) {
            config.scheduleStart = normalizeScheduleTime(body.scheduleStart) || config.scheduleStart;
            persist.scheduleStart = config.scheduleStart;
        }
        if (body.scheduleEnd !== undefined) {
            config.scheduleEnd = normalizeScheduleTime(body.scheduleEnd) || config.scheduleEnd;
            persist.scheduleEnd = config.scheduleEnd;
        }
        if (body.authorReactions !== undefined) {
            config.authorReactions = Array.isArray(body.authorReactions)
                ? body.authorReactions.filter(r => r && (r.emoji))
                : [];
            persist.authorReactions = config.authorReactions;
        }
        if (body.statusMediaTypes !== undefined) {
            config.statusMediaTypes = Array.isArray(body.statusMediaTypes)
                ? body.statusMediaTypes.filter(t => ['image', 'video', 'audio', 'texte', 'document'].includes(t))
                : [];
            persist.statusMediaTypes = config.statusMediaTypes;
        }
        if (body.whitelist !== undefined) {
            config.whitelist = body.whitelist;
            persist.whitelist = body.whitelist;
        }
        if (body.blacklist !== undefined) {
            config.blacklist = body.blacklist;
            persist.blacklist = body.blacklist;
        }
        if (body.autoReplyMessage !== undefined) {
            config.autoReplyMessage = body.autoReplyMessage;
            persist.autoReplyMessage = body.autoReplyMessage;
        }
        if (body.antiDeleteEnabled !== undefined) {
            config.antiDeleteEnabled = body.antiDeleteEnabled;
            persist.antiDeleteEnabled = body.antiDeleteEnabled;
        }
        if (body.viewOnceEnabled !== undefined) {
            config.viewOnceEnabled = body.viewOnceEnabled;
            persist.viewOnceEnabled = body.viewOnceEnabled;
        }
        if (body.prefix !== undefined) {
            config.prefix = body.prefix;
            persist.prefix = body.prefix;
        }

        if (Object.keys(persist).length > 0) {
            try { persistConfigFields(persist); } catch (e) {
                console.error('[API] Erreur persistance config:', e.message);
            }
        }
        // Les listes blanche/noire sont durables (survivent aux restarts).
        try {
            filtersStore.saveFilters(config.whitelist, config.blacklist);
        } catch (_) {}

        res.json(getBotConfig());
    });

    // POST /api/whatsapp/pair
    // Génère (ou renvoie tel quel) le code d'association à saisir dans
    // WhatsApp → Réglages → Appareils connectés → Connecter un appareil.
    api.post('/whatsapp/pair', async (req, res) => {
        const rawPhone = String(req.body.phoneNumber || '').trim();
        if (!rawPhone) {
            return res.status(400).json({ error: 'Numéro requis (ex: 22912345678)' });
        }
        // Pénalité 428 en cours : inutile d'ouvrir un socket, WhatsApp le
        // refermerait aussitôt et l'utilisateur recevrait « session fermée ».
        // On répond 503 avec l'heure de reprise au lieu de faire échouer.
        if (waCooldownLeft() > 0) {
            return cooldownResponse(res);
        }
        if (!botState.activeSocket) {
            return res.status(503).json({ error: 'Bot non démarré, réessayez dans une minute' });
        }
        if (botState.whatsappConnected) {
            return res.status(400).json({
                error: `Déjà connecté au numéro +${getPhoneNumber()}. Utilisez l'option "Changer de numéro" pour associer un autre compte.`,
            });
        }

        const phone = rawPhone.replace(/\D/g, '');
        const pendingValid = botState.pairingCode &&
            (Date.now() - (botState.pairingRequestedAt || 0)) < botState.pairingExpiresIn * 1000;

        // Code déjà en attente et encore valide pour le même numéro → on le renvoie
        // tel quel (WhatsApp n'autorise qu'un seul code par session).
        if (pendingValid && botState.pairingPhone === phone) {
            return res.json({ success: true, code: botState.pairingCode, expiresIn: botState.pairingExpiresIn, reused: true });
        }
        if (pendingValid && botState.pairingPhone !== phone) {
            const left = Math.round((botState.pairingExpiresIn * 1000 - (Date.now() - botState.pairingRequestedAt)) / 1000);
            return res.status(409).json({
                error: `Un code est déjà en attente pour +${botState.pairingPhone} (encore ${left}s). Attendez son expiration ou changez de numéro.`,
            });
        }

        try {
            // Session morte en cache (ex: bot non connecté pendant des heures,
            // double-socket ayant invalidé le pairage) : requestPairingCode
            // échouerait avec "session fermée". On repart sur une session
            // vierge et on attend que le code soit généré.
            // Après un reset, activeSocket peut encore pointer vers l'ancien
            // socket fermé. Il faut alors repartir sur un socket vierge et
            // attendre son ouverture avant d'appeler requestPairingCode.
            if (!isSocketOpen() || (!botState.whatsappConnected && await hasStoredSession())) {
                const fresh = await pairWithCleanSession(phone);
                return res.json({ success: true, ...fresh, reset: true });
            }
            const code = await botState.activeSocket.requestPairingCode(phone);
            botState.pairingCode = code;
            botState.pairingPhone = phone;
            botState.pairingRequestedAt = Date.now();
            botState.lastPairError = null;
            res.json({ success: true, code, expiresIn: botState.pairingExpiresIn });
        } catch (err) {
            botState.lastPairError = String(err?.message || err);
            console.error('[PAIR] Échec génération du code:', botState.lastPairError);
            // La tentative a déclenché un 428 : la pause vient de démarrer, le
            // message « réessayez dans 30 s » serait un mensonge.
            if (waCooldownLeft() > 0) return cooldownResponse(res);
            res.status(500).json({ error: pairErrorMessage(botState.lastPairError) });
        }
    });

    // POST /api/whatsapp/reset
    // Déconnecte proprement la session pour associer un autre numéro.
    // Efface aussi la session stockée (Supabase) pour que le redémarrage
    // aboutisse sur une session vierge, faute de quoi le bot boucle sur les
    // creds périmés (440/401 → "session fermée").
    api.post('/whatsapp/reset', async (req, res) => {
        const sock = botState.activeSocket;
        botState.autoPair = false;
        botState.forceReconnect = true;
        botState.pairingCode = null;
        botState.pairingPhone = null;
        botState.pairingRequestedAt = 0;
        botState.whatsappConnected = false;
        botState.lastPairError = null;
        // Un reset manuel est une action VOLONTAIRE de l'utilisateur vers une
        // session vierge : il doit lever la pause 428, sinon le pairing
        // following serait refusé 503 pendant 10 min pour rien.
        botState.waCooldownUntil = 0;
        botState.waCooldownReason = null;
        await wipeStoredSession();
        try {
            if (sock?.logout) await sock.logout();
            else await sock?.end?.(new Error('reset'));
        } catch (e) {
            console.warn('[RESET] logout() a échoué, relance en force:', e?.message);
        }
        if (typeof botState.__restartBotConnection === 'function') {
            botState.__restartBotConnection();
        }
        res.json({ success: true, message: 'Session réinitialisée. Un nouveau code pourra être généré.' });
    });

    // GET /api/whatsapp/connection
    api.get('/whatsapp/connection', (req, res) => {
        const pendingValid = botState.pairingCode &&
            (Date.now() - (botState.pairingRequestedAt || 0)) < (botState.pairingExpiresIn * 1000);
        const cooldownLeft = waCooldownLeft();
        res.json({
            connected: botState.whatsappConnected,
            phoneNumber: getPhoneNumber(),
            canPair: botState.activeSocket != null && !botState.whatsappConnected && !pendingValid && cooldownLeft === 0,
            pairPhone: botState.pairingPhone,
            // Pause 428 : l'app affiche un compte à rebours au lieu de
            // laisser croire qu'un code va arriver.
            cooldown: cooldownLeft > 0,
            cooldownInSeconds: Math.ceil(cooldownLeft / 1000),
            pairExpiresIn: pendingValid
                ? Math.max(0, Math.round((botState.pairingExpiresIn * 1000 - (Date.now() - botState.pairingRequestedAt)) / 1000))
                : 0,
        });
    });

    // GET /api/status/authors
    // Auteurs des derniers statuts reçus → sélecteur liste blanche/noire.
    api.get('/status/authors', (req, res) => {
        const authors = [...botState.recentStatusAuthors.values()]
            .sort((a, b) => b.at - a.at)
            .map(a => ({ jid: a.jid, phone: a.phone || '' }));
        res.json({ success: true, authors });
    });

    // GET /api/status/feed
    // Flux des statuts reçus ("Aujourd'hui") : auteur, type, action prévue,
    // délai et état (reçu / bloqué / vu / aimé). Rendu par le module Statuts.
    api.get('/status/feed', (req, res) => {
        const limit = Math.min(parseInt(req.query.limit) || 60, 100);
        res.json({ feed: botState.statusFeed.slice(0, limit) });
    });

    // GET /api/status/:id/media — média du statut (téléchargé à la demande, 10 Mo max).
    // Authentifié : renvoie les octets bruts avec leur type MIME.
    api.get('/status/:id/media', async (req, res) => {
        try {
            const { buffer, mime } = await botState.statusActions.media(req.params.id);
            res.set('Content-Type', mime);
            res.set('Cache-Control', 'private, max-age=600');
            res.send(buffer);
        } catch (err) {
            const status = { 'not-found': 404, 'no-media': 404, 'too-large': 413 }[err.code] || 502;
            res.status(status).json({ error: err.message, code: err.code || 'error' });
        }
    });

    // POST /api/status/:id/react — réaction choisie dans l'app { emoji }.
    api.post('/status/:id/react', async (req, res) => {
        const emoji = String(req.body?.emoji || '').trim();
        if (!emoji || emoji.length > 16) return res.status(400).json({ error: 'emoji invalide' });
        try {
            await botState.statusActions.react(req.params.id, emoji);
            res.json({ success: true, emoji });
        } catch (err) {
            const status = { 'not-found': 404, offline: 503 }[err.code] || 502;
            res.status(status).json({ error: err.message, code: err.code || 'error' });
        }
    });

    // ── Mode avion ────────────────────────────────────────────────────────────
    // GET /api/airplane — { enabled }
    api.get('/airplane', (req, res) => res.json({ success: true, enabled: airplane.isEnabled() }));

    // PUT /api/airplane — { enabled } : présence indisponible + dernière connexion masquée.
    api.put('/airplane', async (req, res) => {
        try {
            const enabled = await airplane.set(
                botState.activeSocket,
                req.body?.enabled === true,
                () => botState.activeSocket,
            );
            res.json({ success: true, enabled });
        } catch (err) {
            const status = err.code === 'offline' ? 503 : 502;
            res.status(status).json({ error: err.message, code: err.code || 'error' });
        }
    });

    // ── Mode fantôme ──────────────────────────────────────────────────────────
    // GET /api/ghost — { enabled, patched }
    api.get('/ghost', (req, res) => res.json({
        success: true,
        enabled: ghost.isEnabled(),
        patched: ghost.isPatched(),
    }));

    // PUT /api/ghost — { enabled } : plus d'accusé de livraison + mode avion.
    api.put('/ghost', async (req, res) => {
        try {
            const enabled = await ghost.set(
                botState.activeSocket,
                req.body?.enabled === true,
                airplane,
                () => botState.activeSocket,
            );
            res.json({ success: true, enabled, patched: ghost.isPatched() });
        } catch (err) {
            const status = err.code === 'offline' ? 503 : err.code === 'not-patched' ? 409 : 502;
            res.status(status).json({ error: err.message, code: err.code || 'error' });
        }
    });

    // ── Messages et statuts programmés ────────────────────────────────────────
    // GET /api/scheduled — tous les éléments, triés par heure.
    api.get('/scheduled', (req, res) => res.json({ success: true, items: scheduler.list() }));

    // POST /api/scheduled — { kind: 'msg'|'st', chatId?, chatName?, text, ts, repeat?, bg?, media?: {type,mime,data(base64)} }
    api.post('/scheduled', async (req, res) => {
        try {
            const item = await scheduler.add(req.body || {});
            res.json({ success: true, item });
        } catch (err) {
            res.status(err.code === 'invalid' ? 400 : 500).json({ error: err.message, code: err.code || 'error' });
        }
    });

    // PATCH /api/scheduled/:id — { text?, ts?, repeat?, bg? }
    api.patch('/scheduled/:id', (req, res) => {
        try {
            const item = scheduler.update(Number(req.params.id), req.body || {});
            res.json({ success: true, item });
        } catch (err) {
            const status = err.code === 'not-found' ? 404 : err.code === 'invalid' ? 400 : 500;
            res.status(status).json({ error: err.message, code: err.code || 'error' });
        }
    });

    // DELETE /api/scheduled/:id
    api.delete('/scheduled/:id', (req, res) => {
        const ok = scheduler.remove(Number(req.params.id));
        res.status(ok ? 200 : 404).json(ok ? { success: true } : { error: 'introuvable', code: 'not-found' });
    });

    // POST /api/scheduled/:id/send — envoyer tout de suite, ou renvoyer un élément manqué.
    api.post('/scheduled/:id/send', async (req, res) => {
        try {
            const item = await scheduler.sendNow(Number(req.params.id));
            res.json({ success: true, item });
        } catch (err) {
            const status = err.code === 'not-found' ? 404 : err.code === 'invalid' ? 409 : 502;
            res.status(status).json({ error: err.message, code: err.code || 'error' });
        }
    });

    // ── Groupe privé et stickers déclencheurs ─────────────────────────────────
    // GET /api/bot-group — état du groupe, réglages et stickers (avec aperçu webp base64).
    api.get('/bot-group', (req, res) => res.json({ success: true, ...botGroup.publicState() }));

    // PUT /api/bot-group — { repliesToGroup?, capturesToGroup? }
    api.put('/bot-group', (req, res) => {
        const { repliesToGroup, capturesToGroup } = req.body || {};
        res.json({ success: true, ...botGroup.update({ repliesToGroup, capturesToGroup }) });
    });

    // POST /api/bot-group/create — crée le groupe, ou le recrée avec { recreate: true }.
    api.post('/bot-group/create', async (req, res) => {
        try {
            await botGroup.ensureGroup(botState.activeSocket, { recreate: req.body?.recreate === true });
            res.json({ success: true, ...botGroup.publicState() });
        } catch (err) {
            const status = err.code === 'offline' ? 503 : 502;
            res.status(status).json({ error: err.message, code: err.code || 'error' });
        }
    });

    // PATCH /api/bot-group/stickers/:id — { active }
    api.patch('/bot-group/stickers/:id', (req, res) => {
        const ok = botGroup.setStickerActive(req.params.id, req.body?.active !== false);
        if (!ok) return res.status(404).json({ error: 'sticker introuvable' });
        res.json({ success: true, ...botGroup.publicState() });
    });

    // DELETE /api/bot-group/stickers/:id
    api.delete('/bot-group/stickers/:id', (req, res) => {
        if (!botGroup.removeSticker(req.params.id)) return res.status(404).json({ error: 'sticker introuvable' });
        res.json({ success: true, ...botGroup.publicState() });
    });

    // DELETE /api/status/:id/react — retire la réaction envoyée à un statut.
    api.delete('/status/:id/react', async (req, res) => {
        try {
            await botState.statusActions.unreact(req.params.id);
            res.json({ success: true });
        } catch (err) {
            const status = { 'not-found': 404, offline: 503 }[err.code] || 502;
            res.status(status).json({ error: err.message, code: err.code || 'error' });
        }
    });

    // GET /api/status/history
    // Compteurs journaliers des 7 derniers jours pour le graphe de l'app.
    api.get('/status/history', (req, res) => {
        const today = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
        const cutoffKey = `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())}`;
        const prune = {};
        for (const [k, v] of Object.entries(botState.dailyStats)) {
            if (k >= cutoffKey) prune[k] = v;
        }
        botState.dailyStats = prune;
        const days = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
            const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
            const s = prune[key] || { liked: 0, viewed: 0 };
            days.push({
                date: key,
                label: i === 0 ? "aujourd'hui" : d.toLocaleDateString('fr-FR', { weekday: 'long' }),
                liked: s.liked,
                viewed: s.viewed,
            });
        }
        res.json({ days });
    });

    // POST /api/download/tiktok
    api.post('/download/tiktok', async (req, res) => {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'url requise' });
        try {
            const result = await tiktok.downloadTikTok(url);
            if (!result) return res.status(404).json({ error: 'Vidéo introuvable' });
            // Unifie le champ URL pour le client Flutter
            res.json({ ...result, downloadUrl: result.videoUrl || null });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/download/facebook
    api.post('/download/facebook', async (req, res) => {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'url requise' });
        try {
            const result = await facebook.downloadFacebook(url);
            if (!result) return res.status(404).json({ error: 'Vidéo introuvable' });
            // Unifie le champ URL pour le client Flutter
            res.json({ ...result, downloadUrl: result.videoUrl || null });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/download/youtube
    api.post('/download/youtube', async (req, res) => {
        const { url, type = 'video' } = req.body;
        if (!url) return res.status(400).json({ error: 'url requise' });
        try {
            const result = await youtube.downloadYouTube(url, type);
            if (!result) return res.status(404).json({ error: 'Contenu introuvable' });
            // downloadUrl est déjà présent dans la réponse YouTube
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── Téléchargement natif YouTube / Instagram (yt-dlp) ────────────────────
    const nativeFiles = new Map(); // id -> { filePath, mimeType, size, expires }
    const NATIVE_TTL_MS = 15 * 60 * 1000;
    const MAX_NATIVE_RUNNING = 2;
    let nativeRunning = 0;

    /** Vrai si le requérant présente un JWT valide OU la clé machine→machine. */
    function nativeAuthorized(req) {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : header;
        if (verifyJwt(token)) return true;
        const provided = Buffer.from(String(req.headers['x-download-key'] || ''), 'utf8');
        const expected = Buffer.from(String(config.downloadSecret || ''), 'utf8');
        return provided.length === expected.length &&
            crypto.timingSafeEqual(provided, expected);
    }

    function scheduleNativeCleanup(id, filePath) {
        setTimeout(() => {
            nativeFiles.delete(id);
            try { fs.unlinkSync(filePath); } catch (_) {}
        }, NATIVE_TTL_MS + 60_000).unref?.();
    }

    // POST /api/video/native — body: { url, quality? } → { downloadUrl: ... }
    api.post('/video/native', async (req, res) => {
        if (!nativeAuthorized(req)) {
            return res.status(401).json({ error: 'Non autorisé' });
        }
        const { url, quality } = req.body || {};
        if (!url || typeof url !== 'string') {
            return res.status(400).json({ error: 'url requise' });
        }
        if (nativeRunning >= MAX_NATIVE_RUNNING) {
            return res.status(429).json({ error: 'Trop de téléchargements en cours, réessayez dans un instant' });
        }
        nativeRunning++;
        try {
            const info = await ytNative.resolveNative(url, quality);
            const id = crypto.randomBytes(12).toString('hex');
            nativeFiles.set(id, {
                filePath: info.filePath,
                mimeType: info.mimeType,
                size: info.size,
                expires: Date.now() + NATIVE_TTL_MS,
            });
            scheduleNativeCleanup(id, info.filePath);
            const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
            const host = req.get('host') || 'localhost';
            res.json({
                success: true,
                platform: info.platform,
                title: info.title,
                quality: info.quality || null,
                mimeType: info.mimeType,
                size: info.size,
                downloadUrl: `${proto}://${host}/api/video/file/${id}`,
            });
        } catch (err) {
            const status = /Cookies Instagram|non supportée|ne contient pas/i.test(String(err.message)) ? 400 : 502;
            res.status(status).json({ error: err.message, code: status === 502 ? 'youtube-video-unavailable' : 'bad-request' });
        } finally {
            nativeRunning--;
        }
    });

    // GET /api/video/file/:id — stream du fichier (Range natif) puis cleanup
    api.get('/video/file/:id', (req, res) => {
        const entry = nativeFiles.get(req.params.id);
        if (!entry || entry.expires < Date.now()) {
            nativeFiles.delete(req.params.id);
            return res.status(404).json({ error: 'Fichier expiré ou introuvable' });
        }
        res.sendFile(entry.filePath, {
            headers: {
                'Content-Type': entry.mimeType,
                'Cache-Control': 'private, max-age=60',
            },
            dotfiles: 'deny',
            maxAge: '60s',
        }, (err) => {
            if (!res.headersSent) {
                res.status(404).json({ error: 'Fichier indisponible' });
            }
        });
    });

    // GET /api/antidelete/logs
    api.get('/antidelete/logs', (req, res) => {
        res.json(antiDelete.getLogs());
    });

    // GET /api/antidelete/media/:id
    api.get('/antidelete/media/:id', (req, res) => {
        const entry = antiDelete.getLogById(req.params.id);
        if (!entry) return res.status(404).json({ error: 'Non trouvé' });
        if (!entry.mediaBase64) return res.status(404).json({ error: 'Pas de média stocké' });
        res.json({ mediaBase64: entry.mediaBase64, mediaMime: entry.mediaMime });
    });

    // POST /api/antidelete/toggle
    api.post('/antidelete/toggle', (req, res) => {
        const { enabled } = req.body;
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ error: 'enabled (bool) requis' });
        }
        config.antiDeleteEnabled = enabled;
        try { persistConfigFields({ antiDeleteEnabled: enabled }); } catch (_) {}
        res.json({ success: true, antiDeleteEnabled: config.antiDeleteEnabled });
    });

    // GET /api/viewonce/logs
    api.get('/viewonce/logs', async (req, res) => {
        try {
            const logs = await viewOnce.getLogs();
            res.json(logs);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // GET /api/viewonce/media/:id  — retourne le buffer base64 + mime du média
    api.get('/viewonce/media/:id', async (req, res) => {
        try {
            const entry = await viewOnce.getLogById(req.params.id);
            if (!entry) return res.status(404).json({ error: 'Non trouvé' });
            if (!entry.mediaBase64) return res.status(404).json({ error: 'Pas de média stocké' });
            res.json({ mediaBase64: entry.mediaBase64, mediaMime: entry.mediaMime });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/viewonce/toggle
    api.post('/viewonce/toggle', (req, res) => {
        const { enabled } = req.body;
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ error: 'enabled (bool) requis' });
        }
        config.viewOnceEnabled = enabled;
        try { persistConfigFields({ viewOnceEnabled: enabled }); } catch (_) {}
        res.json({ success: true, viewOnceEnabled: config.viewOnceEnabled });
    });

    // POST /api/bot/viewonly
    api.post('/bot/viewonly', (req, res) => {
        const { enabled } = req.body;
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ error: 'enabled (bool) requis' });
        }
        botState.isViewOnly = enabled;
        if (enabled) botState.isActivelyLiking = false;
        res.json({ success: true, viewOnly: botState.isViewOnly, botActive: botState.isActivelyLiking });
    });

    // POST /api/whitelist
    api.post('/whitelist', (req, res) => {
        const { number, uid, action } = req.body;
        const input = uid || number;
        if (!input || !['add', 'remove'].includes(action)) {
            return res.status(400).json({ error: 'uid et action (add|remove) requis' });
        }
        const jid = toListJid(input);
        if (!jid) return res.status(400).json({ error: 'UID invalide' });
        if (action === 'add') {
            if (!config.whitelist.includes(jid)) config.whitelist.push(jid);
        } else {
            config.whitelist = config.whitelist.filter(n => n !== jid);
        }
        try {
            persistConfigFields({ whitelist: config.whitelist });
            filtersStore.saveFilters(config.whitelist, config.blacklist);
        } catch (_) {}
        res.json({ success: true, whitelist: config.whitelist });
    });

    // POST /api/blacklist
    api.post('/blacklist', (req, res) => {
        const { number, uid, action } = req.body;
        const input = uid || number;
        if (!input || !['add', 'remove'].includes(action)) {
            return res.status(400).json({ error: 'uid et action (add|remove) requis' });
        }
        const jid = toListJid(input);
        if (!jid) return res.status(400).json({ error: 'UID invalide' });
        if (action === 'add') {
            if (!config.blacklist.includes(jid)) config.blacklist.push(jid);
        } else {
            config.blacklist = config.blacklist.filter(n => n !== jid);
        }
        try {
            persistConfigFields({ blacklist: config.blacklist });
            filtersStore.saveFilters(config.whitelist, config.blacklist);
        } catch (_) {}
        res.json({ success: true, blacklist: config.blacklist });
    });

    // GET /api/groups — liste des groupes WhatsApp avec JID
    api.get('/groups', async (req, res) => {
        if (!botState.activeSocket) {
            return res.status(503).json({ error: 'Bot non connecté', groups: contacts.getGroups() });
        }
        try {
            const groups = await contacts.fetchGroupsFromSocket(botState.activeSocket);
            res.json({ success: true, count: groups.length, groups });
        } catch (err) {
            res.status(500).json({ error: err.message, groups: contacts.getGroups() });
        }
    });

    // GET /api/contacts — contacts individuels avec JID
    api.get('/contacts', async (req, res) => {
        if (botState.activeSocket) {
            try { await contacts.fetchGroupsFromSocket(botState.activeSocket); } catch (_) {}
        }
        const list = contacts.getContacts();
        res.json({ success: true, count: list.length, contacts: list });
    });

    // GET /api/directory — groupes + contacts combinés
    api.get('/directory', async (req, res) => {
        if (botState.activeSocket) {
            try { await contacts.fetchGroupsFromSocket(botState.activeSocket); } catch (_) {}
        }
        const all = contacts.getAll();
        res.json({
            success: true,
            count: all.length,
            groups: all.filter(i => i.type === 'group'),
            contacts: all.filter(i => i.type === 'contact'),
        });
    });

    // GET /api/live/feed — derniers événements temps réel
    api.get('/live/feed', (req, res) => {
        const limit = Math.min(parseInt(req.query.limit) || 20, 50);
        res.json({ events: liveEvents.getRecent(limit) });
    });

    // GET /api/live/stream — SSE temps réel
    api.get('/live/stream', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        liveEvents.subscribe(res);
        req.on('close', () => liveEvents.unsubscribe(res));
    });

    // POST /api/command/ping
    api.post('/command/ping', async (req, res) => {
        const start = Date.now();
        try {
            await Promise.resolve();
            const latency = Date.now() - start;
            res.json({ success: true, latency, message: 'Pong!', serverTime: new Date().toISOString() });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/command/tagall
    api.post('/command/tagall', async (req, res) => {
        const { groupJid } = req.body;
        if (!groupJid) return res.status(400).json({ error: 'groupJid requis' });
        if (!botState.activeSocket) return res.status(503).json({ error: 'Bot non connecté' });
        try {
            const result = await tagAll.executeTagAllApi(botState.activeSocket, groupJid);
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/command/screenshot
    api.post('/command/screenshot', async (req, res) => {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'url requise' });
        if (!url.startsWith('http')) return res.status(400).json({ error: 'URL invalide' });
        try {
            const result = await screenshot.downloadScreenshot(url);
            if (!result) return res.status(404).json({ error: 'Capture échouée' });
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/command/host
    api.get('/command/host', (req, res) => {
        try {
            const info = host.getHostInfo();
            res.json(info);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/bot/custom-commands — Récupérer les commandes actuelles
    api.get('/bot/custom-commands', (req, res) => {
        res.json({ customCommands: config.customCommands || { vv: 'vv', vv2: 'vv2', nice: 'nice' } });
    });

    // PUT /api/bot/custom-commands — Modifier les noms de commandes
    api.put('/bot/custom-commands', (req, res) => {
        const { vv, vv2, nice } = req.body || {};
        if (!config.customCommands) config.customCommands = { vv: 'vv', vv2: 'vv2', nice: 'nice' };
        if (vv !== undefined && typeof vv === 'string' && vv.trim()) config.customCommands.vv = vv.trim().toLowerCase();
        if (vv2 !== undefined && typeof vv2 === 'string' && vv2.trim()) config.customCommands.vv2 = vv2.trim().toLowerCase();
        if (nice !== undefined && typeof nice === 'string' && nice.trim()) config.customCommands.nice = nice.trim().toLowerCase();

        try {
            const configPath = path.join(__dirname, 'config.js');
            let configStr = fs.readFileSync(configPath, 'utf8');
            configStr = configStr.replace(
                /customCommands:\s*\{[^}]*\}/,
                `customCommands: ${JSON.stringify(config.customCommands)}`
            );
            fs.writeFileSync(configPath, configStr);
        } catch (e) {
            console.error('[API] Erreur persistance customCommands:', e.message);
        }

        res.json({ success: true, customCommands: config.customCommands });
    });

    // POST /api/command/send — Envoyer un message WhatsApp depuis l'app
    api.post('/command/send', async (req, res) => {
        const { jid, text } = req.body;
        if (!jid || !text) return res.status(400).json({ error: 'jid et text requis' });
        if (!botState.activeSocket) return res.status(503).json({ error: 'Bot non connecté' });
        try {
            await botState.activeSocket.sendMessage(jid, { text });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/send-message — Send message for chat heads
    api.post('/send-message', async (req, res) => {
        const { to, message } = req.body;
        if (!to || !message) return res.status(400).json({ error: 'to et message requis' });
        if (!botState.activeSocket) return res.status(503).json({ error: 'Bot non connecté' });
        try {
            await botState.activeSocket.sendMessage(to, { text: message });
            
            // Add to history
            addMessageToHistory(to, {
                text: message,
                fromMe: true,
                timestamp: new Date().toISOString(),
                name: 'Me',
                avatar: null,
            });
            
            // Broadcast to WebSocket clients
            broadcastMessage({
                chatId: to,
                text: message,
                fromMe: true,
                name: 'Me',
                avatar: null,
            });
            
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/chat/:chatId/history — Get chat history
    api.get('/chat/:chatId/history', (req, res) => {
        const { chatId } = req.params;
        const history = getChatHistory(chatId);
        res.json(history);
    });

    // GET /api/chats — Get all chats
    api.get('/chats', (req, res) => {
        const chats = getAllChats();
        res.json(chats);
    });

    app.use('/api', api);

    // ── Messages / Discussions (protégé par JWT) ─────────────────────────
    const messages = express.Router();
    messages.use(authRequired);
    messages.use(attachRefresh);
    // L'app interroge les conversations et les messages chaque seconde : la
    // limite des lectures doit rester largement au-dessus (elle bloquait
    // l'envoi avec un 429). L'envoi a sa propre limite, stricte.
    messages.use(rateLimit(1500, 60000));
    const sendLimit = rateLimit(60, 60000);

    // GET /api/messages/conversations
    messages.get('/conversations', (req, res) => {
        res.json({ conversations: conversationsList() });
    });

    // GET /api/messages/conversation-messages?chatId=&limit=
    messages.get('/conversation-messages', (req, res) => {
        const chatId = String(req.query.chatId || '');
        if (!chatId) return res.status(400).json({ error: 'chatId requis' });
        const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
        // Fusionne les fils LID ↔ PN pour ne rien perdre selon le JID de l'app.
        const merged = [...getChatHistory(chatId)];
        const seenIds = new Set(merged.map(m => m?.id).filter(Boolean));
        for (const j of contacts.jidCandidates(chatId)) {
            if (j === chatId) continue;
            for (const m of getChatHistory(j)) {
                if (m?.id && seenIds.has(m.id)) continue;
                if (m?.id) seenIds.add(m.id);
                merged.push(m);
            }
        }
        const unique = dedupeMessages(merged).slice(-limit);
        res.json({ chatId, messages: unique.map(m => toMessageDto(m, chatId)) });
    });

    // GET /api/messages/profile-picture/:contactId — proxy base64 de l'avatar
    messages.get('/profile-picture/:contactId', async (req, res) => {
        const sock = botState.activeSocket;
        if (!sock) return res.status(503).json({ error: 'Bot non connecté' });
        const candidates = contacts.jidCandidates(req.params.contactId);
        let url = null;
        for (const id of candidates) {
            try {
                url = await withTimeout(sock.profilePictureUrl(id, 'preview'), 10_000, 'profilePictureUrl');
                if (url) break;
            } catch (_) {
                url = null;
            }
        }
        if (!url) return res.status(404).json({ error: 'Pas de photo de profil' });
        try {
            const resp = await withTimeout(fetch(url), 10_000, 'avatar fetch');
            if (!resp.ok) return res.status(404).json({ error: 'Pas de photo de profil' });
            const buf = Buffer.from(await resp.arrayBuffer());
            res.json({
                contactId: req.params.contactId,
                data: buf.toString('base64'),
                mime: resp.headers.get('content-type') || 'image/png',
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/messages/media/:chatId/:msgId — contenu d'un média capturé
    messages.get('/media/:chatId/:msgId', (req, res) => {
        const chatId = String(req.params.chatId || '');
        const msgId = String(req.params.msgId || '');
        const m = getChatHistory(chatId).find(x => x.id === msgId);
        if (!m || !m.mediaData) {
            return res.status(404).json({ error: 'Média indisponible' });
        }
        res.json({
            chatId,
            msgId,
            data: m.mediaData,
            mime: m.mediaMime || 'application/octet-stream',
            name: m.mediaName || '',
        });
    });

    // POST /api/messages/send
    messages.post('/send', sendLimit, async (req, res) => {
        const { chatId, text } = req.body || {};
        if (!chatId || !text) return res.status(400).json({ error: 'chatId et text requis' });
        const sock = botState.activeSocket;
        if (!sock) return res.status(503).json({ error: 'Bot non connecté' });
        // Essayer le JID fourni, puis le PN/LID miroir (contacts récents).
        const targets = contacts.jidCandidates(chatId);
        if (!targets.length) targets.push(String(chatId));
        try {
            let sentTo = targets[0];
            let sentId = null;
            let lastErr = null;
            for (const target of targets) {
                try {
                    const sent = await sock.sendMessage(target, { text: String(text) });
                    sentId = sent?.key?.id || null;
                    sentTo = target;
                    lastErr = null;
                    break;
                } catch (e) {
                    lastErr = e;
                    console.warn(`[Send] échec vers ${target}: ${e?.message || e}`);
                }
            }
            if (lastErr) throw lastErr;
            const ts = new Date().toISOString();
            const msg = {
                id: sentId || `me-${Date.now()}`,
                text: String(text),
                fromMe: true,
                timestamp: ts,
                name: 'Me',
                avatar: null,
            };
            // Historique sous le chatId demandé par l'app (pas le JID miroir).
            addMessageToHistory(chatId, msg);
            // Même id sous le JID effectif : la dédup par id neutralise l'écho.
            if (sentTo !== chatId) addMessageToHistory(sentTo, { ...msg });
            broadcastMessage({ chatId, text: String(text), fromMe: true, name: 'Me', avatar: null, id: msg.id });
            res.json({ success: true, message: toMessageDto(msg, chatId) });
        } catch (err) {
            console.error(`[Send] échec chatId=${chatId} : ${err?.stack || err}`);
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/messages/session/export
    // Sauvegarde JSON de la session WhatsApp (toutes les lignes de ce signal
    // state Supabase). Se fait depuis l'app → Réglages → Session. Restauration
    // possible après perte du pairage, sans resssocier le numéro.
    messages.get('/session/export', async (req, res) => {
        try {
            // PostgREST plafonne les réponses à 1000 lignes : lecture paginée
            // par tranches de 1000 pour ne jamais tronquer la session.
            const all = [];
            const step = 1000;
            for (let offset = 0; ; offset += step) {
                const { data, error } = await supabaseAdmin
                    .from('whatsapp_auth')
                    .select('id, data')
                    .not('id', 'in', '(filters,session_lock)')
                    .range(offset, offset + step - 1);
                if (error) return res.status(500).json({ error: error.message });
                all.push(...(data || []));
                if (!data || data.length < step) break;
            }
            res.json({
                success: true,
                exportedAt: new Date().toISOString(),
                phone: getPhoneNumber(),
                count: all.length,
                rows: all.map(r => ({ id: r.id, data: r.data })),
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/messages/session/import
    // Restaure une session depuis le JSON produit par l'export.
    messages.post('/session/import', async (req, res) => {
        const body = req.body || {};
        const rows = Array.isArray(body.rows)
            ? body.rows
            : (Array.isArray(body.session?.rows) ? body.session.rows : null);
        if (!rows || rows.length === 0) {
            return res.status(400).json({ error: 'Aucune ligne de session à importer' });
        }
        let imported = 0;
        try {
            for (const r of rows) {
                if (!r || typeof r.id !== 'string' || !r.id) continue;
                if (CONTROL_ROWS.has(r.id)) continue; // lignes de contrôle, à ignorer
                await supabaseAdmin
                    .from('whatsapp_auth')
                    .upsert({ id: r.id, data: r.data }, { onConflict: 'id' });
                imported++;
            }
            res.json({
                success: true,
                imported,
                note: 'La session sera rechargée au prochain redémarrage du bot.',
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.use('/api/messages', messages);

    // WebSocket : pas de app.listen ici (index.js écoute déjà le port).
    // On expose attachWebSocket(server) pour brancher l'upgrade.
    const wss = new WebSocket.Server({ noServer: true });
    wss.on('connection', (ws) => {
        wsClients.add(ws);
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        console.log('[WS] Client connected, total clients:', wsClients.size);
        ws.on('close', () => {
            wsClients.delete(ws);
            console.log('[WS] Client disconnected, total clients:', wsClients.size);
        });
        ws.on('error', (error) => {
            console.error('[WS] Error:', error);
            wsClients.delete(ws);
        });
    });

    // Heartbeat : purge les clients morts (réseau coupé sans 'close' propre).
    const heartbeat = setInterval(() => {
        for (const ws of wsClients) {
            if (ws.isAlive === false) {
                ws.terminate();
                wsClients.delete(ws);
                continue;
            }
            ws.isAlive = false;
            try { ws.ping(); } catch (_) { ws.terminate(); }
        }
    }, 30_000);
    heartbeat.unref?.();
    wss.on('close', () => clearInterval(heartbeat));

    setupApi._wss = wss;
}

/** Branche le serveur WebSocket sur le HTTP server créé par index.js.
 * Authentification requise : l'app connecte wss://host/ws?token=<JWT>. */
function attachWebSocket(server) {
    const wss = setupApi._wss;
    if (!wss || !server) return;
    server.on('upgrade', (request, socket, head) => {
        const url = request.url || '/';
        // / ou /ws — l'app Flutter se connecte en wss://host/ws?token=<JWT>
        if (url === '/' || url.startsWith('/ws') || url.startsWith('/?')) {
            const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
            const token = new URLSearchParams(query).get('token') || '';
            if (!verifyJwt(token)) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        } else {
            socket.destroy();
        }
    });
}

module.exports = {
    setupApi,
    attachWebSocket,
    addMessageToHistory,
    updateHistoryMessage,
    broadcastMessage,
    getChatHistory,
    removeChat,
    getAllChats,
    flushChatHistory,
    hydrateChatHistory,
    getChatIds,
    findHistoryMessage,
    rateLimit,
};
