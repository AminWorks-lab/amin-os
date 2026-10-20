import test from 'node:test';
import assert from 'node:assert/strict';
import { runQuickAction, appendRoll, rollSummary, QUICK_ACTIONS } from '../apps/home/quick-actions.js';

function fakes({ clock = { year: 1, month: 1, day: 1, hour: 8, minute: 0 }, busy = false } = {}) {
    const calls = [];
    const dice = { async roll(input) { calls.push(['roll', input]); return { id: 'r1', text: '快捷 d20：1d20 = 17', results: [{ total: 17 }] }; },
        async append(id, input) { calls.push(['append', id, input]); return { input }; } };
    let pending = null;
    const minutes = (op, data) => op === 'set-time' ? 0 : op === 'advance-time' ? data.minutes : { shortRest: 60, longRest: 480 }[data.activity];
    const later = (value, add) => { const total = value.hour * 60 + value.minute + add; return { ...value, hour: Math.floor(total / 60) % 24, minute: total % 60 }; };
    const scene = { busy: () => busy, read: () => ({ clock }), context: () => ({}), preview: () => pending && structuredClone(pending),
        stage(op, data) { calls.push(['stage', op, data]); pending = { details: { beforeTime: clock, afterTime: op === 'set-time' ? data.clock : later(clock, minutes(op, data)) }, state: { periods: [] } }; },
        async confirm() { calls.push(['confirm']); clock = pending.details.afterTime; pending = null; },
        move(next) { clock = next; } };
    const time = async () => ({ format: value => `${value.hour}:${String(value.minute).padStart(2, '0')}`, clock: state => state.clock,
        expired: (_ctx, after) => after.hour >= 16 ? [{ name: '照明术' }] : [] });
    const openApp = async id => { calls.push(['open', id]); };
    return { calls, scene, deps: { dice: async () => dice, scene: async () => scene, time, openApp } };
}

test('the d20 is fixed and saved by the dice app, then appended on request', async () => {
    const { calls, deps } = fakes();
    const result = await runQuickAction('d20', deps);
    assert.equal(result.kind, 'roll');
    assert.deepEqual(calls.splice(0), [['roll', { mode: 'generic', formula: '1d20', label: '快捷 d20' }]]);
    assert.equal(rollSummary(result.record), '快捷 d20：1d20 = 17');
    const input = { value: '' };
    await appendRoll(result.record, { dice: deps.dice, input });
    assert.deepEqual(calls, [['append', 'r1', input]], 'appending goes through the dice app, which records it as pending');
});

test('rests and advancing time run directly and offer an undo that sets the clock back', async () => {
    const { calls, scene, deps } = fakes();
    const results = [];
    for (const id of ['shortRest', 'longRest', 'advance10']) results.push(await runQuickAction(id, deps));
    assert.deepEqual(calls.splice(0), [
        ['stage', 'activity', { activity: 'shortRest', reason: '短休' }], ['confirm'],
        ['stage', 'activity', { activity: 'longRest', reason: '长休' }], ['confirm'],
        ['stage', 'advance-time', { minutes: 10, reason: '推进 10 分钟' }], ['confirm'],
    ], 'no preview is left for 场景与时间 and the app is not opened');
    assert.deepEqual(results.map(result => result.kind), ['advanced', 'advanced', 'advanced']);
    assert.equal(results[0].message, '已短休：8:00 → 9:00。');
    assert.equal(results[1].message, '已长休：9:00 → 17:00；1 个限时效果到期。');
    await assert.rejects(results[1].undo(), /又有变化/, 'an older advance cannot be undone after a later one');
    assert.deepEqual(calls, []);
    assert.equal(await results[2].undo(), '已撤销，时钟回到 17:00。');
    assert.deepEqual(calls.splice(0), [['stage', 'set-time', { clock: { year: 1, month: 1, day: 1, hour: 17, minute: 0 }, reason: '撤销推进：推进 10 分钟' }], ['confirm']]);
    assert.deepEqual(scene.read().clock, { year: 1, month: 1, day: 1, hour: 17, minute: 0 });
});

test('time actions refuse without a clock or while the scene is saving', async () => {
    let { calls, deps } = fakes({ clock: null });
    await assert.rejects(runQuickAction('shortRest', deps), /起始时间/);
    assert.deepEqual(calls, []);
    ({ calls, deps } = fakes({ busy: true }));
    await assert.rejects(runQuickAction('advance10', deps), /正在保存/);
    assert.deepEqual(calls, []);
    await assert.rejects(runQuickAction('unknown', deps), /未知/);
    assert.deepEqual(QUICK_ACTIONS.map(action => action.id), ['d20', 'shortRest', 'longRest', 'advance10']);
});
