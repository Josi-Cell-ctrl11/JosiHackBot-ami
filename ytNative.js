const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config.js');

const TMP = '/tmp';
const IG_COOKIE_FILE = path.join(TMP, 'ig_cookies.txt');
const YT_COOKIE_FILE = path.join(TMP, 'yt_cookies.txt');
const META_TIMEOUT_MS = 45000;
const DOWNLOAD_TIMEOUT_MS = 150000;

const CLIENT_LADDER = [
    null,
    'youtube:player_client=tv,android',
    'youtube:player_client=web_embedded',
];

const MIME_BY_EXT = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    mov: 'video/quicktime',
    m4a: 'audio/mp4',
    mp3: 'audio/mpeg',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
};

let cachedYtdlp;
function getYtdlp() {
    if (cachedYtdlp !== undefined) return cachedYtdlp;
    try {
        cachedYtdlp = require('yt-dlp-exec');
    } catch (e) {
        console.warn('[YTNAT] yt-dlp-exec indisponible:', e.message);
        cachedYtdlp = null;
    }
    return cachedYtdlp;
}

function platformOf(url) {
    if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
    if (/instagram\.com/i.test(url)) return 'instagram';
    return null;
}

/** Matérialise IG_COOKIES (format Netscape) dans /tmp si valide. */
function ensureIgCookieFile() {
    const raw = config.igCookies;
    if (!raw || typeof raw !== 'string') return null;
    if (!/# Netscape HTTP Cookie File/i.test(raw) || !/sessionid/.test(raw)) return null;
    try {
        fs.writeFileSync(IG_COOKIE_FILE, raw.trim(), 'utf8');
        try { fs.chmodSync(IG_COOKIE_FILE, 0o600); } catch (_) {}
        return IG_COOKIE_FILE;
    } catch (e) {
        console.warn('[YTNAT] écriture cookies IG:', e.message);
        return null;
    }
}

/** Matérialise YT_COOKIES (format Netscape) dans /tmp si valide.
 * Les cookies *PSIDTS sont volontairement ignorés : ce sont des jetons de
 * session tournants, presque toujours périmés au moment de l'export, qui
 * font échouer l'authentification ("The page needs to be reloaded"). */
function ensureYtCookieFile() {
    const raw = config.ytCookies;
    if (!raw || typeof raw !== 'string') return null;
    if (!/# Netscape HTTP Cookie File/i.test(raw)) return null;
    const kept = raw.trim().split(/\r?\n/).filter((line) => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return true;
        const fields = line.split('\t');
        return !(fields.length >= 7 && /PSIDTS$/.test(String(fields[5] || '').trim()));
    });
    try {
        fs.writeFileSync(YT_COOKIE_FILE, kept.join('\n') + '\n', 'utf8');
        try { fs.chmodSync(YT_COOKIE_FILE, 0o600); } catch (_) {}
        return YT_COOKIE_FILE;
    } catch (e) {
        console.warn('[YTNAT] écriture cookies YouTube:', e.message);
        return null;
    }
}

/** Flag proxy pour yt-dlp si YT_PROXY renseigné. */
function proxyFlag() {
    const p = config.ytProxy;
    return p && typeof p === 'string' && p.trim() ? { proxy: p.trim() } : {};
}

function withKill(promise, ms) {
    let timer;
    const killer = new Promise((_, reject) => {
        timer = setTimeout(() => {
            try { promise.cancel && promise.cancel(); } catch (_) {}
            reject(Object.assign(new Error('Timeout yt-dlp'), { code: 'YT_TIMEOUT' }));
        }, ms);
    });
    return Promise.race([promise, killer]).finally(() => clearTimeout(timer));
}

async function fetchMeta(url, cookies, extractorArgs) {
    const yt = getYtdlp();
    if (!yt) throw new Error('Moteur yt-dlp non initialisé');
    const flags = {
        dumpSingleJson: true,
        noDownload: true,
        noPlaylist: true,
        noWarnings: true,
        ignoreConfig: true,
        noProgress: true,
        socketTimeout: 100,
        ...proxyFlag(),
        ...(cookies ? { cookies } : {}),
        ...(extractorArgs ? { extractorArgs } : {}),
    };
    const result = await withKill(yt.exec(url, flags, { maxBuffer: 64 * 1024 * 1024 }), META_TIMEOUT_MS);
    const stdout = String(result && result.stdout || '').trim();
    if (!stdout || !stdout.startsWith('{')) throw new Error('Métadonnées yt-dlp illisibles');
    return JSON.parse(stdout);
}

function cleanupPartial(base) {
    try {
        for (const f of fs.readdirSync(TMP)) {
            if (f.startsWith(base)) {
                try { fs.unlinkSync(path.join(TMP, f)); } catch (_) {}
            }
        }
    } catch (_) {}
}

function finalizeFile(base) {
    for (const ext of Object.keys(MIME_BY_EXT)) {
        const p = path.join(TMP, `${base}.${ext}`);
        try {
            const st = fs.statSync(p);
            if (st.isFile() && st.size > 0) return { filePath: p, size: st.size, ext };
        } catch (_) {}
    }
    return null;
}

async function downloadFile(url, cookies, extractorArgs, format) {
    const yt = getYtdlp();
    if (!yt) throw new Error('Moteur yt-dlp non initialisé');
    const base = `jh${crypto.randomBytes(4).toString('hex')}${Date.now().toString(36)}`;
    const flags = {
        format,
        output: `${base}.%(ext)s`,
        paths: TMP,
        mergeOutputFormat: 'mp4',
        maxFilesize: '250M',
        noPlaylist: true,
        noMtime: true,
        noWarnings: true,
        ignoreConfig: true,
        noProgress: true,
        retries: 2,
        socketTimeout: 100,
        ffmpegLocation: 'ffmpeg',
        ...proxyFlag(),
        ...(cookies ? { cookies } : {}),
        ...(extractorArgs ? { extractorArgs } : {}),
    };
    try {
        await withKill(yt.exec(url, flags, { stderr: 'ignore' }), DOWNLOAD_TIMEOUT_MS);
        const file = finalizeFile(base);
        if (!file) throw new Error('Aucun fichier produit par yt-dlp');
        return file;
    } catch (e) {
        cleanupPartial(base);
        throw e;
    }
}

/**
 * Télécharge une vidéo YouTube / Instagram via yt-dlp et renvoie le fichier
 * local (+ infos). Lève on erreur ; pas de fichier → exception.
 */
async function resolveNative(url, quality) {
    const yt = getYtdlp();
    if (!yt) throw new Error('Moteur yt-dlp non initialisé');

    const plat = platformOf(url);
    if (!plat) throw new Error('URL non supportée (YouTube ou Instagram uniquement)');

    let cookies = null;
    if (plat === 'instagram') {
        cookies = ensureIgCookieFile();
        if (!cookies) throw new Error('Cookies Instagram requis : renseigner IG_COOKIES (format Netscape, cookie sessionid)');
    } else if (plat === 'youtube') {
        cookies = ensureYtCookieFile();
    }

    const num = Math.max(144, Math.min(parseInt(String(quality || ''), 10) || 720, 1080));
    const format = plat === 'instagram'
        ? 'b'
        : `bv[height<=${num}][ext=mp4]+ba[ext=m4a]/b[height<=${num}]/b`;

    let lastErr = null;
    const attempts = [];
    for (const ea of CLIENT_LADDER) {
        try {
            const meta = await fetchMeta(url, cookies, ea);
            if (plat === 'instagram') {
                const hasVideo = Array.isArray(meta.formats)
                    && meta.formats.some((f) => f && f.vcodec && f.vcodec !== 'none');
                if (!hasVideo) throw new Error('Ce contenu Instagram ne contient pas de vidéo');
            }
            const { filePath, size, ext } = await downloadFile(url, cookies, ea, format);
            if (!fs.existsSync(filePath) || size <= 0) throw new Error('Fichier illisible après téléchargement');
            return {
                platform: plat,
                title: meta.title || 'Média',
                filePath,
                size,
                mimeType: MIME_BY_EXT[ext] || 'video/mp4',
                quality: plat === 'youtube' ? `${num}p` : 'auto',
            };
        } catch (e) {
            lastErr = e;
            attempts.push(`${ea || 'default'}: ${String(e.message).split('\n')[0].trim().slice(0, 140)}`);
            if (e && e.code === 'YT_TIMEOUT') break;
        }
    }
    const err = lastErr || new Error('Échec du téléchargement (yt-dlp)');
    if (attempts.length) err.message = `${err.message} | clients testés: ${attempts.join(' | ')}`;
    if (plat === 'youtube' && !cookies && !config.ytProxy && /not a bot|Sign in to confirm/i.test(err.message)) {
        throw new Error('YouTube bloque l\'adresse IP du serveur (anti-bot). Renseignez YT_COOKIES (session YouTube exportée en format Netscape) ou YT_PROXY pour contourner.');
    }
    console.warn('[YTNAT] échec', plat, err.message);
    throw err;
}

module.exports = { resolveNative, platformOf };