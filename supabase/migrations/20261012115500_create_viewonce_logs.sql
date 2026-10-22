-- Logs des médias à vue unique déjà écrits par viewonce.js.
-- RLS sans policy publique : seul le backend de confiance (service_role) y accède.
create table if not exists public.viewonce_logs (
    id           text primary key,
    from_name    text not null,
    phone        text not null default '',
    type         text not null default 'Média',
    preview      text not null default '',
    time         timestamptz not null default now(),
    chat         text not null default 'Privé',
    has_media    boolean not null default false,
    media_base64 text,
    media_mime   text
);

create index if not exists viewonce_logs_time_idx
    on public.viewonce_logs (time desc);

alter table public.viewonce_logs enable row level security;

comment on table public.viewonce_logs is
    'Captures de médias à vue unique enregistrées par le backend JosiHackBot; accès serveur uniquement.';
