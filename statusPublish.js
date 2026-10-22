'use strict';

const { spawn } = require('child_process');

/** Convertit un son en OGG/Opus (format des vocaux WhatsApp) avec ffmpeg. */
function toOpus(buffer) {
    return new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-vn', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1']);
        const out = [];
        const err = [];
        ff.stdout.on('data', (d) => out.push(d));
        ff.stderr.on('data', (d) => err.push(d));
        ff.on('error', reject);
        ff.on('close', (code) => {
            if (code === 0 && out.length) resolve(Buffer.concat(out));
            else reject(new Error(`ffmpeg: ${Buffer.concat(err).toString().slice(0, 200) || code}`));
        });
        ff.stdin.on('error', () => {});
        ff.stdin.end(buffer);
    });
}

/**
 * Contenu Baileys d'un statut : texte, photo, vidéo ou vocal.
 * `convert` est injectable pour les tests.
 */
async function buildStatusContent(status, convert = toOpus) {
    const m = status.media;
    if (!m) return { content: { text: status.text }, options: { backgroundColor: status.backgroundColor } };
    const caption = status.text || undefined;
    if (m.type === 'image') {
        return { content: { image: m.buffer, caption }, options: {} };
    }
    if (m.type === 'video') {
        return { content: { video: m.buffer, caption, mimetype: m.mime || 'video/mp4' }, options: {} };
    }
    let audio = m.buffer;
    let mimetype = 'audio/ogg; codecs=opus';
    if (!/ogg/i.test(m.mime || '')) {
        try {
            audio = await convert(m.buffer);
        } catch (e) {
            console.warn('[Programmation] Conversion du vocal impossible, envoi tel quel:', e.message);
            mimetype = m.mime || 'audio/mp4';
        }
    }
    return {
        content: { audio, ptt: true, mimetype },
        // Un vocal en statut a besoin d'un fond coloré.
        options: { backgroundColor: status.backgroundColor },
    };
}

module.exports = { buildStatusContent, toOpus };
