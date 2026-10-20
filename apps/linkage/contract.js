// Compact signature-style module contracts: one line per action. Shared
// conventions (ID references, @new aliases, notation, forbidden fields) live
// once in the protocol header built by prompt.js, not in every module.
// Advanced actions and details stay valid for validation and apply; they are
// only omitted from the per-turn prompt unless the user enables them.
function line(action, advanced) {
    const args = (action.args ?? '') + (advanced ? action.advancedArgs ?? '' : '');
    return `${action.name}(${args})${action.note ? ' ' + action.note : ''}${advanced && action.more ? '；' + action.more : ''}`;
}

export function renderContract(spec, { advanced = true, sources = true } = {}) {
    const actions = (spec?.actions ?? []).filter(action => advanced || !action.advanced);
    return [spec?.notes, advanced ? spec?.advancedNotes : '', ...actions.map(action => line(action, advanced)), sources ? spec?.sources : '']
        .filter(Boolean).join('\n');
}

export const actionNames = (spec, { advanced } = {}) => (spec?.actions ?? [])
    .filter(action => advanced === undefined || Boolean(action.advanced) === advanced).map(action => action.name);

// Action metadata lives on each spec action: `creates`/`upserts` name the
// entity kind it defines (a create target is always an @new alias; an upsert
// target may be one), and `aliases` lists legacy names that older chats and
// model habits still emit. Rules show only `name`; parsing maps aliases to it.
export function canonicalAction(spec, action) {
    for (const entry of spec?.actions ?? []) if (entry.name === action || entry.aliases?.includes(action)) return entry.name;
    return action;
}
export const actionSpec = (spec, action) => (spec?.actions ?? []).find(entry => entry.name === canonicalAction(spec, action));
/** Direct callers (settlements, previews) may still pass a legacy name. */
export function canonicalChange(spec, change) {
    const action = canonicalAction(spec, change?.action);
    return action === change?.action ? change : { ...change, action };
}

/**
 * JSON Schema for an amin_update payload limited to the given modules and
 * actions, for providers that accept response_format json_schema. Each change
 * is one branch per module with its allowed action names; data stays an open
 * object because argument shapes are documented in the contract text and
 * checked by the adapters, not here. `actions` defaults to every spec action.
 */
export function updateSchema(name, modules, { maxItems = 64 } = {}) {
    const branches = modules.map(({ id, spec, actions = actionNames(spec) }) => {
        const unknown = actions.filter(action => canonicalAction(spec, action) !== action || !actionSpec(spec, action));
        if (unknown.length) throw Error(`${id} 的结构化输出包含未知操作：${unknown.join(', ')}`);
        return {
            type: 'object', additionalProperties: false, required: ['module', 'action', 'data', 'reason'],
            properties: { module: { type: 'string', enum: [id] }, action: { type: 'string', enum: [...actions] }, target: { type: 'string' }, data: { type: 'object' }, reason: { type: 'string' } },
        };
    });
    if (!branches.length) throw Error('结构化输出至少需要一个模块。');
    return {
        name,
        schema: {
            type: 'object', additionalProperties: false, required: ['version', 'changes'],
            properties: { version: { type: 'integer', enum: [1] }, changes: { type: 'array', maxItems, items: branches.length === 1 ? branches[0] : { anyOf: branches } } },
        },
    };
}
