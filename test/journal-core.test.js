import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY, FORMAT, empty, readStore, sourceFromRange, sourceState, validateRecord, currentEntries, inspectEntries, filterEntries, change, compile, exportRecords, parseImport } from '../apps/journal/model.js';
import { createJournal, PROMPT_KEY } from '../apps/journal/service.js';
import { draftChronicle } from '../apps/journal/draft.js';

const message = (mes, is_user = false, name = is_user ? '玩家' : '主持人') => ({ mes, is_user, name, swipe_id: 0 });
const conversation = () => [message('进入旧城。', true), message('守门人交给你一封未拆的信。'), message('我把信收好，沿路去旅馆。', true)];
const record = (chat, overrides = {}) => ({ id: 'hook-1', kind: 'hook', title: '未拆的信', body: '确认信件的来历。', actors: ['守门人'], sources: sourceFromRange(chat, 0, Math.min(1, chat.length - 1)), ...overrides });
const deferred = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };

function host({ ai, chat = conversation() } = {}) {
    const handlers = new Map(), prompts = [];
    const eventNames = ['GENERATION_AFTER_COMMANDS', 'CHAT_CHANGED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED'];
    let saves = 0;
    const ctx = {
        chatId: 'chat-a', groupId: null, characterId: 1, chat, chatMetadata: {},
        getCurrentChatId() { return this.chatId; },
        saveMetadata: async () => { saves++; },
        setExtensionPrompt: (...args) => prompts.push(args),
        eventTypes: Object.fromEntries(eventNames.map(name => [name, name])),
        // Real hosts keep several listeners per event; the shared prompt injector adds its own.
        eventSource: { on(name, callback) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(callback); }, removeListener(name, callback) { handlers.get(name)?.delete(callback); if (!handlers.get(name)?.size) handlers.delete(name); } },
    };
    const api = createJournal(() => ctx, { ai: () => ai });
    return { api, ctx, prompts, handlers, saves: () => saves, emit: (name, ...args) => { let result; for (const callback of [...(handlers.get(name) ?? [])]) result = callback(...args); return result; } };
}

const saveRecord = (h, value, op = 'create', token = h.api.capture()) => h.api.save(token, (store, ctx) => change(store, ctx.chat, op, value, token.operationId));

test('selected sources retain exact loaded text and reject invalid or empty ranges', () => {
    const chat = conversation(); chat[1].mes = '  原句\n保留换行与空格。  ';
    const sources = sourceFromRange(chat, 1, 2);
    assert.equal(sources.start, 1); assert.equal(sources.end, 2);
    assert.deepEqual(sources.messages.map(item => [item.index, item.text]), [[1, chat[1].mes], [2, chat[2].mes]]);
    chat[1].mes = '新正文'; assert.equal(sources.messages[0].text, '  原句\n保留换行与空格。  ');
    for (const [start, end] of [[-1, 1], [2, 1], [0, 3], [0.5, 1]]) assert.throws(() => sourceFromRange(chat, start, end), /来源范围/);
    assert.throws(() => sourceFromRange([message(' \n ')], 0, 0), /正文为空/);
    assert.throws(() => sourceFromRange([{ mes: null }], 0, 0), /没有可读取的正文/);
});

