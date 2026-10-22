#!/usr/bin/env node
// Convertit un export de cookies Instagram (JSON, ex. extension
// « Get cookies.txt LOCALLY ») vers le format Netscape/mozilla attendu par
// yt-dlp --cookies. Aucun secret n'est embarqué : le fichier généré ne doit
// jamais être committé (le poser en env Render IG_COOKIES à la place).
//
// Usage : node scripts/ig-cookies-to-netscape.js <input.json> [output.txt]
// Sans output.txt, écrit à côté de l'entrée (même nom, extension .txt).

const fs = require('fs');
const path = require('path');

const [input, output] = process.argv.slice(2);
if (!input) {
    console.error('Usage : node scripts/ig-cookies-to-netscape.js <input.json> [output.txt]');
    process.exit(2);
}

let raw;
try {
    raw = JSON.parse(fs.readFileSync(input, 'utf8'));
} catch (e) {
    console.error(`Lecture JSON impossible : ${e.message}`);
    process.exit(1);
}

const arr = Array.isArray(raw)
    ? raw
    : Array.isArray(raw && raw.cookies)
        ? raw.cookies
        : null;
if (!arr) {
    console.error('Format inattendu : tableau de cookies ou { cookies: [...] } attendu.');
    process.exit(1);
}

const lines = ['# Netscape HTTP Cookie File'];

for (const c of arr) {
    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') continue;
    const domain = String(c.domain || '').replace(/^#HttpOnly_/, '');
    if (!domain) continue;
    const includeSub = c.hostOnly ? 'FALSE' : 'TRUE';
    const cookiePath = String(c.path || '/');
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const session = c.session === true || c.expirationDate == null;
    const expiry = session ? '0' : String(Math.trunc(Number(c.expirationDate) || 0));
    const httpOnlyPrefix = c.httpOnly ? '#HttpOnly_' : '';
    lines.push(`${httpOnlyPrefix}${domain}\t${includeSub}\t${cookiePath}\t${secure}\t${expiry}\t${c.name}\t${c.value}`);
}

const body = `${lines.join('\n')}\n`;
const outPath = output || path.join(path.dirname(input), `${path.basename(input, path.extname(input))}.txt`);
fs.writeFileSync(outPath, body, 'utf8');

const issues = [];
if (!/# Netscape HTTP Cookie File/.test(body)) issues.push('en-tête Netscape manquant');
const hasSessionId = lines
    .slice(1)
    .some((l) => (l.split('\t')[5] || '').trim() === 'sessionid');
if (!hasSessionId) issues.push('cookie sessionid absent (requis pour Instagram)');
if (issues.length) {
    console.error(`Conversion effectuée mais : ${issues.join(' ; ')}`);
    process.exit(1);
}

console.log(`OK → ${outPath} (${lines.length - 1} cookies, sessionid présent)`);