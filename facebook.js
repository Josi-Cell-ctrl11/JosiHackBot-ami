const axios = require('axios');
const { downloadFacebook: resolveFacebook } = require('./mediaDownload.js');

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
 * Commande Facebook : Télécharge une vidéo depuis Facebook.
 */
const executeFacebook = async (sock, msg) => {
    const remoteJid = msg.key.remoteJid;
    const textContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    const url = textContent.trim().split(/\s+/).slice(1).join(' ');

    if (!url) {
        return await sock.sendMessage(
            remoteJid,
            { text: "❌ Veuillez fournir le lien d'une vidéo Facebook publique. Exemple: *?fb https://fb.watch/...*" },
            { quoted: msg }
        );
    }

    try {
        console.log(`[FB] Téléchargement de: ${url}`);
        sock.sendMessage(remoteJid, { react: { text: '🕘', key: msg.key } }).catch(() => {});

        const fbData = await resolveFacebook(url);
        if (!fbData?.downloadUrl && !fbData?.videoUrl) {
            sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } }).catch(() => {});
            return await sock.sendMessage(
                remoteJid,
                { text: '❌ Aucune vidéo trouvée pour ce lien. Assurez-vous qu\'elle soit publique.' },
                { quoted: msg }
            );
        }

        const videoUrl = fbData.videoUrl || fbData.downloadUrl;
        const title = fbData.title || 'Vidéo Facebook';

        await sock.sendMessage(
            remoteJid,
            {
                video: await downloadMediaBuffer(videoUrl),
                caption: `╭───────◇\n│ 🤖 *JOSIHACK FB-DL* 🤖\n╰───────◇\n\n📌 *Titre:* ${title}\n\n> © JosiHack Bot BOY`,
                mimetype: 'video/mp4',
            },
            { quoted: msg }
        );
        sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } }).catch(() => {});
    } catch (error) {
        console.error('[FB] Error:', error.message);
        sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } }).catch(() => {});
        await sock.sendMessage(
            remoteJid,
            { text: '❌ Erreur lors du téléchargement. Le lien est peut-être privé, protégé ou invalide.' },
            { quoted: msg }
        );
    }
};

async function downloadFacebook(url) {
    return resolveFacebook(url);
}

module.exports = { executeFacebook, downloadFacebook };