test('AI drafting captures the route, exact selected range and immutable context without saving', async () => {
    const pending = deferred(), calls = [], captures = [];
    let selected = { channel: 'tavern-current', preset: '当前酒馆预设' };
    const ai = { capture: app => { captures.push(app); return structuredClone(selected); }, generate: (...args) => { calls.push(args); return pending.promise; } };
    const h = host({ ai }), token = h.api.capture(), before = structuredClone(h.ctx.chatMetadata);
    const fields = { start: 1, end: 2, title: '旅馆之前', current: '用户已有草稿', instruction: '保留不确定性', gameTimeText: '秋季第三日' };
    const result = h.api.generateDraft(token, fields);
    selected.preset = '后来选的预设'; fields.title = '后来改的标题';
    assert.deepEqual(captures, ['journal']); assert.equal(calls.length, 1);
    const [task, frozenContext, request, options] = calls[0], parsed = JSON.parse(request.prompt);
    assert.equal(task, '剧情档案 · 编年史'); assert.equal(parsed.来源范围, '2–3'); assert.equal(parsed.标题, '旅馆之前');
    assert.deepEqual(parsed.所选楼层原文.map(item => [item.楼层, item.正文]), [[2, h.ctx.chat[1].mes], [3, h.ctx.chat[2].mes]]);
    assert.equal(parsed.现有草稿, '用户已有草稿'); assert.equal(parsed.补充要求, '保留不确定性');
    assert.deepEqual(options.snapshot, { channel: 'tavern-current', preset: '当前酒馆预设' });
    assert.equal(options.includeEffects, false); assert.equal(options.includeJournal, false); assert.equal(options.includeScene, false);
    assert.equal(options.data.request, request.prompt);
    assert.notEqual(frozenContext.chat, h.ctx.chat); assert.notEqual(frozenContext.chatMetadata, h.ctx.chatMetadata);
    assert.deepEqual(frozenContext.chat, h.ctx.chat); assert.deepEqual(h.ctx.chatMetadata, before);
    pending.resolve('  编年史草稿  '); assert.equal(await result, '编年史草稿');
    assert.equal(h.saves(), 0); assert.deepEqual(h.ctx.chatMetadata, before); assert.equal(h.prompts.length, 0);
    await saveRecord(h, record(h.ctx.chat, { kind: 'chronicle', body: '编年史草稿' }));
    assert.equal(h.saves(), 1); assert.equal(h.api.read().events.length, 1); assert.equal(compile(h.api.read(), h.ctx.chat), '');
    h.api.dispose();
});

test('late AI drafts are rejected after chat switch, cancellation, form edits, source edits or baseline edits', async t => {
    for (const cause of ['chat', 'cancel', 'form', 'source', 'baseline', 'dispose']) await t.test(cause, async () => {
        const pending = deferred(), controller = new AbortController(); let aiSignal, edited = false;
        const ai = { capture: () => ({}), generate: (_task, _ctx, _request, options) => { aiSignal = options.signal; return pending.promise; } };
        const h = host({ ai }), token = h.api.capture();
        const draft = h.api.generateDraft(token, { start: 0, end: 1 }, { signal: controller.signal, check: () => { if (edited) throw Error('表单已修改'); } });
        const rejected = assert.rejects(draft, /聊天已切换|取消|表单已修改|楼层或回复内容|其他窗口修改/);
        if (cause === 'chat') { h.ctx.chatId = 'chat-b'; h.ctx.chatMetadata = {}; h.emit('CHAT_CHANGED'); }
        if (cause === 'cancel') controller.abort();
        if (cause === 'form') edited = true;
        if (cause === 'source') h.ctx.chat[1].mes = '用户编辑后的正文';
        if (cause === 'baseline') h.ctx.chatMetadata[KEY] = { ...empty(), limit: 10000 };
        if (cause === 'dispose') h.api.dispose();
        if (['chat', 'cancel', 'dispose'].includes(cause)) assert.equal(aiSignal.aborted, true);
        pending.resolve('已过期的 AI 结果'); await rejected;
        assert.equal(h.saves(), 0); assert.equal(h.api.read().events.length, 0); h.api.dispose();
    });
});

test('drafting rejects empty, oversized and pre-cancelled responses without persistence', async () => {
    const ctx = { chat: conversation(), chatMetadata: {} }, sources = sourceFromRange(ctx.chat, 0, 1);
    const ai = { capture: () => ({}), generate: async () => '   ' };
    await assert.rejects(draftChronicle({ ai, ctx, sources }), /空内容/);
    ai.generate = async () => '字'.repeat(60001);
    await assert.rejects(draftChronicle({ ai, ctx, sources }), /超过 6 万/);
    let calls = 0; ai.generate = async () => { calls++; return '正文'; };
    const controller = new AbortController(); controller.abort();
    await assert.rejects(draftChronicle({ ai, ctx, sources, signal: controller.signal }), /取消/);
    await assert.rejects(draftChronicle({ ai, ctx, sources, current: '字'.repeat(100001) }), /超过 10 万/);
    assert.equal(calls, 0); assert.deepEqual(ctx.chatMetadata, {});
});

