-- JosiHackBot2 — schéma minimal de persistance.
--
-- Toute la persistance du bot passe par UNE seule table : la session Baileys
-- (creds + clés de signal), le verrou de session, les listes blanche/noire,
-- l'historique des discussions et le cache des statuts y sont rangés par
-- ligne, chacun sous son propre `id` :
--
--   creds           → session WhatsApp (ce qui permet de survivre à un redéploiement)
--   session_lock    → mutex : un seul socket à la fois (TTL 90 s)
--   filters         → listes blanche/noire de statuts
--   chat_history    → fils de discussion conservés
--   status_seen     → cache des statuts déjà traités
--
-- `data` est volontairement un jsonb : le format des creds Baileys évolue avec
-- les versions de la bibliothèque, on ne veut pas figer un schéma colonne par
-- colonne et casser la reprise de session à chaque mise à jour de Baileys.

create table if not exists public.whatsapp_auth (
    id   text primary key,
    data jsonb not null default '{}'::jsonb
);

comment on table public.whatsapp_auth is
    'Persistance JosiHackBot2 : session Baileys, verrou, filtres, historique, statuts.';

-- Row Level Security : le backend parle toujours avec la clé service_role, qui
-- contourne les policies. Aucune policy n'est donc nécessaire, et le rôle
-- anon (exposé dans le bundle Flutter) ne peut rien lire.
alter table public.whatsapp_auth enable row level security;