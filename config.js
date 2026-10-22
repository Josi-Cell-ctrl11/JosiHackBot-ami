// Copie du bot : remplace chaque valeur « A_REMPLIR » par la tienne avant de
// déployer. La clé d'accès (apiKey) est celle à saisir dans l'app, Réglages ›
// Connexion › Clé d'accès.
const env = process.env;

module.exports = {
    // Clé échangée contre un JWT par POST /api/auth/login.
    apiKey: "A_REMPLIR_CLE_ACCES_APP",
    // Secret HMAC de signature des JWT.
    jwtSecret: "-linqBYanyveIYV9RwcOPMHidJAK7-QCLIvA50g-tnU",
    apiPort: Number(env.PORT) || 3000,

    // Secret partagé pour les appels machine→machine.
    downloadSecret: "5DQ4hHlxbO8RhzW9WuZaLdQ-oHvrT5_Zocx81aVW7MM",

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
    owners: ["A_REMPLIR_NUMERO_SANS_PLUS"],

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
    phoneNumber: env.WA_PHONE_NUMBER || "A_REMPLIR_NUMERO_SANS_PLUS",
    
    // Base Supabase du bot — projet `pnzmntrffvvylgvfwzvy` (l'ancienne base a
    // été supprimée). Le schéma tient dans une seule table, `whatsapp_auth`
    // (id + data jsonb), versionnée dans supabase/migrations/.
    //
    // Credentials EN DUR et SANS lecture de l'environnement, volontairement :
    // le service Render conservait des variables pointant vers l'ancienne base,
    // morte. Tant qu'elles existent, un `env.X || valeur` laisserait le bot
    // parler à une base supprimée — le verrou n'est jamais obtenu, aucun socket
    // n'est monté et JosiConnect affiche « canPair: false » pour toujours.
    //
    // Conséquence à garder en tête : la clé service_role est lisible dans le
    // dépôt (le projet est privé). Elle n'ouvre que `whatsapp_auth` — RLS
    // activée, aucune policy, donc le rôle anon du bundle Flutter n'y accède
    // pas. Si elle est un jour compromise, il faut la pivoter dans le tableau
    // Supabase ET mettre à jour cette ligne.
    supabaseUrl: "https://A_REMPLIR_ID_PROJET.supabase.co",
    supabaseKey: "A_REMPLIR_CLE_SERVICE_ROLE_SUPABASE",

    // Anti-Delete settings
    antiDeleteEnabled: true,
    antiDeleteChat: "", // Default destination for deleted messages

    // Anti Vue Unique — intercepte et sauvegarde les médias éphémères
    viewOnceEnabled: true,

    // Global settings
    sendWelcomeMessage: false // Whether to send a message to yourself when the bot connects
};
