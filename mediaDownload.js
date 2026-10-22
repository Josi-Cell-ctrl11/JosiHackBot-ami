/**
 * Téléchargements médias multi-sources (YouTube / Facebook / TikTok).
 * Les APIs tierces cassent souvent : on enchaîne plusieurs backends.
 */
const axios = require('axios');

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const http = axios.create({
    timeout: 30000,
    maxRedirects: 5,
    headers: { 'User-Agent': UA },
    validateStatus: (s) => s >= 200 && s < 400,
});

function pickUrl(...cands) {
    for (const c of cands) {
        if (typeof c === 'string' && /^https?:\/\//i.test(c)) return c;
    }
    return null;
}

function deepFindUrl(obj, keys = ['download_url', 'downloadUrl', 'url', 'link', 'video', 'play', 'hd', 'sd'], depth = 0, visited = new Set()) {
    if (!obj || typeof obj !== 'object') return null;
    if (depth > 6 || visited.has(obj)) return null;
    visited.add(obj);
    for (const k of keys) {
        if (typeof obj[k] === 'string' && /^https?:\/\//i.test(obj[k])) return obj[k];
    }
    for (const v of Object.values(obj)) {
        if (typeof v === 'string' && /^https?:\/\//i.test(v) && /\.(mp4|m4a|mp3)(\?|$)/i.test(v)) return v;
        if (v && typeof v === 'object') {
            const found = deepFindUrl(v, keys, depth + 1, visited);
            if (found) return found;
        }
    }
    return null;
}

async function davidCyril(path, url, extraParams = {}) {
    const res = await http.get(`https://apis.davidcyriltech.my.id/${path}`, {
        params: { url, ...extraParams },
        timeout: 60000,
    });
    const data = res.data;
    if (!data) return null;
    if (data.success === false || data.status === 500) return null;

    // YouTube ytmp4 / ytmp3
    if (data.result) {
        const r = data.result;
        const downloadUrl = pickUrl(r.download_url, r.downloadUrl, r.url, r.link);
        if (downloadUrl) {
            return {
                title: r.title || 'Média',
                downloadUrl,
                thumbnail: r.thumbnail || null,
                mimeType: (r.type === 'audio' || r.format === 'mp3') ? 'audio/mpeg' : 'video/mp4',
                quality: r.quality || extraParams.quality || null,
                source: 'davidcyril',
            };
        }
    }

    // Facebook facebook2
    if (data.video) {
        const downloads = data.video.downloads || [];
        const hd = downloads.find((d) => /hd/i.test(d.quality || ''));
        const sd = downloads.find((d) => /sd/i.test(d.quality || '')) || downloads[0];
        const downloadUrl = pickUrl(hd?.downloadUrl, sd?.downloadUrl, data.video.url);
        if (downloadUrl) {
            return {
                title: data.video.title || 'Vidéo Facebook',
                downloadUrl,
                thumbnail: data.video.thumbnail || null,
                mimeType: 'video/mp4',
                source: 'davidcyril-fb',
            };
        }
    }

    const fallback = deepFindUrl(data);
    if (fallback) {
        return {
            title: data.title || data.result?.title || 'Média',
            downloadUrl: fallback,
            thumbnail: data.thumbnail || data.result?.thumbnail || null,
            mimeType: 'video/mp4',
            source: 'davidcyril',
        };
    }
    return null;
}

async function fetchTikWm(url) {
    try {
        const res = await http.post(
            'https://www.tikwm.com/api/',
            new URLSearchParams({ url, hd: '1' }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 }
        );
        const d = res.data?.data;
        if (res.data?.code === 0 && d) {
            const videoUrl = pickUrl(d.play, d.hdplay, d.wmplay);
            if (!videoUrl) return null;
            return {
                title: d.title || 'TikTok',
                downloadUrl: videoUrl,
                thumbnail: d.cover || d.origin_cover || null,
                mimeType: 'video/mp4',
                source: 'tikwm',
            };
        }
    } catch (e) {
        console.warn('[DL] tikwm:', e.message);
    }
    return null;
}

async function fetchLoveTik(url) {
    try {
        const res = await http.post(
            'https://lovetik.com/api/ajax/search',
            new URLSearchParams({ query: url }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 }
        );
        const data = res.data;
        const links = data?.links || data?.vid_list || [];
        let downloadUrl = null;
        if (Array.isArray(links)) {
            for (const l of links) {
                downloadUrl = pickUrl(l?.a, l?.url, typeof l === 'string' ? l : null);
                if (downloadUrl) break;
            }
        }
        downloadUrl = downloadUrl || pickUrl(data?.tiktok?.video, data?.video, deepFindUrl(data));
        if (!downloadUrl) return null;
        return {
            title: data?.desc || data?.title || 'TikTok',
            downloadUrl,
            thumbnail: data?.cover || data?.thumbnail || null,
            mimeType: 'video/mp4',
            source: 'lovetik',
        };
    } catch (e) {
        console.warn('[DL] lovetik:', e.message);
        return null;
    }
}

async function fetchSnapTik(url) {
    try {
        const pageRes = await http.get('https://snaptik.app/en', { timeout: 15000 });
        const tokenMatch = String(pageRes.data || '').match(/name="token"\s+value="([^"]+)"/);
        if (!tokenMatch) return null;
        const formRes = await http.post(
            'https://snaptik.app/abc2.php',
            new URLSearchParams({ url, token: tokenMatch[1] }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Referer: 'https://snaptik.app/en',
                },
                timeout: 25000,
            }
        );
        const html = String(formRes.data || '');
        const linkMatches = [...html.matchAll(/href="(https:\/\/[^"]+\.mp4[^"]*)"/g)];
        if (!linkMatches.length) return null;
        const videoUrl = linkMatches[0][1].replace(/&amp;/g, '&');
        const titleMatch = html.match(/<p[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)<\/p>/);
        return {
            title: titleMatch ? titleMatch[1].trim() : 'TikTok',
            downloadUrl: videoUrl,
            thumbnail: null,
            mimeType: 'video/mp4',
            source: 'snaptik',
        };
    } catch (e) {
        console.warn('[DL] snaptik:', e.message);
        return null;
    }
}

async function fetchTtDownloader(url) {
    try {
        const page = await http.get('https://ttdownloader.com/', { timeout: 15000 });
        const tokenMatch = String(page.data || '').match(/name="token"\s+value="([^"]+)"/);
        if (!tokenMatch) return null;
        const cookies = (page.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
        const formRes = await http.post(
            'https://ttdownloader.com/search/',
            new URLSearchParams({ url, format: '', token: tokenMatch[1] }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Cookie: cookies,
                    Referer: 'https://ttdownloader.com/',
                },
                timeout: 30000,
            }
        );
        const links = [...String(formRes.data || '').matchAll(/https:\/\/[^"'\s]+\.mp4[^"'\s]*/g)].map((m) => m[0]);
        if (!links.length) return null;
        return {
            title: 'TikTok',
            downloadUrl: links[0],
            thumbnail: null,
            mimeType: 'video/mp4',
            source: 'ttdownloader',
        };
    } catch (e) {
        console.warn('[DL] ttdownloader:', e.message);
        return null;
    }
}

async function fetchYtdown(url) {
    try {
        const res = await http.post(
            'https://app.ytdown.to/wp-json/aio-dl/video-data/',
            new URLSearchParams({ url, token: '' }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Referer: 'https://app.ytdown.to/',
                    Origin: 'https://app.ytdown.to',
                },
                timeout: 45000,
            }
        );
        const medias = res.data?.medias;
        if (!Array.isArray(medias) || !medias.length) return null;
        return { title: res.data.title || 'YouTube', medias, thumbnail: res.data.thumbnail, source: 'ytdown' };
    } catch (e) {
        console.warn('[DL] ytdown:', e.message);
        return null;
    }
}

function pickBestVideo(medias) {
    // Formats plus légers d'abord : plus stables via CDN / proxy web.
    for (const q of ['360p', '480p', '240p', '720p', '1080p']) {
        const m = medias.find((x) => x.extension === 'mp4' && x.quality?.includes(q) && x.url);
        if (m?.url) return m.url;
    }
    return medias.find((m) => m.extension === 'mp4' && m.url)?.url || null;
}

function pickBestAudio(medias) {
    return medias.find((m) => (m.extension === 'mp3' || m.extension === 'm4a' || m.type === 'audio') && m.url)?.url || null;
}

async function fetchTiklyDown(url) {
    try {
        const res = await http.get(
            `https://api.tiklydown.eu.org/api/download?url=${encodeURIComponent(url)}`,
            { timeout: 25000 }
        );
        const d = res.data;
        const videoUrl = pickUrl(
            d?.video?.noWatermark,
            d?.video?.play,
            d?.video?.download,
            d?.video,
            deepFindUrl(d)
        );
        if (!videoUrl) return null;
        return {
            title: d?.title || d?.author?.nickname || 'TikTok',
            downloadUrl: videoUrl,
            thumbnail: d?.cover || d?.images?.[0] || null,
            mimeType: 'video/mp4',
            source: 'tiklydown',
        };
    } catch (e) {
        console.warn('[DL] tiklydown:', e.message);
        return null;
    }
}

async function resolveShortLink(url) {
    // vm.tiktok.com / vt.tiktok.com → redirige vers l'URL complète. Les
    // providers refusent souvent les liens courts, on les résout d'abord.
    if (!/^(https?:\/\/)?(vm|vt)\.tiktok\.com\//i.test(url)) return url;
    try {
        const res = await http.get(url, {
            maxRedirects: 0,
            validateStatus: (s) => s >= 300 && s < 400,
            timeout: 15000,
        });
        const loc = res.headers?.location;
        return loc ? new URL(loc, url).href : url;
    } catch (e) {
        console.warn('[DL] resolveShortLink:', e.message);
        return url;
    }
}

async function downloadTikTok(url) {
    if (!url) return null;
    url = await resolveShortLink(url);
    // Budget global : on n'épuise pas le process sur une liste infinie de
    // providers morts. Chaque pas ne peut pas dépasser ~25-30 s.
    const deadline = Date.now() + 90000;
    const remaining = () => deadline - Date.now();
    const chain = [
        () => fetchTikWm(url),
        () => fetchTiklyDown(url),
        () => fetchLoveTik(url),
        () => fetchTtDownloader(url),
        () => fetchSnapTik(url),
        () => davidCyril('download/tiktok', url),
    ];
    for (const fn of chain) {
        if (remaining() <= 0) break;
        try {
            const r = await fn();
            if (r?.downloadUrl) {
                console.log(`[DL] TikTok via ${r.source}`);
                return {
                    title: r.title || 'TikTok Video',
                    videoUrl: r.downloadUrl,
                    downloadUrl: r.downloadUrl,
                    thumbnail: r.thumbnail || null,
                    mimeType: 'video/mp4',
                    source: r.source,
                };
            }
        } catch (e) {
            console.warn('[DL] TikTok step:', e.message);
        }
    }
    return null;
}

async function downloadFacebook(url) {
    if (!url) return null;
    // 1) davidcyril facebook2 (stable)
    try {
        const r = await davidCyril('facebook2', url);
        if (r?.downloadUrl) {
            console.log(`[DL] Facebook via ${r.source}`);
            return {
                title: r.title,
                videoUrl: r.downloadUrl,
                downloadUrl: r.downloadUrl,
                thumbnail: r.thumbnail,
                mimeType: 'video/mp4',
                source: r.source,
            };
        }
    } catch (e) {
        console.warn('[DL] facebook david:', e.message);
    }

    // 2) @xaviabot/fb-downloader
    try {
        let getFBInfo = require('@xaviabot/fb-downloader');
        getFBInfo = typeof getFBInfo === 'function' ? getFBInfo : getFBInfo.default;
        if (typeof getFBInfo === 'function') {
            const fb = await getFBInfo(url);
            const videoUrl = pickUrl(fb?.hd, fb?.sd);
            if (videoUrl) {
                console.log('[DL] Facebook via fb-downloader');
                return {
                    title: fb.title || 'Vidéo Facebook',
                    videoUrl,
                    downloadUrl: videoUrl,
                    thumbnail: fb.thumbnail || null,
                    mimeType: 'video/mp4',
                    source: 'fb-downloader',
                };
            }
        }
    } catch (e) {
        console.warn('[DL] fb-downloader:', e.message);
    }
    return null;
}

async function downloadYouTube(queryOrUrl, type = 'video') {
    if (!queryOrUrl) return null;

    let url = queryOrUrl.trim();
    let title = null;
    let thumbnail = null;
    let author = null;
    let duration = null;

    const isUrl = /^https?:\/\//i.test(url) && /(youtube\.com|youtu\.be)/i.test(url);
    if (!isUrl) {
        try {
            const yts = require('yt-search');
            const search = await yts(url);
            const video = search.videos?.[0];
            if (!video) return null;
            url = video.url;
            title = video.title;
            thumbnail = video.thumbnail;
            author = video.author?.name;
            duration = video.timestamp;
        } catch (e) {
            console.warn('[DL] yt-search:', e.message);
            return null;
        }
    }

    // 1) davidcyril — vidéo : tenter plusieurs qualités (360 → 720)
    try {
        if (type === 'audio') {
            const r = await davidCyril('download/ytmp3', url);
            if (r?.downloadUrl) {
                console.log(`[DL] YouTube via ${r.source} audio`);
                return {
                    title: title || r.title,
                    author,
                    duration,
                    type,
                    downloadUrl: r.downloadUrl,
                    mimeType: 'audio/mpeg',
                    thumbnail: thumbnail || r.thumbnail,
                    source: r.source,
                };
            }
        } else {
            for (const quality of ['360', '480', '720']) {
                try {
                    const r = await davidCyril('download/ytmp4', url, { quality });
                    if (r?.downloadUrl) {
                        console.log(`[DL] YouTube via ${r.source} q=${quality}`);
                        return {
                            title: title || r.title,
                            author,
                            duration,
                            type,
                            downloadUrl: r.downloadUrl,
                            mimeType: 'video/mp4',
                            thumbnail: thumbnail || r.thumbnail,
                            quality,
                            source: r.source,
                        };
                    }
                } catch (_) {}
            }
            const r = await davidCyril('download/ytmp4', url);
            if (r?.downloadUrl) {
                console.log(`[DL] YouTube via ${r.source}`);
                return {
                    title: title || r.title,
                    author,
                    duration,
                    type,
                    downloadUrl: r.downloadUrl,
                    mimeType: 'video/mp4',
                    thumbnail: thumbnail || r.thumbnail,
                    source: r.source,
                };
            }
        }
    } catch (e) {
        console.warn('[DL] yt david:', e.message);
    }

    // 2) ytdown.to
    try {
        const data = await fetchYtdown(url);
        if (data?.medias) {
            const downloadUrl = type === 'audio' ? pickBestAudio(data.medias) : pickBestVideo(data.medias);
            if (downloadUrl) {
                console.log('[DL] YouTube via ytdown');
                return {
                    title: title || data.title,
                    author,
                    duration,
                    type,
                    downloadUrl,
                    mimeType: type === 'audio' ? 'audio/mpeg' : 'video/mp4',
                    thumbnail: thumbnail || data.thumbnail,
                    source: 'ytdown',
                };
            }
        }
    } catch (e) {
        console.warn('[DL] ytdown:', e.message);
    }

    return null;
}

module.exports = {
    downloadTikTok,
    downloadFacebook,
    downloadYouTube,
};
