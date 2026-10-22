'use strict';

/**
 * Envoie une réaction dans le broadcast WhatsApp des statuts.
 * Baileys peut identifier l'auteur par PN ou par LID selon le type d'événement;
 * une liste statusJidList invalide peut faire accepter la requête sans afficher
 * le like. On tente donc les combinaisons documentées/utilisées par le bot de
 * référence, en gardant la clé du statut originale.
 */
async function sendStatusReaction(socket, status, emoji, options = {}) {
    const msgKey = status?.key || status;
    const isOwn = options.isOwn === true;
    const logger = options.logger || console;
    const resolvePn = options.resolvePn;

    if (!msgKey?.id) throw new Error('clé de statut incomplète pour le like');
    // Retirer une réaction = renvoyer une réaction au texte vide (options.remove).
    const remove = options.remove === true;
    if (typeof emoji !== 'string' || (!remove && !emoji.trim())) throw new Error('emoji de like invalide');

    const meJid = socket?.user?.id;
    const meLid = socket?.user?.lid;
    const reactKey = isOwn
        ? { ...msgKey, remoteJid: 'status@broadcast', fromMe: true }
        : msgKey;

    const participant = [
        msgKey.participant,
        msgKey.participantPn,
        msgKey.participantLid,
        msgKey.remoteJidAlt,
        msgKey.participantAlt,
        status?.participant,
    ].find((value) => typeof value === 'string' && value.length > 0)
        || (isOwn ? meJid : null);

    let participantPn = [
        msgKey.participantPn,
        msgKey.remoteJidAlt,
        msgKey.participantAlt,
        msgKey.participant,
        msgKey.participantLid,
    ].find((value) => typeof value === 'string' && value.endsWith('@s.whatsapp.net')) || null;

    if (!participantPn && participant?.endsWith('@lid')) {
        try {
            participantPn = await socket.signalRepository?.lidMapping?.getPNForLID?.(participant);
        } catch (error) {
            logger.warn?.(`[LIKE] Résolution PN du LID impossible: ${error?.message || 'erreur'}`);
        }
    }
    if (!participantPn && participant && typeof resolvePn === 'function') {
        try {
            participantPn = resolvePn(participant) || null;
        } catch (_) {}
    }

    const candidates = [];
    const seen = new Set();
    const addCandidate = (...jids) => {
        const list = [...new Set(jids.filter((jid) => typeof jid === 'string' && jid.length > 0))];
        if (!list.length) return;
        const key = JSON.stringify(list);
        if (!seen.has(key)) {
            seen.add(key);
            candidates.push(list);
        }
    };

    if (participantPn && meJid) addCandidate(participantPn, meJid);
    if (participant && meJid && participant !== participantPn) addCandidate(participant, meJid);
    if (participantPn && meLid && meLid !== meJid) addCandidate(participantPn, meLid);
    if (participant && meLid && meLid !== meJid && participant !== participantPn) {
        addCandidate(participant, meLid);
    }
    if (!candidates.length && isOwn && meJid) addCandidate(meJid);
    if (!candidates.length) {
        throw new Error('auteur ou audience du statut introuvable pour le like');
    }

    const target = msgKey.remoteJid === 'status@broadcast' ? msgKey.remoteJid : 'status@broadcast';
    let lastError;
    for (let index = 0; index < candidates.length; index += 1) {
        try {
            await socket.sendMessage(
                target,
                { react: { text: remove ? '' : emoji.trim(), key: reactKey } },
                { statusJidList: candidates[index] },
            );
            logger.info?.(`[LIKE] ${remove ? 'Réaction retirée' : 'Réaction broadcast envoyée'} (audience ${index + 1}/${candidates.length}, id=${msgKey.id})`);
            return true;
        } catch (error) {
            lastError = error;
            logger.warn?.(`[LIKE-RETRY] Audience ${index + 1}/${candidates.length} refusée: ${error?.message || 'erreur WhatsApp'}`);
        }
    }

    const error = new Error(`WhatsApp a refusé le like après ${candidates.length} tentative(s): ${lastError?.message || 'aucune audience acceptée'}`);
    if (lastError) error.cause = lastError;
    throw error;
}

module.exports = { sendStatusReaction };
