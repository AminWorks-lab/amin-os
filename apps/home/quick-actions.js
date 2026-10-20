// Quick actions shared by the home screen and the floor toolbar menu. Each one goes through
// the owning app: dice fixes and saves the roll; time actions run directly, like the
// advance buttons in 场景与时间, and return an undo that sets the clock back.
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
    // Formatting and the expiry check load with the action, never at startup.
    time: () => Promise.all([import('../scene/model.js'), import('../effects/model.js')]).then(([scene, effects]) => ({
        format: scene.formatGameTime, clock: state => scene.validateState(state).clock,
        expired: (ctx, after) => effects.contextExpiryPreview(ctx, after).newlyExpired ?? [] })),
};
const sameClock = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/**
 * Runs one quick action. Returns `{ kind: 'roll', record }` for the d20 (append it with
 * appendRoll) or `{ kind: 'advanced', message, undo }` once the time change is saved;
 * `undo()` sets the clock back while nothing else has moved it and resolves to a message.
 */
export async function runQuickAction(id, { dice = services.dice, scene = services.scene, time = services.time, openApp } = {}) {
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
    if (api.preview?.()) { await openApp?.('scene'); throw Error('场景与时间有尚未确认的操作，请先确认或取消。'); }
    const tools = await time();
    api.stage(action.op, structuredClone(action.data));
    const draft = api.preview(), before = draft.details.beforeTime, after = draft.details.afterTime, periods = draft.state?.periods ?? [];
    let expired = [];
    try { expired = tools.expired(api.context?.(), after); } catch { /* The scene app lists expiry on its own page. */ }
    await api.confirm();
    const done = { before, after, reason: action.data.reason };
    const message = `已${action.data.reason}：${tools.format(before, periods)} → ${tools.format(after, periods)}`
        + (expired.length ? `；${expired.length} 个限时效果到期` : '') + '。';
    return { kind: 'advanced', message, undo: () => undoAdvance(api, tools, done, periods) };
}
async function undoAdvance(api, tools, done, periods) {
    if (api.busy?.()) throw Error('场景与时间正在保存，请稍候。');
    if (api.preview?.()) throw Error('场景与时间有尚未确认的操作，请先确认或取消。');
    if (!sameClock(tools.clock(api.read()), done.after)) throw Error('时钟在推进后又有变化，不能直接撤销；请在 场景与时间 中校正时间。');
    api.stage('set-time', { clock: structuredClone(done.before), reason: '撤销推进：' + done.reason });
    await api.confirm();
    return `已撤销，时钟回到 ${tools.format(done.before, periods)}。`;
}
/** Appends a fixed roll to the chat draft through the dice app (which records it as pending). */
export async function appendRoll(record, { dice = services.dice, input } = {}) {
    const api = await dice();
    return api.append(record.id, input ?? globalThis.document?.querySelector('#send_textarea'));
}
export const rollSummary = record => record?.text ?? (record?.results?.[0]?.total != null ? `d20 = ${record.results[0].total}` : '已掷骰');
