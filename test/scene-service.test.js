import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneService, PROMPT_KEY } from '../apps/scene/service.js';
import { KEY, readCurrentScene } from '../apps/scene/model.js';
const clock = { year: 1925, month: 12, day: 31, hour: 23, minute: 50, calendarLabel: '' };
function setup(options = {}) {
    let count = 0, ctx = { chat: [], chatMetadata: {}, characterId: 1, getCurrentChatId: () => 'a', saveMetadata: async () => {} };
    const service = createSceneService(() => ctx, { createId: () => 'id_' + (++count), now: () => '2026-09-23T00:00:00Z', ...options });
    return { service, get ctx() { return ctx; }, set ctx(value) { ctx = value; } };
}
test('preview does not write facts and confirm commits once before asynchronous save', async () => {
    const t = setup(); let done; t.ctx.saveMetadata = () => new Promise(resolve => { done = resolve; });
    t.service.stage('set-time', { clock, reason: '故事起点' }); assert.deepEqual(t.ctx.chatMetadata, {});
    const saving = t.service.confirm(); assert.deepEqual(readCurrentScene(t.ctx).clock, clock); assert.equal(t.service.preview(), null);
    await assert.rejects(t.service.confirm(), /正在保存/); done(); await saving;
    await assert.rejects(t.service.confirm(), /没有待确认/); assert.equal(t.ctx.chatMetadata[KEY].events.length, 1); t.service.dispose();
});
test('failed save retains the committed clock and retry saves the same event without reapplying time', async () => {
    const t = setup(); t.service.stage('set-time', { clock, reason: '起始' }); await t.service.confirm();
    t.ctx.saveMetadata = async () => { throw Error('断网'); };
    t.service.stage('advance-time', { minutes: 20, reason: '调查' }); await assert.rejects(t.service.confirm(), /不会再次推进/);
    assert.equal(t.service.dirty(), true); assert.equal(readCurrentScene(t.ctx).clock.day, 1); const state = readCurrentScene(t.ctx);
    t.ctx.saveMetadata = async () => {}; await t.service.retrySave(); assert.deepEqual(readCurrentScene(t.ctx), state);
    assert.equal(t.ctx.chatMetadata[KEY].events.length, 2); assert.equal(t.service.dirty(), false); t.service.dispose();
});
test('chat switch rejects captured editor or preview without modifying either chat', async () => {
    const t = setup(), first = t.ctx, token = t.service.capture(); t.service.stage('set-time', { clock, reason: '起始' });
    t.ctx = { ...first, chatMetadata: {}, getCurrentChatId: () => 'b' };
    await assert.rejects(t.service.confirm(), /聊天或消息候选/);
    assert.throws(() => t.service.stage('set-time', { clock, reason: '旧编辑器' }, token), /聊天或消息候选/);
    assert.deepEqual(first.chatMetadata, {}); assert.deepEqual(t.ctx.chatMetadata, {}); t.service.dispose();
});
test('message candidate change invalidates pending and unpolled captures also detect the change', async () => {
    const t = setup(); t.ctx.chat = [{ name: '角色', mes: 'A', swipe_id: 0 }]; t.service.sync();
    t.service.stage('set-time', { clock, reason: 'A 路线' }); t.ctx.chat[0].swipe_id = 1;
    await assert.rejects(t.service.confirm(), /聊天或消息候选/); assert.deepEqual(t.ctx.chatMetadata, {});
    t.service.sync(); assert.equal(t.service.preview(), null); t.service.dispose();
});
test('in-flight save never writes into a newly selected chat', async () => {
    const t = setup(); let done; const first = t.ctx;
    first.saveMetadata = () => new Promise(resolve => { done = resolve; });
    t.service.stage('set-time', { clock, reason: '当前聊天' }); const saving = t.service.confirm();
    t.ctx = { ...first, chatMetadata: {}, getCurrentChatId: () => 'b' }; t.service.sync(); done();
    await assert.rejects(saving, /聊天或消息候选/); assert.deepEqual(t.ctx.chatMetadata, {}); assert.deepEqual(readCurrentScene(first).clock, clock); t.service.dispose();
});
test('stale proposal cannot overwrite external data and passive host changes never advance clock', async () => {
    const t = setup(); t.service.stage('set-time', { clock, reason: '起始' }); await t.service.confirm();
    const token = t.service.capture(); t.ctx.chatMetadata[KEY].events[0].reason = '外部编辑';
    assert.throws(() => t.service.stage('advance-time', { minutes: 20, reason: '陈旧编辑器' }, token), /资料已变化/);
    const before = structuredClone(t.ctx.chatMetadata); t.service.sync(); t.service.sync(); assert.deepEqual(t.ctx.chatMetadata, before); t.service.dispose();
});

