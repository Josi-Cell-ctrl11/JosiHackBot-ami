const axios = require('axios');
const { downloadYouTube: resolveYouTube } = require('./mediaDownload.js');

async function downloadMediaBuffer(url) {
    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: 150 * 1024 * 1024,
        maxBodyLength: 150 * 1024 * 1024,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
            Accept: 'video/mp4,video/*,audio/*;q=0.9,*/*;q=0.8',
        },
    });
    const buffer = Buffer.from(response.data);
    if (!buffer.length) throw new Error('Média vide reçu du CDN');
    return buffer;
}
/**
 * Commande YouTube : Télécharge une vidéo / audio depuis YouTube.
 */
const executeYouTube = async (sock, msg, type = 'video') => {
    const remoteJid = msg.key.remoteJid;
    const textContent =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        '';

    const query = textContent.trim().split(/\s+/).slice(1).join(' ');

    if (!query) {
        const cmdName = type === 'audio' ? 'play' : 'playvid';
        return await sock.sendMessage(
            remoteJid,
            { text: `❌ Veuillez fournir un nom de vidéo ou un lien YouTube.\nExemple : *?${cmdName} Burna Boy Last Last*` },
            { quoted: msg }
        );
    }

    try {
        sock.sendMessage(remoteJid, { react: { text: '🔍', key: msg.key } }).catch(() => {});
        sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } }).catch(() => {});

        const result = await resolveYouTube(query, type);
        if (!result?.downloadUrl) {
            throw new Error('Impossible de récupérer les données de la vidéo.');
        }

        const title = result.title || 'YouTube';
        const author = result.author || '—';
        const duration = result.duration || '—';

        if (type === 'audio') {
            await sock.sendMessage(
                remoteJid,
                {
                    audio: await downloadMediaBuffer(result.downloadUrl),
                    mimetype: 'audio/mpeg',
                    fileName: `${title}.mp3`,
                },
                { quoted: msg }
            );
        } else {
            const caption =
                `╭───〔 🎬 *YOUTUBE PLAYER* 〕───⬣\n` +
                `│\n` +
                `│ 📌 *Titre* : ${title}\n` +
                `│ 👤 *Chaîne* : ${author}\n` +
                `│ ⏱️ *Durée* : ${duration}\n` +
                `│\n` +
                `│ 📥 _Téléchargé via JosiHack Bot_\n` +
                `╰──────────────⬣`;

            await sock.sendMessage(
                remoteJid,
                {
                    video: await downloadMediaBuffer(result.downloadUrl),
                    caption,
                    mimetype: 'video/mp4',
                },
                { quoted: msg }
            );
        }

        sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } }).catch(() => {});
    } catch (error) {
        console.error('[YT] Erreur :', error.message);
        sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } }).catch(() => {});
        await sock.sendMessage(
            remoteJid,
            { text: `❌ Échec du traitement.\n\nNote: ${error.message}` },
            { quoted: msg }
        );
    }
};

async function downloadYouTube(query, type = 'video') {
    return resolveYouTube(query, type);
}

module.exports = { executeYouTube, downloadYouTube };