test('branch prefixes recover earlier content and reference state without inheriting future edits', () => {
    const early = conversation().slice(0, 2), later = [...early, message('继续往旅馆走。', true)], branch = [...early, message('我转身返回城门。', true)];
    let store = change(empty(), early, 'create', record(early), 'create');
    store = change(store, later, 'update', record(later, { body: '另一条线索表明信来自公爵。' }), 'edit-later');
    store = change(store, later, 'reference', { id: 'hook-1', enabled: true }, 'enable-later');
    assert.equal(currentEntries(store, early)[0].body, '确认信件的来历。'); assert.equal(currentEntries(store, early)[0].enabled, false);
    assert.equal(currentEntries(store, branch)[0].body, '确认信件的来历。'); assert.equal(compile(store, branch), '');
    assert.match(compile(store, later), /信来自公爵/);
    const branchOnly = record(branch, { id: 'branch-hook', title: '城门的叫声', sources: sourceFromRange(branch, 2, 2) });
    store = change(store, branch, 'create', branchOnly, 'branch-create');
    assert.deepEqual(currentEntries(store, later).map(item => item.id), ['hook-1']);
    const inspected = inspectEntries(store, later).find(item => item.id === 'branch-hook');
    assert.equal(inspected.current, false); assert.equal(inspected.stale, true);
});

test('source edits, deletion and alternate swipes exclude old evidence and mark it stale for inspection', async t => {
    for (const alteration of ['edit', 'delete', 'swipe']) await t.test(alteration, () => {
        const chat = conversation(); const store = change(empty(), chat, 'create', record(chat, { enabled: true, remindAfter: 1 }), 'create');
        assert.match(compile(store, chat), /未拆的信/);
        if (alteration === 'edit') chat[1].mes = '换成另一封信。';
        if (alteration === 'delete') chat.splice(1, 1);
        if (alteration === 'swipe') chat[1].swipe_id = 1;
        assert.equal(sourceState(store.events[0].record.sources, chat).valid, false);
        assert.equal(compile(store, chat), ''); assert.deepEqual(currentEntries(store, chat), []);
        const [inspected] = inspectEntries(store, chat);
        assert.equal(inspected.stale, true); assert.equal(inspected.current, false); assert.equal(inspected.due, false); assert.ok(inspected.staleReason);
    });
});

test('reference defaults off; only an explicit saved toggle contributes bounded factual references', () => {
    const chat = conversation(); let store = change(empty(), chat, 'create', record(chat), 'create');
    assert.equal(currentEntries(store, chat)[0].enabled, false); assert.equal(compile(store, chat), '');
    store = change(store, chat, 'reference', { id: 'hook-1', enabled: true }, 'enable');
    assert.match(compile(store, chat), /已确认并启用引用/); assert.match(compile(store, chat), /未拆的信/);
    assert.throws(() => compile({ ...store, limit: 20 }, chat), /超过 20 上限/);
    store = change(store, chat, 'reference', { id: 'hook-1', enabled: false }, 'disable'); assert.equal(compile(store, chat), '');
    assert.throws(() => change(store, chat, 'reference', { id: 'hook-1', enabled: 'yes' }), /引用开关无效/);
    assert.throws(() => validateRecord(record(chat, { sources: null, enabled: true }), chat), /绑定当前聊天/);
});

test('hook reminders and filters honor source age, status, actors and branch scope', () => {
    const chat = conversation().slice(0, 2); let store = change(empty(), chat, 'create', record(chat, { remindAfter: 2 }), 'open');
    store = change(store, chat, 'create', record(chat, { id: 'resolved', title: '已知来历', status: 'resolved', remindAfter: 1 }), 'resolved');
    store = change(store, chat, 'create', record(chat, { id: 'chronicle', kind: 'chronicle', title: '入城记录', body: '抵达城门。', actors: [] }), 'chronicle');
    assert.equal(inspectEntries(store, [...chat, message('第一轮')])[0].due, false);
    const progressed = [...chat, message('第一轮'), message('第二轮')], entries = inspectEntries(store, progressed);
    assert.deepEqual(filterEntries(entries, { dueOnly: true }).map(item => item.id), ['hook-1']);
    assert.deepEqual(filterEntries(entries, { kind: 'hook', status: 'resolved', query: '守门人' }).map(item => item.id), ['resolved']);
    assert.deepEqual(filterEntries(entries, { query: '抵达' }).map(item => item.id), ['chronicle']);
    assert.equal(filterEntries(entries, { query: '没有的线索' }).length, 0);
    const future = [...progressed, message('更晚发生的事情')]; store = change(store, future, 'create', record(future, { id: 'future', title: '未来记录' }), 'future');
    const inspected = inspectEntries(store, progressed);
    assert.deepEqual(filterEntries(inspected, { scope: 'inactive' }).map(item => item.id), ['future']);
    assert.equal(filterEntries(inspected, { scope: 'all' }).length, 4); assert.equal(filterEntries(inspected).length, 3);
});

