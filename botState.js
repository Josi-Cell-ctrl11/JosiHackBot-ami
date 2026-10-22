/**
 * État partagé du bot — accessible par index.js et api.js
 */
const botState = {
    botStartTime: Math.floor(Date.now() / 1000),
    isActivelyLiking: true,
    fixedEmoji: null,
    isViewOnly: false,
    activeSocket: null,
    whatsappConnected: false,
    // ── JosiConnect / pairing ────────────────────────────────────────────────
    // Code d'association en attente (demandé au boot ou via /api/whatsapp/pair).
    pairingCode: null,
    pairingPhone: null,
    pairingRequestedAt: 0,
    pairingExpiresIn: 300, // secondes de validité d'un code WhatsApp (~5 min)
    // Numéro demandé pendant une phase de réinitialisation de session : le
    // nouveau socket vierge générera le code pour CE numéro.
    pendingPairPhone: null,
    // Deferred partagé api.js <-> index.js : api.js attend que index.js ait
    // généré le code sur le socket fraîchement recréé (phase de reset).
    pairingDeferred: null,
    // Auto-request au boot quand aucune session n'existe (fallback headless).
    autoPair: true,
    // Forcé par /whatsapp/reset : relance une session vierge pour associer
    // un autre numéro.
    forceReconnect: false,
    lastPairError: null,
    // ── Anti-428 ──────────────────────────────────────────────────────────────
    // WhatsApp ferme la connexion (428 connectionClosed) quand on lui martèle
    // des sockets. Reconnecter toutes les 10-120 s ne fait qu'aggraver la
    // pénalité : il faut laisser WhatsApp « oublier » avant de réessayer.
    // Timestamp (ms) avant lequel AUCUN nouveau socket ne doit être créé.
    waCooldownUntil: 0,
    // Raison affichée à l'utilisateur quand le pair est refusé pendant la pause.
    waCooldownReason: null,
    // Auteurs récents de statuts (jid -> { jid, phone, at }), alimente le
    // sélecteur liste blanche/noire de l'app. Capé à 40.
    recentStatusAuthors: new Map(),
    // Flux des statuts reçus (feed "Aujourd'hui") — chaque entrée retrace ce
    // que le bot a fait (reçu / bloqué / vu / liké) avec le délai prévu.
    statusFeed: [],
    statusDelayMode: 'random',
    statusDelayMin: 2000,
    statusDelayMax: 6000,
    statusDelayFixed: 3000,
    // Compteurs journaliers par jour (clé 'YYYY-MM-DD' locale) : alimente le
    // graphe "7 derniers jours" de l'app. Prune à 7 jours à la lecture.
    dailyStats: {},
    stats: {
        statusesLiked: 0,
        statusesViewed: 0,
        messagesProcessed: 0,
    },
    // Dernière réaction envoyée : id du message, ACK reçu (null = en attente).
    // Exposé dans /api/status pour vérifier que WhatsApp applique le like.
    lastReaction: null,
};

module.exports = botState;
