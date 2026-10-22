/**
 * Cache contacts & groupes — alimenté par les événements Baileys
 */
const contactsCache = new Map(); // jid -> { jid, name, type, updatedAt }
// LID <-> PN : les contacts WhatsApp peuvent être identifiés par leur LID
// (opaque, compte récent) ou par leur numéro de téléphone (PN). WhatsApp nous
// donne les deux dans `contacts.upsert` : on mémorise la correspondance pour
// filtrer la liste blanche/noire même quand un statut n'arrive qu'en LID.
const lidToPn = new Map(); // normalized lid -> normalized pn
const pnToLid = new Map(); // normalized pn -> normalized lid

function normLid(id) {
    if (!id) return null;
    const clean = id.split(':')[0].split('@')[0].replace(/\D/g, '');
    return clean ? `${clean}@lid` : null;
}

function normPn(id) {
    if (!id) return null;
    const clean = id.split(':')[0].split('@')[0].replace(/\D/g, '');
    return clean ? `${clean}@s.whatsapp.net` : null;
}

function normalizeJid(jid) {
    if (!jid) return null;
    return jid.includes('@') ? jid : `${jid.replace(/\D/g, '')}@s.whatsapp.net`;
}

function recordLidPn(lid, pn) {
    const l = normLid(lid);
    const p = normPn(pn);
    if (l && p) {
        lidToPn.set(l, p);
        if (!pnToLid.has(p)) pnToLid.set(p, l);
    }
}

/** Résout le PN (numéro, @s.whatsapp.net) d'un JID quelconque (LID compris). */
function resolvePn(jid) {
    if (!jid) return null;
    const bare = jid.split(':')[0].split('@')[0];
    if (!bare) return null;
    if (jid.includes('@lid')) {
        const mapped = lidToPn.get(`${bare}@lid`);
        return mapped || null;
    }
    // Un groupe, une diffusion ou une chaîne n'a pas de numéro : sans ce
    // garde-fou, l'identifiant du groupe devenait un faux « numéro » et chaque
    // groupe avait un jumeau fantôme dans Discussions, nommé d'après le dernier
    // expéditeur (et les envois vers ce jumeau échouaient).
    const server = jid.includes('@') ? jid.split('@')[1] : 's.whatsapp.net';
    if (server !== 's.whatsapp.net') return null;
    return `${bare}@s.whatsapp.net`;
}

/**
 * Faux fil laissé par l'ancien défaut : un identifiant de groupe (16 chiffres
 * ou plus, un vrai numéro n'en a jamais plus de 15) collé à @s.whatsapp.net.
 */
function isBogusPnChat(jid) {
    return /^\d{16,}@s\.whatsapp\.net$/.test(String(jid || ''));
}

const BOGUS_NAMES = new Set(['unknown', 'unbekannt', 'null', 'undefined']);

/** true si le pushName est exploitable (pas un placeholder Baileys). */
function isRealName(n) {
    return !!n && typeof n === 'string' && n.trim() !== '' &&
        !BOGUS_NAMES.has(n.trim().toLowerCase());
}

function upsertContact(jid, name, type = 'contact') {
    const id = normalizeJid(jid);
    if (!id || id === 'status@broadcast') return;
    if (id.endsWith('@g.us')) type = 'group';
    const existing = contactsCache.get(id);
    const resolved = isRealName(name) ? name : (existing?.name || formatPhone(id));
    contactsCache.set(id, {
        jid: id,
        name: resolved,
        type,
        updatedAt: Date.now(),
    });
}

function formatPhone(jid) {
    const num = jid.split('@')[0].split(':')[0];
    return num.startsWith('+') ? num : `+${num}`;
}

function trackFromMessage(msg) {
    const jid = msg?.key?.remoteJid;
    if (!jid) return;
    const pushName = msg.pushName || msg.key?.participant;
    if (jid.endsWith('@g.us')) {
        upsertContact(jid, null, 'group');
    } else if (jid.endsWith('@s.whatsapp.net')) {
        upsertContact(jid, pushName, 'contact');
    } else if (jid.endsWith('@lid')) {
        // Contacts récents : identifiés par LID opaque. On trace aussi leur
        // pushName pour que le nom exact s'affiche malgré l'absence de PN.
        const pn = resolvePn(jid);
        if (pn) {
            upsertContact(jid, pushName, 'contact');
            recordLidPn(jid, pn);
        } else if (isRealName(pushName)) {
            upsertContact(jid, pushName, 'contact');
        }
    }
}

function handleContactsUpsert(contacts) {
    for (const c of contacts) {
        upsertContact(c.id, c.notify || c.name || c.verifiedName, 'contact');
        if (c.lid) recordLidPn(c.lid, c.pn || c.id);
    }
}

function handleContactsUpdate(contacts) {
    handleContactsUpsert(contacts);
}

function handleGroupsParticipating(groups) {
    for (const [jid, meta] of Object.entries(groups)) {
        upsertContact(jid, meta.subject || meta.name, 'group');
    }
}

function getContacts() {
    return [...contactsCache.values()]
        .filter(c => c.type === 'contact')
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

function getGroups() {
    return [...contactsCache.values()]
        .filter(c => c.type === 'group')
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

function getAll() {
    return [...contactsCache.values()].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'group' ? -1 : 1;
        return (a.name || '').localeCompare(b.name || '');
    });
}

/** Cherche un contact par JID, en suivant aussi la correspondance LID ↔ PN. */
function getContactByJid(jid) {
    const id = normalizeJid(jid);
    if (!id) return null;
    if (contactsCache.has(id)) return contactsCache.get(id);
    const pn = resolvePn(id);
    if (pn && contactsCache.has(pn)) return contactsCache.get(pn);
    if (pn) {
        const lid = pnToLid.get(pn);
        if (lid && contactsCache.has(lid)) return contactsCache.get(lid);
    }
    // Si on a un PN, tenter le LID miroir même sans mapping préalable
    if (id.endsWith('@s.whatsapp.net')) {
        const lid = pnToLid.get(id);
        if (lid && contactsCache.has(lid)) return contactsCache.get(lid);
    }
    return null;
}

/** Nom affichable fiable, ou null si inconnu. */
function getDisplayName(jid, fallback = null) {
    const c = getContactByJid(jid);
    if (c && isRealName(c.name)) return c.name;
    return isRealName(fallback) ? fallback : null;
}

/** JIDs candidats pour une requête WhatsApp (photo, présence…). */
function jidCandidates(jid) {
    const id = normalizeJid(jid);
    if (!id) return [];
    const out = [id];
    const pn = resolvePn(id);
    if (pn && !out.includes(pn)) out.push(pn);
    if (pn) {
        const lid = pnToLid.get(pn);
        if (lid && !out.includes(lid)) out.push(lid);
    }
    return out;
}

async function fetchGroupsFromSocket(socket) {
    if (!socket) return [];
    try {
        const groups = await socket.groupFetchAllParticipating();
        handleGroupsParticipating(groups);
        return getGroups();
    } catch (err) {
        console.error('[Contacts] Erreur fetch groupes:', err.message);
        return getGroups();
    }
}

module.exports = {
    upsertContact,
    trackFromMessage,
    handleContactsUpsert,
    handleContactsUpdate,
    handleGroupsParticipating,
    resolvePn,
    isBogusPnChat,
    recordLidPn,
    getContactByJid,
    getDisplayName,
    jidCandidates,
    getContacts,
    getGroups,
    getAll,
    normalizeJid,
    isRealName,
    fetchGroupsFromSocket,
    normPn,
    normLid,
};