test('CRUD is immutable and operation retries are idempotent; deletion follows its branch', () => {
    const chat = conversation(), original = empty(), value = record(chat); let store = change(original, chat, 'create', value, 'create-once');
    assert.equal(original.events.length, 0); value.body = '外部数据修改'; assert.equal(currentEntries(store, chat)[0].body, '确认信件的来历。');
    assert.deepEqual(change(store, chat, 'create', value, 'create-once'), store);
    assert.throws(() => change(store, chat, 'create', value, 'another-create'), /编号已存在/);
    assert.throws(() => change(store, chat, 'update', { ...value, kind: 'chronicle' }), /不能更改/);
    store = change(store, chat, 'update', record(chat, { body: '用户修改后的线索' }), 'update');
    assert.equal(currentEntries(store, chat)[0].body, '用户修改后的线索');
    const later = [...chat, message('后续楼层')]; store = change(store, later, 'delete', { id: value.id }, 'delete');
    assert.equal(currentEntries(store, later).length, 0); assert.equal(inspectEntries(store, later).length, 0);
    assert.equal(currentEntries(store, chat).length, 1); assert.equal(inspectEntries(store, chat).length, 1);
    assert.throws(() => change(store, later, 'update', record(later)), /不在当前分支/);
    assert.deepEqual(change(store, later, 'delete', { id: value.id }, 'delete'), store);
});

test('persistence failures restore absent and existing stores and allow the same operation to retry once', async t => {
    for (const seeded of [false, true]) await t.test(seeded ? 'existing store' : 'absent store', async () => {
        const h = host(); h.ctx.chatMetadata.otherPlugin = { untouched: true };
        if (seeded) h.ctx.chatMetadata[KEY] = empty();
        const before = h.ctx.chatMetadata[KEY], token = h.api.capture(), value = record(h.ctx.chat); let calls = 0;
        h.ctx.saveMetadata = async () => { calls++; throw Error('offline'); };
        await assert.rejects(saveRecord(h, value, 'create', token), /offline/);
        assert.equal(h.ctx.chatMetadata[KEY], before); assert.equal(h.api.busy(), false); assert.equal(h.api.read().events.length, 0);
        assert.deepEqual(h.ctx.chatMetadata.otherPlugin, { untouched: true });
        h.ctx.saveMetadata = async () => { calls++; };
        const saved = await saveRecord(h, value, 'create', token); assert.equal(saved.events.length, 1); assert.equal(calls, 2);
        saved.events.length = 0; assert.equal(h.api.read().events.length, 1);
        await saveRecord(h, value, 'create', token); assert.equal(calls, 2); assert.equal(h.api.read().events.length, 1);
        h.api.dispose();
    });
});

test('busy persistence blocks a second writer and prompt references until the write finishes', async () => {
    const h = host(), pending = deferred(), token = h.api.capture(), otherToken = h.api.capture();
    h.ctx.saveMetadata = () => pending.promise;
    const save = saveRecord(h, record(h.ctx.chat, { enabled: true }), 'create', token);
    assert.equal(h.api.busy(), true);
    await assert.rejects(saveRecord(h, record(h.ctx.chat, { id: 'second' }), 'create', otherToken), /正在保存/);
    h.emit('GENERATION_AFTER_COMMANDS', 'normal'); assert.equal(h.prompts.at(-1)[1], ''); assert.match(h.api.status(), /正在保存/);
    pending.resolve(); await save; assert.equal(h.api.busy(), false); assert.equal(h.api.read().events.length, 1);
    h.emit('GENERATION_AFTER_COMMANDS', 'normal'); assert.match(h.prompts.at(-1)[1], /未拆的信/); h.api.dispose();
});

