/**
 * Verrou de session (mutex) via Supabase — un seul socket WhatsApp à la fois.
 *
 * Pendant un redéploiement Render, l'ancienne instance survit quelques
 * secondes pendant que la nouvelle démarre : deux sockets sur la même session
 * provoquent un conflit 440/401 et WhatsApp *déconnecte* la session (perte du
 * pairage). Ce verrou force la nouvelle instance à attendre que l'ancienne ait
 * libéré (ou que son heartbeat soit périmé) avant de se connecter.
 */
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const config = require('./config.js');

const TABLE = 'whatsapp_auth';
const ROW_ID = 'session_lock';
// 90 s sans heartbeat => verrou considéré orphelin (reprise après kill -9).
const TTL_MS = 90_000;
const HEARTBEAT_MS = 25_000;

const supabaseDefault = createClient(config.supabaseUrl, config.supabaseKey);

// Client injectable (tests locaux : Supabase peut être injoignable).
let db = supabaseDefault;
const __setDb = (fake) => { db = fake; };

const owner = crypto.randomUUID();

const local = { owner, acquiredAt: 0 };
let heartbeatTimer = null;

/** Verrou conservé par une autre instance encore vivante ? (pur, testable) */
function isHeldByOther(data) {
    return !!data && !!data.owner && data.owner !== owner &&
        (Date.now() - (data.lastHeartbeat || 0)) < TTL_MS;
}

/** Prend le verrou. true si cette instance peut connecter son socket. */
async function acquire() {
    const MAX_ATTEMPTS = 4;
    const RETRY_DELAY_MS = 5_000;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const { data, error } = await db
                .from(TABLE)
                .select('id, data')
                .eq('id', ROW_ID)
                .maybeSingle();
            if (error) throw error;

            // Une autre instance vit encore : on diffère la connexion.
            if (isHeldByOther(data?.data)) {
                return false;
            }

            local.acquiredAt = Date.now();
            const { error: upsertError } = await db.from(TABLE).upsert(
                { id: ROW_ID, data: { owner, acquiredAt: local.acquiredAt, lastHeartbeat: Date.now() } },
                { onConflict: 'id' }
            );
            if (upsertError) throw upsertError;
            startHeartbeat();
            return true;
        } catch (e) {
            // Version dégradée de Supabase : on retente un peu avant de céder.
            // Fail-closed : sans Supabase le creds ne peut pas être lu, donc se
            // connecter de force créerait un 2e socket (conflit 440/401).
            console.warn(`[LOCK] acquire() échec ${attempt}/${MAX_ATTEMPTS} (%s)`, e?.message);
            if (attempt < MAX_ATTEMPTS) {
                await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
            }
        }
    }
    console.error('[LOCK] Supabase injoignable — connexion WhatsApp refusée (fail-closed).');
    return false;
}

function heartbeat() {
    try {
        db.from(TABLE).upsert(
            { id: ROW_ID, data: { owner, acquiredAt: local.acquiredAt, lastHeartbeat: Date.now() } },
            { onConflict: 'id' }
        ).catch(() => {});
    } catch (_) {}
}

function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
    heartbeatTimer.unref?.();
}

function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

/** Libère le verrou (arrêt propre). Les instances mortes expirent par TTL. */
async function release() {
    stopHeartbeat();
    if (!local.acquiredAt) return;
    try {
        const { data } = await db
            .from(TABLE)
            .select('id, data')
            .eq('id', ROW_ID)
            .maybeSingle();
        if (data && data.data && data.data.owner === owner) {
            await db.from(TABLE).upsert(
                { id: ROW_ID, data: { ...data.data, releasedAt: Date.now(), lastHeartbeat: 0 } },
                { onConflict: 'id' }
            );
        }
    } catch (_) {}
}

module.exports = { acquire, release, owner, isHeldByOther, __setDb };
