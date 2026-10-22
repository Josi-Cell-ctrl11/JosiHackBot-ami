'use strict';

/**
 * Liste des destinataires d'un statut publié par le bot (statusJidList).
 *
 * Après un redémarrage le carnet de contacts en mémoire est presque vide : se
 * limiter à lui publiait le statut pour soi seul. On y ajoute donc les
 * discussions privées connues (historique restauré) et les contacts connus
 * seulement par leur LID, convertis en numéro quand la correspondance existe.
 */
function buildStatusAudience({ self, contacts = [], chatIds = [], resolvePn = () => null } = {}) {
    const out = new Set();
    const add = (jid) => {
        if (typeof jid !== 'string') return;
        if (jid.endsWith('@s.whatsapp.net')) {
            // Un identifiant de 16 chiffres ou plus est un LID mal étiqueté.
            if (/^\d{16,}@/.test(jid)) return;
            out.add(jid.replace(/:\d+@/, '@'));
        } else if (jid.endsWith('@lid')) {
            const pn = resolvePn(jid);
            if (pn && pn.endsWith('@s.whatsapp.net')) add(pn);
        }
    };
    if (self) add(self);
    for (const c of contacts) add(c?.jid);
    for (const id of chatIds) add(id);
    return [...out];
}

module.exports = { buildStatusAudience };
