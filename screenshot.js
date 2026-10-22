const axios = require('axios');
const net = require('net');
const { withTimeout } = require('./withTimeout.js');

const SS_API = 'https://api.siputzx.my.id/api/tools/ssweb';
const SS_TIMEOUT = 15_000;

/** Vrai si l'hôte (hôte numérique) est privé/loopback — les captures
 *  servent uniquement à des sites publics, jamais l'intérieur du réseau. */
function isPrivateHost(host) {
    const h = (host || '').toLowerCase().replace(/\.$/, '');
    if (h === 'localhost' || h.endsWith('.localhost')) return true;
    if (h === 'metadata.google.internal' || h.endsWith('.internal')) return true;
    if (!net.isIP(h)) return false; // hostname non-IP : premier saut sur l'API externe
    if (net.isIPv4(h)) {
        const [a, b] = h.split('.').map(Number);
        if (a === 10 || a === 127) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 169 && b === 254) return true;
        if (a === 0 || (a === 100 && b >= 64 && b <= 127)) return true;
    } else if (h === '::1' || h === '::') {
        return true;
    }
    return false;
}

/** Valide et normalise une URL de capture : http(s) + hôte public. null sinon. */
function sanitizeScreenshotUrl(input) {
    const raw = String(input || '').trim();
    if (!/^https?:\/\//i.test(raw)) return null;
    let parsed;
    try {
        parsed = new URL(raw);
    } catch (_) {
        return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (isPrivateHost(parsed.hostname)) return null;
    return parsed.href;
}

async function capture(apiUrl, url) {
    const response = await withTimeout(
        axios.get(apiUrl, { responseType: 'arraybuffer', timeout: SS_TIMEOUT }),
        SS_TIMEOUT + 2_000,
        'ss web'
    );
    if (!response || response.status !== 200) {
        throw new Error('Réponse API invalide');
    }
    return response;
}

/**
 * Commande Screenshot : Capture une image d'un site web à partir d'une URL.
 * 
 * @param {object} sock - Le socket Baileys.
 * @param {object} msg - Le message reçu.
 */
const executeScreenshot = async (sock, msg) => {
    const remoteJid = msg.key.remoteJid;
    const textContent = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
    const url = sanitizeScreenshotUrl(textContent.trim().split(/\s+/).slice(1).join(' '));

    if (!url) {
        return await sock.sendMessage(remoteJid, { text: "❌ URL invalide. Exemple: *?ss https://google.com* (http/https, hôte public uniquement)" }, { quoted: msg });
    }

    try {
        console.log(`[SS] Tentative de capture pour: ${url}`);
        // Signalement visuel (non bloquant)
        sock.sendMessage(remoteJid, { react: { text: "📸", key: msg.key } }).catch(() => {});

        const response = await capture(`${SS_API}?url=${encodeURIComponent(url)}`, url);

        await sock.sendMessage(
            remoteJid,
            {
                image: Buffer.from(response.data, "binary"),
                caption: `╭───────◇\n│ 🤖 *JOSIHACK SS-WEB* 🤖\n╰───────◇\n\n🔗 *URL:* ${url}\n\n> © JosiHack Bot BOY`,
            },
            { quoted: msg }
        );

        // Réaction finale (non bloquante)
        sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } }).catch(() => {});
    } catch (error) {
        console.error('[SS] Error:', error.message);
        sock.sendMessage(remoteJid, { react: { text: "❌", key: msg.key } }).catch(() => {});
        await sock.sendMessage(remoteJid, { text: "❌ Impossible de capturer ce site. Il est peut-être protégé ou l'URL est incorrecte." }, { quoted: msg });
    }
};

/**
 * Capture une image d'un site web via l'API REST (sans WhatsApp).
 */
async function downloadScreenshot(url) {
    const clean = sanitizeScreenshotUrl(url);
    if (!clean) return null;

    try {
        const response = await capture(`${SS_API}?url=${encodeURIComponent(clean)}`, clean);
        return {
            url: clean,
            success: true,
            data: Buffer.from(response.data, "binary").toString('base64'),
            mimeType: 'image/jpeg',
        };
    } catch (error) {
        return null;
    }
}

module.exports = { executeScreenshot, downloadScreenshot, sanitizeScreenshotUrl };