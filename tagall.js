const config = require('./config.js');
const { withTimeout } = require('./withTimeout.js');

// WhatsApp rejette les messages trop longs : on cappe la liste affichée et le
// nombre de mentions par message, en découpant en plusieurs envois si besoin.
const MAX_MENTIONS_PER_MSG = 250;
const MAX_NAMES_IN_CAPTION = 120;

function chunkArr(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

/**
 * Commande TagAll : Mentionne tous les membres d'un groupe.
 * 
 * @param {object} sock - Le socket Baileys.
 * @param {object} msg - Le message reçu.
 */
const executeTagAll = async (sock, msg) => {
    const remoteJid = msg.key.remoteJid;
    
    // Vérifier si c'est un groupe
    if (!remoteJid.endsWith('@g.us')) {
        return await sock.sendMessage(remoteJid, { text: '🚫 Cette commande fonctionne uniquement dans les groupes.' }, { quoted: msg });
    }

    try {
        const groupMeta = await withTimeout(sock.groupMetadata(remoteJid), 30_000, 'groupMetadata');
        const participants = groupMeta.participants;
        const groups = chunkArr(participants, MAX_MENTIONS_PER_MSG);

        for (const chunk of groups) {
            const mentions = chunk.map(p => p.id);
            const names = chunk.map(p => `│ 👤 @${p.id.split('@')[0]}`);
            const nameList = names.slice(0, MAX_NAMES_IN_CAPTION).join('\n');
            const remaining = names.length - MAX_NAMES_IN_CAPTION;
            const suffix = remaining > 0 ? `\n│ … +${remaining} autres` : '';

            const caption = `╭───────◇\n` +
                `│ 🤖 *JOSIHACK BOT - TAGALL* 🤖\n` +
                `╰───────◇\n\n` +
                `👥 *Groupe* : ${groupMeta.subject}\n` +
                `👥 *Membres mentionnés* : ${chunk.length}${groups.length > 1 ? ' / ' + participants.length : ''}\n\n` +
                `╭───〔 LISTE 〕───⬣\n` +
                `${nameList}${suffix}\n` +
                `╰──────────────⬣\n\n` +
                `> PRODUCED BY JOSIHACK BOT BOY`;

            try {
                await sock.sendMessage(remoteJid, { text: caption, mentions }, { quoted: msg });
            } catch (sendErr) {
                console.error('[TAGALL] send chunk failed:', sendErr.message);
            }
        }
    } catch (err) {
        console.error('[TAGALL] Error:', err);
        await sock.sendMessage(remoteJid, { text: '❌ Une erreur est survenue lors du tag.' }, { quoted: msg });
    }
};

/**
 * Tag All via API REST (sans message WhatsApp entrant).
 */
const executeTagAllApi = async (sock, groupJid) => {
    if (!groupJid.endsWith('@g.us')) {
        throw new Error('groupJid doit être un groupe (@g.us)');
    }

    const groupMeta = await withTimeout(sock.groupMetadata(groupJid), 30_000, 'groupMetadata');
    const participants = groupMeta.participants;
    const mentions = participants.map(p => p.id);

    const caption = `╭───────◇\n│ 🤖 *JOSIHACK BOT - TAGALL* 🤖\n╰───────◇\n\n` +
        `👥 *Groupe* : ${groupMeta.subject}\n` +
        `👨‍👩‍👧‍👦 *Membres* : ${participants.length}\n\n` +
        `> PRODUCED BY JOSIHACK BOT BOY`;

    await sock.sendMessage(groupJid, { text: caption, mentions });

    return {
        success: true,
        groupName: groupMeta.subject,
        memberCount: participants.length,
    };
};

module.exports = { executeTagAll, executeTagAllApi };
