import { MODULE_LABELS, validateModules } from '../saves/adapters.js';
import { validateJSON } from '../saves/model.js';
import { buildReferenceIndex } from '../linkage/references.js';
import { sha256HexSync } from '../tts/source-hash.js';
import { validateState as normalizeCharacters } from '../characters/model.js';
import { validateState as normalizeInventory } from '../inventory/model.js';
import { validateState as normalizeRelationships } from '../relationships/model.js';
import { validateState as normalizeScene } from '../scene/model.js';
import { validateJournalSnapshot as normalizeJournal } from '../journal/model.js';
import { validateEffectsSnapshot as normalizeEffects } from '../effects/model.js';
import { validateRecord as normalizeInformationRecord } from '../information/model.js';
import { validateDocument as normalizeMap } from '../map/src/core/protocol.js';

export const KEY = 'amin_os_state_v1';
export const STATE_KEY = KEY;
export const STATE_FORMAT = 'amin-os-independent-state';
export const MAX_STATE_BYTES = 32 * 1024 * 1024;
export const MODULE_NAMES = Object.freeze(Object.keys(MODULE_LABELS));
const settingsOnly = new Set(['informationLibrary', 'linkage']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const failure = (code, message) => Object.assign(Error(message), { code });
export function canonicalJSON(value) {
    if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
    if (plain(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJSON(value[key])).join(',') + '}';
    return JSON.stringify(value);
}
export function stateHash(value) {
    validateJSON(value, MAX_STATE_BYTES);
    return 'sha256:' + sha256HexSync(canonicalJSON(value));
}
export const emptyModules = () => Object.fromEntries(MODULE_NAMES.map(name => [name, null]));

/** Validate the typed current snapshot; no event materialization or native replay. */
export function normalizeModules(input = {}) {
    validateJSON(input, MAX_STATE_BYTES);
    if (!plain(input) || Object.keys(input).some(name => !MODULE_NAMES.includes(name)))
        throw failure('AMIN_STATE_INVALID', 'Amin 状态模块格式无效或包含未知模块。');
    for (const name of settingsOnly) if (input[name] != null)
        throw failure('AMIN_STATE_SETTINGS_SEPARATE', `${MODULE_LABELS[name]}属于既有配置，不应写入独立剧情状态。`);
    const modules = validateModules({ ...emptyModules(), ...structuredClone(input) });
    const normalizers = { characters: normalizeCharacters, inventory: normalizeInventory,
        relationships: normalizeRelationships, scene: normalizeScene, journal: normalizeJournal,
        effects: normalizeEffects, map: normalizeMap };
    for (const [name, normalize] of Object.entries(normalizers)) if (modules[name] !== null) modules[name] = normalize(modules[name]);
    if (modules.information !== null) {
        const info = modules.information;
        info.records = info.records.map(normalizeInformationRecord);
        if (info.modificationHistory) info.modificationHistory = info.modificationHistory.map(event => ({ ...event,
            before: normalizeInformationRecord(event.before), snapshot: normalizeInformationRecord(event.snapshot) }));
    }
    const references = buildReferenceIndex(modules);
    if (references.unresolved.length) {
        const first = references.unresolved[0];
        throw failure('AMIN_STATE_REFERENCE_INVALID', `Amin 状态引用不存在：${first.from} → ${first.to}（${first.label ?? '引用'}）；共 ${references.unresolved.length} 处。`);
    }
    return modules;
}
export function validateState(input) {
    validateJSON(input, MAX_STATE_BYTES);
    if (!plain(input) || Object.keys(input).sort().join(',') !== 'modules,revision,updatedAt,version'
        || input.version !== 1 || !Number.isSafeInteger(input.revision) || input.revision < 0
        || typeof input.updatedAt !== 'string' || !Number.isFinite(Date.parse(input.updatedAt))
        || !plain(input.modules) || MODULE_NAMES.some(name => !Object.hasOwn(input.modules, name)))
        throw failure('AMIN_STATE_INVALID', 'Amin 当前状态格式、版本、编号或时间无效，原资料未改写。');
    return { version: 1, revision: input.revision, updatedAt: input.updatedAt, modules: normalizeModules(input.modules) };
}
export const cloneValidatedState = validateState;
export function emptyState({ updatedAt = new Date().toISOString() } = {}) {
    return validateState({ version: 1, revision: 0, updatedAt, modules: emptyModules() });
}
