import test from 'node:test';
import assert from 'node:assert/strict';
import { installRegenerateUndo, changesToUndo } from '../apps/linkage/regenerate-undo.js';

function setup({ answer = true } = {}) {
    const handlers = {}, calls = [], notices = [], asked = [];
    const ctx = { chat: [{ is_user: true, mes: 'hi' }, { is_user: false, mes: 'reply', swipe_id: 0 }], eventTypes: { GENERATION_AFTER_COMMANDS: 'gac' },
        eventSource: { on: (name, fn) => { handlers[name] = fn; }, removeListener() {} } };
    const linkage = {
        turns: () => [{ id: 't1', index: 1, swipe: 0, undoable: true, headline: ['位置 景行'] }],
        undoTarget: id => { calls.push(['target', id]); return { id: 'backup1' }; },
        markUndone: id => calls.push(['undone', id]),
    };
    const saves = { preview: () => null, stageRestore: id => calls.push(['stage', id]), confirm: async () => calls.push(['confirm']) };
    const profile = { proposalsFor: () => [{ id: 'e1', items: [{ id: 'a', status: 'accepted' }, { id: 'b', status: 'pending' }, { id: 'c', status: 'accepted' }] }], undo: async (entry, item) => calls.push(['profile', entry, item]) };
    installRegenerateUndo({ getContext: () => ctx, linkage, cardprofile: async () => profile, saves: async () => saves, confirm: text => { asked.push(text); return answer; }, notice: text => notices.push(text) });
    return { run: (type, dryRun = false) => handlers.gac(type, {}, dryRun), calls, notices, asked, ctx, linkage, profile };
}

test('regenerating asks once and undoes the linkage turn and accepted profile changes', async () => {
    const { run, calls, notices, asked } = setup();
    await run('normal'); await run('regenerate', true);
    assert.equal(asked.length, 0, 'only real regenerations ask');
    await run('regenerate');
    assert.equal(asked.length, 1);
    assert.match(asked[0], /联动更新：位置 景行/); assert.match(asked[0], /角色卡资料：2 项改动/);
    assert.deepEqual(calls, [['target', 't1'], ['stage', 'backup1'], ['confirm'], ['undone', 't1'], ['profile', 'e1', 'c'], ['profile', 'e1', 'a']]);
    assert.match(notices[0], /已撤回上一版回复的联动更新、角色卡资料 2 项/);
});

test('declining keeps everything; nothing to undo asks nothing', async () => {
    const declined = setup({ answer: false });
    await declined.run('regenerate');
    assert.equal(declined.asked.length, 1); assert.deepEqual(declined.calls, []);
    const empty = setup();
    empty.linkage.turns = () => []; empty.profile.proposalsFor = () => [];
    await empty.run('swipe');
    assert.equal(empty.asked.length, 0);
    assert.equal(changesToUndo({ chat: [{ is_user: true }] }, {}), null);
});
