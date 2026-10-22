const config = require('./config.js');
const { createClient } = require('@supabase/supabase-js');

// Supabase client (même credentials que l'auth)
const supabase = createClient(config.supabaseUrl, config.supabaseKey);
const TABLE = 'viewonce_logs';

// Cache mémoire léger pour éviter des requêtes Supabase répétées (liste)
let _cache = [];
let _cacheLoaded = false;

async function _loadCache() {
    if (_cacheLoaded) return;
    try {
        const { data, error } = await supabase
            .from(TABLE)
            .select('id, from_name, phone, type, preview, time, chat, has_media, media_mime')
            .order('time', { ascending: false })
            .limit(100);
        if (!error && data) {
            _cache = data.map(r => ({
                id: r.id,
                from: r.from_name,
                phone: r.phone,
                type: r.type,
                preview: r.preview,
                time: r.time,
                chat: r.chat,
                hasMedia: r.has_media,
                mediaMime: r.media_mime,
            }));
        }
        _cacheLoaded = true;
    } catch (e) {
        console.error('[ViewOnce] Erreur chargement cache:', e.message);
    }
}

function isEnabled() {
    return config.viewOnceEnabled !== false;
}

/** Retourne les logs sans le média base64 (pour la liste) */
async function getLogs() {
    await _loadCache();
    return _cache;
}

/** Retourne le média base64 + mime depuis Supabase pour un id donné */
async function getLogById(id) {
    try {
        const { data, error } = await supabase
            .from(TABLE)
            .select('*')
            .eq('id', id)
            .maybeSingle();
        if (error || !data) return null;
        return {
            id: data.id,
            from: data.from_name,
            phone: data.phone,
            type: data.type,
            preview: data.preview,
            time: data.time,
            chat: data.chat,
            hasMedia: data.has_media,
            mediaBase64: data.media_base64 || null,
            mediaMime: data.media_mime || null,
        };
    } catch (e) {
        console.error('[ViewOnce] Erreur getLogById:', e.message);
        return null;
    }
}

/**
 * Enregistre une vue unique capturée manuellement (via ?vv, ?vv2, ?nice)
 * @param {{ id, senderPhone, pushName, messageTypeStr, remoteJid, buffer }} params
 */
async function logCapture({ id, senderPhone, pushName, messageTypeStr, remoteJid, buffer, force }) {
    if (!force && !isEnabled()) return;

    const type = messageTypeStr.includes('image') ? 'Image'
        : messageTypeStr.includes('video') ? 'Vidéo'
        : messageTypeStr.includes('audio') ? 'Audio' : 'Média';

    const chat = remoteJid?.endsWith('@g.us') ? 'Groupe' : 'Privé';

    const mediaMime = messageTypeStr.includes('image') ? 'image/jpeg'
        : messageTypeStr.includes('video') ? 'video/mp4'
        : messageTypeStr.includes('audio') ? 'audio/mpeg' : null;

    const entryId = id || `${Date.now()}`;
    const fromName = pushName || `+${senderPhone}`;
    const mediaBase64 = buffer ? buffer.toString('base64') : null;
    const timeStr = new Date().toISOString();
    const preview = chat === 'Groupe' ? '👁️ Vue unique capturée (groupe)' : '👁️ Vue unique capturée';

    // Sauvegarder dans Supabase
    try {
        const { error } = await supabase.from(TABLE).upsert({
            id: entryId,
            from_name: fromName,
            phone: senderPhone || '',
            type,
            preview,
            time: timeStr,
            chat,
            has_media: !!mediaBase64,
            media_base64: mediaBase64,
            media_mime: mediaMime,
        }, { onConflict: 'id' });

        if (error) {
            console.error('[ViewOnce] Erreur sauvegarde Supabase:', error.message);
        } else {
            console.log(`[ViewOnce] ✅ Sauvegardé dans Supabase — id=${entryId} type=${type}`);
        }
    } catch (e) {
        console.error('[ViewOnce] Exception sauvegarde:', e.message);
    }

    // Mettre à jour le cache mémoire
    const cacheEntry = { id: entryId, from: fromName, phone: senderPhone || '', type, preview, time: timeStr, chat, hasMedia: !!mediaBase64, mediaMime };
    _cache = [cacheEntry, ..._cache.filter(e => e.id !== entryId)].slice(0, 100);

    // Live event
    try {
        const liveEvents = require('./liveEvents.js');
        liveEvents.pushEvent('viewonce', { id: entryId, from: fromName, type, preview });
    } catch (_) {}
}

module.exports = { getLogs, getLogById, logCapture, isEnabled };
