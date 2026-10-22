// Copie cette fichier vers config.js, ou mieux : renseigne les variables
// d'environnement (Render) ci-dessous et supprime les secrets de config.js.
//
// EN PRODUCTION (Render) : configure ces env vars et retire les valeurs en
// clair de config.js. Révoque aussi les anciennes clés Supabase (service_role)
// exposées dans l'historique du dépôt.
//
//   API_KEY           Token API REST de l'app (ex: "change-me")
//   JWT_SECRET        Secret HMAC des JWT Discussions (long, aléatoire)
//   SUPABASE_URL      URL du projet Supabase
//   SUPABASE_SERVICE_ROLE_KEY  Secret service_role — NE PAS exposer côté client
//   SUPABASE_KEY                Alias historique accepté, même secret serveur
//   WA_PHONE_NUMBER   Numéro du compte WhatsApp (sans '+' ni espaces)
//   PORT              Port HTTP (Render l'injecte automatiquement)
//   DOWNLOAD_SECRET   Secret partagé machine→machine (téléchargement natif)
//   IG_COOKIES        Cookies Instagram connectés (format Netscape) — requis
//                     pour télécharger des posts/reels Instagram (anonyme bloqué).
//                     Ligne ~ # Netscape HTTP Cookie File puis ex:
//                     instagram.com	TRUE	/	FALSE	0	sessionid	<valeur>...
//   YT_COOKIES        Cookies YouTube connectés (format Netscape) — contourne
//                     le bot-check YouTube "Sign in to confirm" sur les IP de
//                     datacenter (Render). Même procédure d'export que IG.
//                     Les cookies *PSIDTS sont automatiquement ignorés (jetons
//                     périmés qui cassent l'authentification).
//   YT_PROXY          Proxy réseau pour yt-dlp (ex: socks5://user:pass@host:port)
//                     — recours si cookies insuffisants.

// Variables du format .env pour un lancement local :
//
//   API_KEY=change-me
//   JWT_SECRET=change-me-to-a-long-random-secret
//   SUPABASE_URL=https://qbqkdafuvmrogrxzemgd.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=service-role-secret-never-share
//   WA_PHONE_NUMBER=22900000000
//   DOWNLOAD_SECRET=long-random-secret
//   IG_COOKIES=# Netscape HTTP Cookie File\ninstagram.com\tTRUE\t/\tFALSE\t0\tsessionid\t...
//   YT_COOKIES=# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\t...
//   YT_PROXY=
//   PORT=3000
