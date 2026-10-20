import { isDeepStrictEqual } from 'node:util';
import { createIndependentBackups } from '../../apps/story-state/backups.js';

const clone = value => structuredClone(value);

/** In-memory stand-in for the TauriTavern extension store used by the backup ring and named saves. */
export function memoryFiles({ available = true } = {}) {
    const records = new Map(), writes = [];
    let failPut = null;
    const files = {
        records, writes,
        available: () => files.enabled,
        enabled: available,
        failNext(error) { failPut = error; },
        async get(key) { return clone(records.get(key) ?? null); },
        async put(key, value, { expected }) {
            if (failPut) { const error = failPut; failPut = null; throw error; }
            if (!isDeepStrictEqual(records.get(key) ?? null, expected)) throw Object.assign(Error('conflict'), { code: 'AMIN_BACKUP_CONFLICT' });
            records.set(key, clone(value)); writes.push(key);
        },
    };
    return files;
}

export function memoryBackups(getContext, options = {}) {
    const files = options.files ?? memoryFiles(options);
    return { files, backups: createIndependentBackups(getContext, { files, now: options.now }) };
}
