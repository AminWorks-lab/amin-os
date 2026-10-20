// Quick actions shared by the home screen and the floor toolbar menu. Each one goes through
// the owning app: dice fixes and saves the roll; scene only stages a preview that the user
// confirms in 场景与时间, exactly like its own buttons.
export const QUICK_ACTIONS = Object.freeze([
    { id: 'd20', label: '掷 d20' },
    { id: 'shortRest', label: '短休' },
    { id: 'longRest', label: '长休' },
    { id: 'advance10', label: '推进 10 分钟' },
]);
const SCENE_ACTIONS = {
    shortRest: { op: 'activity', data: { activity: 'shortRest', reason: '短休' } },
    longRest: { op: 'activity', data: { activity: 'longRest', reason: '长休' } },
    advance10: { op: 'advance-time', data: { minutes: 10, reason: '推进 10 分钟' } },
};
export const services = {
    dice: () => import('../dice/service.js').then(module => module.getSharedDiceService()),
    scene: () => import('../scene/service.js').then(module => module.getSharedSceneService()),
};
/**
 * Runs one quick action. Returns `{ kind: 'roll', record }` for the d20 (append it with
 * appendRoll) or `{ kind: 'staged' }` once 场景与时间 shows the preview to confirm.
 */
export async function runQuickAction(id, { dice = services.dice, scene = services.scene, openApp } = {}) {
    if (id === 'd20') {
        const api = await dice();
        const record = await api.roll({ mode: 'generic', formula: '1d20', label: '快捷 d20' });
        return { kind: 'roll', record };
    }
    const action = SCENE_ACTIONS[id];
    if (!action) throw Error('未知的快捷动作。');
    const api = await scene();
    if (api.busy?.()) throw Error('场景与时间正在保存，请稍候。');
    if (!api.read?.()?.clock) throw Error('尚未设置故事时间，请先在 场景与时间 设置起始时间。');
    api.stage(action.op, structuredClone(action.data));
    await openApp?.('scene');
    return { kind: 'staged', message: '已生成时间推进预览，请在 场景与时间 中确认应用。' };
}
/** Appends a fixed roll to the chat draft through the dice app (which records it as pending). */
export async function appendRoll(record, { dice = services.dice, input } = {}) {
    const api = await dice();
    return api.append(record.id, input ?? globalThis.document?.querySelector('#send_textarea'));
}
export const rollSummary = record => record?.text ?? (record?.results?.[0]?.total != null ? `d20 = ${record.results[0].total}` : '已掷骰');
