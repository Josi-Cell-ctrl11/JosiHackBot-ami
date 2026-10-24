// Configuration du bot. Les secrets et identifiants viennent des variables
// d'environnement du service Render (jamais écrits dans ce fichier) :
//   API_KEY                    clé d'accès, à saisir dans l'app (Réglages › Connexion)
//   JWT_SECRET                 secret de signature des JWT (chaîne aléatoire longue)
//   DOWNLOAD_SECRET            secret des appels machine→machine (chaîne aléatoire longue)
//   OWNER_NUMBER               ton numéro sans + ni espaces (ex. 2290000000)
//   WA_PHONE_NUMBER            le même numéro
//   SUPABASE_URL               https://<ton-projet>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  clé service_role de ta base (secrète)
const env = process.env;

module.exports = {
    // Clé échangée contre un JWT par POST /api/auth/login.
    apiKey: env.API_KEY || "",
    // Secret HMAC de signature des JWT.
    jwtSecret: env.JWT_SECRET || "",
    apiPort: Number(env.PORT) || 3000,

    // Secret partagé pour les appels machine→machine.
    downloadSecret: env.DOWNLOAD_SECRET || "",

    // Cookies Instagram (format Netscape) — obligatoires pour télécharger des
    // posts/reels Instagram (l'accès anonyme est bloqué). Vide = indisponible.
    igCookies: env.IG_COOKIES || "",

    // Cookies YouTube (format Netscape) — contourne le bot-check "Sign in to
    // confirm you're not a bot" sur les IP de datacenter. Vide = non utilisé.
    ytCookies: env.YT_COOKIES || "",

    // Proxy réseau pour yt-dlp (ex: socks5://user:pass@host:port) — secours
    // anti-bot pour YouTube/TikTok si les cookies ne suffisent pas.
    ytProxy: env.YT_PROXY || "",

    // Command prefix
    prefix: "?",

    customCommands: {
        vv: 'vv',
        vv2: 'vv2',
        nice: 'nice',
    },

    // List of owner numbers or IDs (LIDs)
    owners: env.OWNER_NUMBER ? [env.OWNER_NUMBER] : [],

    // Array of emojis the bot will randomly choose from to react to statuses
    reactionEmojis: ["🩷", "❤️", "💙", "🖤", "❤️", "🔥", "🤍", "💞", "💕", "💓", "💝", "❤️", "🔥", "🫶", "🙌", "🌚", "🙂", "↔️", "🫶🏼", "👀", "🥺", "😎", "🤩"],

    // Programmateur d'activité : windowe horaire pendant laquelle le bot
    // réagit aux statuts (pause hors plage). Désactivé par défaut.
    scheduleEnabled: false,
    scheduleStart: "07:00",
    scheduleEnd: "23:00",

    // Réactions personnalisées par expéditeur : tableau d'overrides qui
    // priment sur l'emoji et le délai globaux quand l'auteur correspond
    // (assigné par phone "2296..." ou uid "...@lid"). delayMs en millisecondes.
    authorReactions: [],

    // Adressage de la clé de réaction aux statuts :
    //   'pn'  (défaut) → participant = PN auteur résolu (@s.whatsapp.net).
    //         WhatsApp ignore silencieusement les réactions dont la cible ne
    //         correspond pas au statut côté compte récepteur.
    //   'lid' → garder le participant @lid tel que reçu (ancien comportement).
    reactKeyMode: 'pn',

    // Filtre par type de média : tableau des seuls types à réagir
    // ("image", "video", "audio", "texte", "document"). Vide = réagit à tout.
    statusMediaTypes: [],

    // Optional auto-reply message sent to the user when a status is reacted to.
    // Set to empty string "" to disable auto-reply.
    autoReplyMessage: "",

    // Set to true to automatically like your own posted statuses
    likeMyOwnStatus: true,

    // If whitelist is not empty, the bot will ONLY react to statuses from these UIDs.
    // Format : "123456789012345@lid" ou "22900000000@s.whatsapp.net"
    whitelist: [],

    // If blacklist is not empty, the bot will IGNORE statuses from these UIDs.
    // Format must be exactly like whitelist items.
    blacklist: [],

    // Set to true to use Pairing Code instead of QR code for login
    usePairingCode: true,

    // Provide your phone number if using pairing code (e.g., "1234567890")
    // Include the country code but no '+' sign or spaces.
    phoneNumber: env.WA_PHONE_NUMBER || "",
    
    // Base Supabase : une seule table, `whatsapp_auth` (voir supabase/migrations/).
    // La clé service_role contourne la sécurité des lignes : ne jamais la publier.
    supabaseUrl: env.SUPABASE_URL || "",
    supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY || "",

    // Anti-Delete settings
    antiDeleteEnabled: true,
    antiDeleteChat: "", // Default destination for deleted messages

    // Anti Vue Unique — intercepte et sauvegarde les médias éphémères
    viewOnceEnabled: true,

    // Global settings
    sendWelcomeMessage: false // Whether to send a message to yourself when the bot connects
};
