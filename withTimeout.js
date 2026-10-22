/**
 * Limite d'horloge pour un appel réseau Baileys/HTTP qui peut rester bloqué
 * indéfiniment (média, photo de profil, metadata de groupe, …).
 * Renvoie la promesse d'origine ou rejette après `ms` millisecondes.
 */
function withTimeout(promise, ms, label = 'op') {
    let timer = null;
    const guard = new Promise((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`Timeout: ${label} (${ms}ms)`)),
            ms
        );
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

module.exports = { withTimeout };