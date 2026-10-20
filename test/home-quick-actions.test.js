import test from 'node:test';
import assert from 'node:assert/strict';
import { runQuickAction, appendRoll, rollSummary, QUICK_ACTIONS } from '../apps/home/quick-actions.js';

function fakes({ clock = { year: 1, month: 1, day: 1, hour: 8, minute: 0 }, busy = false } = {}) {
    const calls = [];
    const dice = { async roll(input) { calls.push(['roll', input]); return { id: 'r1', text: '快捷 d20：1d20 = 17', results: [{ total: 17 }] }; },
        async append(id, input) { calls.push(['append', id, input]); return { input }; } };
    const scene = { busy: () => busy, read: () => ({ clock }), stage(op, data) { calls.push(['stage', op, data]); } };
    const openApp = async id => { calls.push(['open', id]); };
    return { calls, deps: { dice: async () => dice, scene: async () => scene, openApp } };
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

test('rests and advancing time stage the scene preview and open 场景与时间 to confirm', async () => {
    const { calls, deps } = fakes();
    for (const id of ['shortRest', 'longRest', 'advance10']) await runQuickAction(id, deps);
    assert.deepEqual(calls, [
        ['stage', 'activity', { activity: 'shortRest', reason: '短休' }], ['open', 'scene'],
        ['stage', 'activity', { activity: 'longRest', reason: '长休' }], ['open', 'scene'],
        ['stage', 'advance-time', { minutes: 10, reason: '推进 10 分钟' }], ['open', 'scene'],
    ]);
    assert.ok(!calls.some(([name]) => name === 'confirm'), 'nothing is confirmed or saved without the user');
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
