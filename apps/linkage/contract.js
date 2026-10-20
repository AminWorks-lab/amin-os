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