function hostSetup() {
    const callbacks = new Map(), prompts = new Map(); let count = 0;
    const types = Object.fromEntries(['GENERATION_AFTER_COMMANDS', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED'].map(name => [name, name]));
    const ctx = { chat: [{ name: '玩家', is_user: true, mes: '出发' }], chatMetadata: {}, characterId: 0, getCurrentChatId: () => 'hook', saveMetadata: async () => {}, eventTypes: types,
        eventSource: { on(name, callback) { if (!callbacks.has(name)) callbacks.set(name, new Set()); callbacks.get(name).add(callback); }, removeListener(name, callback) { callbacks.get(name)?.delete(callback); if (!callbacks.get(name)?.size) callbacks.delete(name); } },
        setExtensionPrompt(name, prompt) { prompts.set(name, prompt); },
    };
    const service = createSceneService(() => ctx, { createId: () => 'hook_' + (++count) });
    return { ctx, service, emit: (name, ...args) => { let result; for (const callback of [...(callbacks.get(name) ?? [])]) result = callback(...args); return result; }, prompt: () => prompts.get(PROMPT_KEY), callbacks };
}
test('host prompt is off by default and normal generation receives only confirmed opted-in facts', async () => {
    const t = hostSetup(); assert.equal(t.service.supported, true);
    t.service.stage('set-time', { clock, reason: '起始' }); await t.service.confirm();
    t.emit('GENERATION_AFTER_COMMANDS', 'normal'); assert.equal(t.prompt(), '');
    t.service.stage('settings', { enabled: true, includeInContext: true, reason: '读取确认资料' }); await t.service.confirm();
    t.emit('GENERATION_AFTER_COMMANDS', 'normal'); assert.match(t.prompt(), /1925-12-31 23:50/);
    t.service.stage('advance-time', { minutes: 60, reason: '未确认的休息' });
    t.emit('GENERATION_AFTER_COMMANDS', 'normal'); assert.match(t.prompt(), /1925-12-31 23:50/); assert.doesNotMatch(t.prompt(), /1926-01-01/);
    t.service.dispose(); assert.equal(t.prompt(), ''); assert.equal(t.callbacks.size, 0);
});
test('regenerate and swipe prompt use pre-candidate facts, continue uses current facts, quiet/dry/aborted stay clear', async () => {
    const t = hostSetup();
    t.service.stage('set-time', { clock, reason: '起始' }); await t.service.confirm();
    t.service.stage('settings', { enabled: true, includeInContext: true, reason: '读取' }); await t.service.confirm();
    t.ctx.chat.push({ name: '角色', is_user: false, mes: '调查结束', swipe_id: 0 }); t.service.sync();
    t.service.stage('advance-time', { minutes: 60, reason: '调查完成' }); await t.service.confirm();
    for (const type of ['regenerate', 'swipe']) { t.emit('GENERATION_AFTER_COMMANDS', type); assert.match(t.prompt(), /1925-12-31 23:50/); assert.doesNotMatch(t.prompt(), /1926-01-01/); }
    t.emit('GENERATION_AFTER_COMMANDS', 'continue'); assert.match(t.prompt(), /1926-01-01 00:50/);
    t.emit('GENERATION_AFTER_COMMANDS', 'quiet'); assert.equal(t.prompt(), '');
    t.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, true); assert.equal(t.prompt(), '');
    t.emit('GENERATION_AFTER_COMMANDS', 'normal', { signal: { aborted: true } }); assert.equal(t.prompt(), ''); t.service.dispose();
});
test('generation completion, stop, chat/source changes clear host prompt without advancing time', async () => {
    const t = hostSetup(); t.service.stage('set-time', { clock, reason: '起始' }); await t.service.confirm();
    t.service.stage('settings', { enabled: true, includeInContext: true, reason: '读取' }); await t.service.confirm();
    const before = structuredClone(t.ctx.chatMetadata);
    for (const event of ['GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED']) {
        t.emit('GENERATION_AFTER_COMMANDS', 'normal'); assert.ok(t.prompt()); t.emit(event); assert.equal(t.prompt(), '');
    }
    assert.deepEqual(t.ctx.chatMetadata, before); t.service.dispose();
});
