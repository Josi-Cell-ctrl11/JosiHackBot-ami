const { BufferJSON, initAuthCreds, proto } = require('@whiskeysockets/baileys');

/** Préfixes des rangées que ce auth state écrit dans le tableau (session bot). */
const AUTH_KEY_PREFIXES = [
    'creds',
    'app-state-sync-key',
    'session',
    'pre-key',
    'sender-key',
];
const KEY_BATCH_SIZE = 100;

/**
 * Efface UNIQUEMENT les rangées de session Baileys, sans parcourir toute la
 * table (qui contient aussi l'historique et les réglages de l'application).
 */
async function wipeAuthTable(supabase, tableName = 'whatsapp_auth') {
    try {
        for (const prefix of AUTH_KEY_PREFIXES) {
            const query = supabase.from(tableName).delete();
            const { error } = prefix === 'creds'
                ? await query.eq('id', 'creds')
                : await query.like('id', `${prefix}%`);
            if (error) throw error;
        }
        console.log(`[Supabase Auth] Session effacée (${tableName})`);
    } catch (e) {
        console.error('[Supabase Auth] Erreur wipe:', e.message);
        throw e;
    }
}

/**
 * Auth state Supabase compatible Baileys v7.
 * Les clés sont lues et écrites en lots : les appels REST individuels en masse
 * provoquaient des échecs fetch et la fermeture 408 du socket WhatsApp.
 */
module.exports = async (supabase, tableName = 'whatsapp_auth') => {
    const writeData = async (data, id) => {
        try {
            const jsonStr = JSON.stringify(data, BufferJSON.replacer);
            const parsedData = JSON.parse(jsonStr);
            const { error } = await supabase
                .from(tableName)
                .upsert({ id, data: parsedData }, { onConflict: 'id' });
            if (error) console.error('[Supabase Auth] Erreur sauvegarde', id, error.message);
        } catch (e) {
            console.error('[Supabase Auth] Except write:', e.message);
        }
    };

    const readData = async (id) => {
        try {
            const { data, error } = await supabase
                .from(tableName)
                .select('data')
                .eq('id', id)
                .maybeSingle();
            if (error || !data) return null;
            return JSON.parse(JSON.stringify(data.data), BufferJSON.reviver);
        } catch (e) {
            return null;
        }
    };

    let creds = await readData('creds');
    if (!creds) {
        creds = initAuthCreds();
        await writeData(creds, 'creds');
    }

    // Baileys v7 : s'assurer que les champs LID sont présents.
    if (!creds.lid) creds.lid = null;
    if (!creds.lidDeviceID) creds.lidDeviceID = null;

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const result = Object.fromEntries(ids.map((id) => [id, null]));
                    const dbIds = ids.map((id) => `${type}-${id}`);

                    for (let i = 0; i < dbIds.length; i += KEY_BATCH_SIZE) {
                        const chunk = dbIds.slice(i, i + KEY_BATCH_SIZE);
                        try {
                            const { data, error } = await supabase
                                .from(tableName)
                                .select('id,data')
                                .in('id', chunk);
                            if (error) throw error;
                            for (const row of data || []) {
                                const id = row.id.slice(type.length + 1);
                                let value = JSON.parse(
                                    JSON.stringify(row.data),
                                    BufferJSON.reviver,
                                );
                                if (type === 'app-state-sync-key' && value) {
                                    value = proto.Message.AppStateSyncKeyData.fromObject(value);
                                }
                                result[id] = value;
                            }
                        } catch (e) {
                            console.error('[Supabase Auth] Erreur lecture lot', type, e.message);
                        }
                    }
                    return result;
                },
                set: async (data) => {
                    const upserts = [];
                    const deletes = [];

                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                try {
                                    const serialized = JSON.stringify(value, BufferJSON.replacer);
                                    upserts.push({ id: key, data: JSON.parse(serialized) });
                                } catch (e) {
                                    console.error('[Supabase Auth] Except serialize', key, e.message);
                                }
                            } else {
                                deletes.push(key);
                            }
                        }
                    }

                    for (let i = 0; i < upserts.length; i += KEY_BATCH_SIZE) {
                        const chunk = upserts.slice(i, i + KEY_BATCH_SIZE);
                        try {
                            const { error } = await supabase
                                .from(tableName)
                                .upsert(chunk, { onConflict: 'id' });
                            if (error) throw error;
                        } catch (e) {
                            console.error('[Supabase Auth] Erreur sauvegarde lot', e.message);
                        }
                    }

                    for (let i = 0; i < deletes.length; i += KEY_BATCH_SIZE) {
                        const chunk = deletes.slice(i, i + KEY_BATCH_SIZE);
                        try {
                            const { error } = await supabase
                                .from(tableName)
                                .delete()
                                .in('id', chunk);
                            if (error) throw error;
                        } catch (e) {
                            console.error('[Supabase Auth] Erreur suppression lot', e.message);
                        }
                    }
                },
            },
        },
        saveCreds: () => writeData(creds, 'creds'),
    };
};

module.exports.wipeAuthTable = wipeAuthTable;
