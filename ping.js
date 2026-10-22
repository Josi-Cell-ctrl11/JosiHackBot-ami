/**
 * Commande Ping : Calcule la latence du bot le plus rapidement possible.
 * 
 * @param {object} sock - Le socket Baileys.
 * @param {object} msg - Le message reçu.
 */
const executePing = async (sock, msg) => {
    try {
        const start = Date.now();
        
        // Envoyer la réponse le plus vite possible
        await sock.sendMessage(msg.key.remoteJid, { 
            text: `🏓 *Pong !*\n\n📡 Latence : *${Date.now() - start}ms*`
        }, { quoted: msg });
    } catch (error) {
        console.error('[PING] Error:', error.message);
        await sock.sendMessage(msg.key.remoteJid, { 
            text: "❌ Erreur lors du ping." 
        }, { quoted: msg });
    }
};

module.exports = { executePing };