test('metadata identity, message changes and concurrent journal edits invalidate captured saves', async t => {
    for (const alteration of ['metadata', 'chat', 'message', 'baseline']) await t.test(alteration, async () => {
        const h = host(), token = h.api.capture(), value = record(h.ctx.chat);
        if (alteration === 'metadata') h.ctx.chatMetadata = structuredClone(h.ctx.chatMetadata);
        if (alteration === 'chat') h.ctx.chatId = 'chat-b';
        if (alteration === 'message') h.ctx.chat[2].mes = '较新的行动';
        if (alteration === 'baseline') h.ctx.chatMetadata[KEY] = { ...empty(), limit: 9000 };
        await assert.rejects(saveRecord(h, value, 'create', token), /聊天已切换|楼层或回复内容|其他窗口修改/);
        assert.equal(h.saves(), 0); assert.equal(h.api.read().events.length, 0); h.api.dispose();
    });
});

test('regeneration and swipes exclude references saved after the reply being replaced, and lifecycle clears prompts', async () => {
    const chat = conversation().slice(0, 2), h = host({ chat });
    await saveRecord(h, record(chat, { enabled: true }));
    h.emit('GENERATION_AFTER_COMMANDS', 'normal'); assert.match(h.prompts.at(-1)[1], /未拆的信/);
    for (const type of ['regenerate', 'swipe']) { h.emit('GENERATION_AFTER_COMMANDS', type); assert.equal(h.prompts.at(-1)[1], ''); }
    h.emit('GENERATION_AFTER_COMMANDS', 'continue'); assert.match(h.prompts.at(-1)[1], /未拆的信/);
    for (const [type, options, dryRun] of [['quiet', {}, false], ['normal', {}, true], ['normal', { signal: { aborted: true } }, false]]) {
        h.emit('GENERATION_AFTER_COMMANDS', type, options, dryRun); assert.equal(h.prompts.at(-1)[1], '');
    }
    for (const event of ['GENERATION_ENDED', 'GENERATION_STOPPED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'CHAT_CHANGED']) {
        h.emit('GENERATION_AFTER_COMMANDS', 'normal'); h.emit(event); assert.equal(h.prompts.at(-1)[0], PROMPT_KEY); assert.equal(h.prompts.at(-1)[1], '');
    }
    h.api.dispose(); assert.equal(h.handlers.size, 0);
});

test('JSON transfer preserves text but disables references and requires rebinding to the destination chat', () => {
    const chat = conversation(); const store = change(empty(), chat, 'create', record(chat, { enabled: true, gameTimeText: '秋季第三日' }), 'create');
    const exported = JSON.parse(exportRecords(store, chat));
    assert.equal(exported.format, FORMAT); assert.equal(exported.entries[0].body, '确认信件的来历。');
    assert.equal(Object.hasOwn(exported.entries[0], 'eventId'), false); assert.equal(Object.hasOwn(exported.entries[0], 'savedFloor'), false);
    const [imported] = parseImport(JSON.stringify(exported));
    assert.notEqual(imported.id, 'hook-1'); assert.equal(imported.enabled, false); assert.equal(imported.sources, null); assert.equal(imported.gameTimeText, '秋季第三日');
    assert.match(imported.sourceNote, /原来源楼层 1–2/); assert.match(imported.sourceNote, /重新绑定/);
    const destination = [message('这是一段新的聊天。')]; let destinationStore = change(empty(), destination, 'create', imported, 'import');
    assert.equal(compile(destinationStore, destination), '');
    assert.throws(() => change(destinationStore, destination, 'reference', { id: imported.id, enabled: true }), /绑定当前聊天/);
    destinationStore = change(destinationStore, destination, 'update', { ...imported, sources: sourceFromRange(destination, 0, 0) }, 'rebind');
    assert.equal(compile(destinationStore, destination), '');
    destinationStore = change(destinationStore, destination, 'reference', { id: imported.id, enabled: true }, 'enable');
    assert.match(compile(destinationStore, destination), /未拆的信/);
    for (const raw of ['not json', JSON.stringify({ format: 'other', version: 1, entries: [] }), JSON.stringify({ ...exported, entries: Array(201).fill(exported.entries[0]) })]) assert.throws(() => parseImport(raw), /JSON|仅支持/);
});

test('store reads are isolated and incompatible persisted versions are rejected', () => {
    const ctx = { chatMetadata: { [KEY]: empty() } }, loaded = readStore(ctx); loaded.events.push({ id: 'external' });
    assert.equal(ctx.chatMetadata[KEY].events.length, 0);
    assert.throws(() => readStore({ chatMetadata: { [KEY]: { version: 2, events: [] } } }), /版本不兼容/);
    assert.throws(() => readStore({ chatMetadata: { [KEY]: { version: 1, events: {} } } }), /版本不兼容/);
});
