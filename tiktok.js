const { downloadTikTok: resolveTikTok } = require('./mediaDownload.js');
const axios = require('axios');

/**
 * Commande TikTok : Télécharge une vidéo TikTok sans watermark.
 */
const executeTikTok = async (sock, msg) => {
    const remoteJid = msg.key.remoteJid;
    const textContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    const url = textContent.trim().split(/\s+/).slice(1).join(' ');

    if (!url || !url.startsWith('http')) {
        return await sock.sendMessage(
            remoteJid,
            { text: '❌ Veuillez fournir un lien TikTok valide.\nExemple : *?tiktok https://vm.tiktok.com/...*' },
            { quoted: msg }
        );
    }

    try {
        sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } }).catch(() => {});

        const result = await resolveTikTok(url);
        if (!result?.downloadUrl && !result?.videoUrl) {
            sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } }).catch(() => {});
            return await sock.sendMessage(
                remoteJid,
                { text: '❌ Impossible de télécharger cette vidéo. Le lien est peut-être privé ou invalide.' },
                { quoted: msg }
            );
        }

        const videoUrl = result.videoUrl || result.downloadUrl;
        console.log(`[TIKTOK] Source: ${result.source} | URL: ${videoUrl.substring(0, 60)}...`);

        const videoBuffer = await downloadBuffer(videoUrl);
        if (!videoBuffer || videoBuffer.length < 10000) {
            // Fallback : envoyer l'URL directe si le buffer échoue
            await sock.sendMessage(
                remoteJid,
                {
                    video: { url: videoUrl },
                    caption:
                        `╭───────◇\n` +
                        `│ 🤖 *JOSIHACK TK-DL* 🤖\n` +
                        `╰───────◇\n\n` +
                        (result.title ? `📌 *${result.title}*\n\n` : '') +
                        `> © JosiHack Bot BOY`,
                    mimetype: 'video/mp4',
                },
                { quoted: msg }
            );
            sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } }).catch(() => {});
            return;
        }

        await sock.sendMessage(
            remoteJid,
            {
                video: videoBuffer,
                caption:
                    `╭───────◇\n` +
                    `│ 🤖 *JOSIHACK TK-DL* 🤖\n` +
                    `╰───────◇\n\n` +
                    (result.title ? `📌 *${result.title}*\n\n` : '') +
                    `> © JosiHack Bot BOY`,
                mimetype: 'video/mp4',
                gifPlayback: false,
            },
            { quoted: msg }
        );
        sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } }).catch(() => {});
    } catch (error) {
        console.error('[TIKTOK] Error:', error.message);
        sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } }).catch(() => {});
        await sock.sendMessage(remoteJid, { text: '❌ Erreur lors du téléchargement TikTok.' }, { quoted: msg });
    }
};

async function downloadBuffer(url) {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 90000,
            maxContentLength: 100 * 1024 * 1024,
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                Referer: 'https://www.tiktok.com/',
                Accept: 'video/mp4,video/*;q=0.9,*/*;q=0.8',
            },
        });
        return Buffer.from(response.data);
    } catch (e) {
        console.error('[TIKTOK] downloadBuffer error:', e.message);
        return null;
    }
}

async function downloadTikTok(url) {
    const result = await resolveTikTok(url);
    if (!result) return null;
    // L'API REST renvoie l'URL ; le client Flutter télécharge lui-même.
    // Optionnellement on peut joindre du base64 pour petits fichiers.
    return {
        title: result.title || 'TikTok Video',
        source: result.source,
        videoUrl: result.videoUrl || result.downloadUrl,
        downloadUrl: result.downloadUrl || result.videoUrl,
        thumbnail: result.thumbnail || null,
        mimeType: 'video/mp4',
    };
}

module.exports = { executeTikTok, downloadTikTok };
