import { parseUpdate } from './protocol.js';
import { adapters } from './registry.js';
import { uuid } from '../../uuid.js';

const ALIAS = /^@new:[A-Za-z][A-Za-z0-9_-]{0,59}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Each adapter spec declares which actions define an entity (creates/upserts
// with its kind); parseUpdate has already mapped legacy action names.
const kinds = key => Object.fromEntries(adapters.map(adapter => [adapter.id,
    Object.fromEntries((adapter.spec?.actions ?? []).filter(action => action[key]).map(action => [action.name, action[key]]))]));
const createActions = kinds('creates'), upsertActions = kinds('upserts');
const aliasLike = value => typeof value === 'string' && value.startsWith('@new:');
const actionKind = (table, module, action) => Object.hasOwn(table[module] ?? {}, action) ? table[module][action] : undefined;

/** Resolve temporary model aliases before sandbox adapters run. Existing IDs
 * must be module-scoped (as emitted by buildReferenceIndex); unscoped IDs only
 * reserve values against collisions. No natural-language field is rewritten. */
export function allocateUpdateEntityIds(parsed, { createId = uuid, existingIds = [] } = {}) {
    const update = parseUpdate(parsed), known = new Set(existingIds), reserved = new Set(), definitions = new Map();
    if (typeof createId !== 'function' || [...known].some(id => typeof id !== 'string')) throw Error('实体编号分配设置无效。');
    for (const value of known) {
        reserved.add(value);
        const id = value.includes(':') ? value.slice(value.indexOf(':') + 1) : value;
        reserved.add(id); reserved.add(id.split('/').at(-1));
    }
    function declare(object, key, module, kind) {
        const alias = object?.[key];
        if (typeof alias !== 'string' || !ALIAS.test(alias)) throw Error('新实体必须使用 @new:名称 临时别名，由插件分配稳定编号。');
        if (definitions.has(alias)) throw Error(`新实体临时别名重复：${alias}`);
        definitions.set(alias, { object, key, module, kind });
    }
    for (const change of update.changes) {
        const { module, action, target, data } = change;
        const create = actionKind(createActions, module, action), upsert = actionKind(upsertActions, module, action);
        if (create || upsert && aliasLike(target)) declare(change, 'target', module, create ?? upsert);
        else if (upsert && !known.has(`${module}:${target}`)) throw Error(`新 ${module} 实体不能指定持久编号，请使用 @new:名称。`);
        if (module === 'inventory' && ['transfer-item', 'transfer-balance'].includes(action) && data.newId !== undefined) declare(data, 'newId', module, action === 'transfer-item' ? 'item' : 'balance');
        if (module === 'characters' && ['create-character', 'update-character'].includes(action) && Array.isArray(data.stats)) {
            for (const stat of data.stats) if (!known.has(`characters:${target}/stats/${stat?.id}`)) declare(stat, 'id', module, 'stat');
        }
        if (module === 'characters' && action === 'save-stat' && !known.has(`characters:${target}/stats/${data.id}`)) declare(data, 'id', module, 'stat');
        if (module === 'information' && action === 'create-panel' && Array.isArray(data.fields)) for (const field of data.fields) declare(field, 'id', module, 'field');
        if (module === 'information' && action === 'create-field') declare(data.field, 'id', module, 'field');
    }
    const mapping = {};
    for (const [alias, definition] of definitions) {
        const raw = createId();
        if (typeof raw !== 'string' || !UUID.test(raw)) throw Error('插件实体编号生成器必须返回有效 UUID。');
        const id = `e_${raw.toLowerCase()}`;
        if (reserved.has(id) || reserved.has(raw) || reserved.has(raw.toLowerCase())) throw Error('插件生成的实体编号已存在，本次更新未应用。');
        reserved.add(id); reserved.add(raw.toLowerCase()); mapping[alias] = id;
        definition.object[definition.key] = id;
    }
    function reference(value, module, kinds) {
        if (!aliasLike(value)) return value;
        if (!ALIAS.test(value) || !definitions.has(value)) throw Error(`未声明的新实体引用：${value}`);
        const definition = definitions.get(value);
        if (module && (definition.module !== module || kinds && !kinds.includes(definition.kind))) throw Error(`新实体引用类型不匹配：${value}`);
        return mapping[value];
    }
    function scalar(object, key, module, kinds) { if (object && Object.hasOwn(object, key)) object[key] = reference(object[key], module, kinds); }
    function list(object, key, module, kinds) { if (Array.isArray(object?.[key])) object[key] = object[key].map(value => reference(value, module, kinds)); }
    for (const change of update.changes) {
        const { module, data } = change;
        // Definition targets are already resolved; an update may refer to an
        // entity created earlier in this same batch without redeclaring it.
        if (Object.hasOwn(change, 'target')) change.target = reference(change.target, module);
        if (module === 'characters') scalar(data, 'statId', module, ['stat']);
        if (module === 'inventory') for (const key of ['ownerId', 'toOwnerId']) scalar(data, key, 'characters', ['person']);
        if (module === 'relationships') {
            for (const key of ['fromId', 'toId']) scalar(data, key, 'characters', ['person']);
            scalar(data, 'relationshipId', module, ['relation']);
        }
        if (module === 'scene') {
            for (const key of ['participantIds', 'characterIds']) list(data, key, 'characters', ['person']);
            scalar(data, 'characterId', 'characters', ['person']);
            scalar(data, 'mapId', 'map', ['map']); scalar(data, 'nodeId', 'map', ['node']);
        }
        if (module === 'journal') {
            for (const key of ['characterId', 'learnedFromId']) scalar(data, key, 'characters', ['person']);
            list(data, 'characterIds', 'characters', ['person']); list(data, 'locationIds', 'scene', ['scene']);
            list(data, 'itemIds', 'inventory', ['item']); scalar(data, 'factId', module, ['fact']); scalar(data, 'taskId', module, ['task']);
        }
        if (module === 'effects') {
            scalar(data, 'skillId', module, ['skill']);
            for (const operation of data.periodic?.operations ?? []) {
                scalar(operation, 'characterId', 'characters', ['person']); scalar(operation, 'statId', 'characters', ['stat']);
                scalar(operation, 'itemId', 'inventory', ['item']); scalar(operation, 'balanceId', 'inventory', ['balance']);
            }
        }
        if (module === 'map') {
            scalar(data, 'mapId', module, ['map']);
            for (const key of ['from', 'to']) scalar(data, key, module, ['node']);
        }
        if (module === 'organizations') {
            scalar(data.fields, 'parent', module, ['entity']);
            for (const key of ['relations', 'members', 'controllers']) for (const relation of data.fields?.[key] ?? []) scalar(relation, 'organization', module, ['entity']);
        }
        if (module === 'information') scalar(data, 'fieldId', module, ['field']);
    }
    return { update, mapping };
}
