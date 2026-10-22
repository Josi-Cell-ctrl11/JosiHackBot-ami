'use strict';

/**
 * Correctif de Baileys pour le mode fantôme : avant d'envoyer l'accusé de
 * livraison d'un message entrant, la bibliothèque demande à
 * `globalThis.__josiSkipReceipt(msg)` s'il faut le taire.
 *
 * Idempotent. Lancé par `npm install` (postinstall). Si la bibliothèque a
 * changé et que la ligne visée est introuvable, il le dit sans casser
 * l'installation : le mode fantôme se déclarera alors indisponible.
 */

const fs = require('fs');
const path = require('path');

const MARK = '__josiSkipReceipt';
const TARGET = 'await sendReceipt(msg.key.remoteJid, participant, [msg.key.id], type);';
const PATCHED =
    `if (!(typeof globalThis.${MARK} === 'function' && (type === undefined || type === 'inactive') && globalThis.${MARK}(msg))) {\n` +
    `                            await sendReceipt(msg.key.remoteJid, participant, [msg.key.id], type);\n` +
    `                        }`;

function patch(file) {
    const src = fs.readFileSync(file, 'utf8');
    if (src.includes(MARK)) return 'already';
    const first = src.indexOf(TARGET);
    if (first === -1 || src.indexOf(TARGET, first + 1) !== -1) return 'not-found';
    fs.writeFileSync(file, src.replace(TARGET, PATCHED));
    return 'patched';
}

function main() {
    let file;
    try {
        const entry = require.resolve('@whiskeysockets/baileys');
        file = entry.replace(/lib[\\/]index\.js$/, 'lib/Socket/messages-recv.js');
    } catch (_) {
        file = path.join(__dirname, '..', 'node_modules', '@whiskeysockets', 'baileys', 'lib', 'Socket', 'messages-recv.js');
    }
    if (!fs.existsSync(file)) {
        console.warn('[patch-baileys] Baileys introuvable, rien à faire.');
        return;
    }
    const result = patch(file);
    console.log(`[patch-baileys] ${result}`);
    if (result === 'not-found') {
        console.warn('[patch-baileys] Ligne visée introuvable : mode fantôme indisponible.');
    }
}

if (require.main === module) main();
module.exports = { patch, TARGET, PATCHED };
