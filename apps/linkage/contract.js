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
