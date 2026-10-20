import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createRelationshipsService } from '../apps/relationships/service.js';
import { createSceneService } from '../apps/scene/service.js';
import { createJournal } from '../apps/journal/service.js';
import { change as changeJournal, sourceFromRange } from '../apps/journal/model.js';
import { createInformation } from '../apps/information/service.js';
import { empty as emptyInformation, apply as applyInformation } from '../apps/information/model.js';
import { createEffects } from '../apps/effects/service.js';
import { KEY as EFFECTS_KEY, empty as emptyEffects, change as changeEffects } from '../apps/effects/model.js';
import { createTextUpdates } from '../apps/map/src/integrations/text-updates.js';
import { createMapTools } from '../apps/map/src/integrations/tool-calling.js';
import { createDemoDocument } from '../apps/map/src/core/demo.js';
import { createStore } from '../apps/map/src/core/store.js';
import { createDraftSession } from '../apps/map/src/core/draft.js';
import { bindChatStore } from '../apps/map/src/adapters/chat.js';
import { KEY as CHARACTERS_KEY, emptyStore as emptyCharacters, appendSnapshot as appendCharacters } from '../apps/characters/model.js';
import { KEY as LINKAGE_KEY, MODULES, emptyLinkageState } from '../apps/linkage/policy.js';
import { promptInjectors } from '../apps/linkage/injectors.js';
import { readFileSync } from 'node:fs';

const at = '2026-10-20T00:00:00.000Z';
const EVENTS = ['GENERATION_AFTER_COMMANDS', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED'];
// Map payloads carry a per-run lease token and information prompts a wall-clock
// save time; everything else must match byte for byte.
const digest = text => { const stable = text.replace(/"token":"[^"]*"/g, '"token":"*"').replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '*'); return `${text.length}:${createHash('sha256').update(stable).digest('hex').slice(0, 16)}`; };

// All six prompt-injecting apps share one host, as in the extension, so the
// recorded order also covers the registry's single subscription per event.
async function host() {
    const source = new EventEmitter(), calls = [];
    const chat = [{ name: '玩家', is_user: true, mes: '进入旧城。', swipe_id: 0 }, { name: '主持人', mes: '守门人交给你一封未拆的信。', swipe_id: 0 }, { name: '玩家', is_user: true, mes: '我收好信。', swipe_id: 0 }];
    const person = id => ({ id, name: id, kind: 'npc', notes: '', stats: [] });
    const ctx = { chat, chatMetadata: {}, characterId: 0, groupId: null, characters: [{ avatar: 'a.png', name: 'A' }], extensionSettings: {},
        getCurrentChatId: () => 'chat-a', saveMetadata: async () => {}, saveSettingsDebounced() {},
        eventTypes: Object.fromEntries(EVENTS.map(name => [name, name])), eventSource: source,
        setExtensionPrompt: (...args) => calls.push(args.map(value => typeof value === 'string' && value.length > 40 ? digest(value) : value)) };
    ctx.chatMetadata[CHARACTERS_KEY] = appendCharacters(emptyCharacters(), chat, { version: 1, characters: [person('alice'), person('bob')] }, { id: 'people', at });
    ctx.chatMetadata[EFFECTS_KEY] = changeEffects({ ...emptyEffects(), skills: [{ id: 's', name: '所有权', book: '书', entryId: '1', original: '原文', reminder: '持有到主动解除' }] }, chat, 'create',
        { skillId: 's', holder: '甲', target: '乙', scope: '视觉', command: '黑暗', condition: '直到解除' });
    const getContext = () => ctx;
    let count = 0;
    const relationships = createRelationshipsService(getContext, { createId: () => `r_${++count}`, now: () => at });
    relationships.saveRelationship({ id: 'r1', fromId: 'alice', toId: 'bob', type: '信任', label: '', notes: '' }); await relationships.confirm();
    relationships.stage('settings', { includeInContext: true }); await relationships.confirm();
    const scene = createSceneService(getContext, { createId: () => `s_${++count}`, now: () => at });
    scene.stage('set-time', { clock: { year: 1925, month: 12, day: 31, hour: 23, minute: 50, calendarLabel: '' }, reason: '起始' }); await scene.confirm();
    scene.stage('settings', { enabled: true, includeInContext: true, reason: '读取' }); await scene.confirm();
    const journal = createJournal(getContext, { ai: () => null });
    const token = journal.capture();
    await journal.save(token, (store, current) => changeJournal(store, current.chat, 'create', { id: 'hook-1', kind: 'hook', title: '未拆的信', body: '确认来历。', actors: ['守门人'], sources: sourceFromRange(current.chat, 0, 1), enabled: true }, token.operationId));
    const information = createInformation(getContext);
    await information.save(information.capture(), state => applyInformation(state, chat, { id: 'r', name: '甲', kind: 'person', mode: 'retcon', fields: [{ id: 'f', category: '身份', label: '职业', value: '守卫', status: 'known', sources: [] }] }));
    const effects = createEffects(getContext);
    const store = createStore(createDemoDocument()), persistence = bindChatStore(store, { getContext, storage: { getItem: () => null, setItem() {} }, namespace: 'injectors' });
    const draft = createDraftSession(store, persistence), tools = createMapTools({ store, draft, persistence, getContext });
    persistence.importDocument(store.snapshot(), persistence.token()); tools.configure({ enabled: true, textMode: true });
    const map = createTextUpdates({ tools, getContext });
    await new Promise(resolve => setTimeout(resolve, 20)); // let the map's initial save settle
    calls.length = 0;
    return { ctx, source, calls, emit: (name, ...args) => source.emit(name, ...args),
        dispose() { if (this.disposed) return; this.disposed = true; relationships.dispose(); scene.dispose(); journal.dispose(); information.dispose(); effects.dispose(); map.destroy(); tools.destroy(); draft.destroy(); persistence.destroy(); } };
}

function run(h) {
    const steps = [['GENERATION_AFTER_COMMANDS', 'normal'], ['GENERATION_AFTER_COMMANDS', 'normal', {}, true], ['GENERATION_AFTER_COMMANDS', 'quiet'],
        ['GENERATION_AFTER_COMMANDS', 'continue'], ['GENERATION_ENDED'], ['GENERATION_AFTER_COMMANDS', 'normal', { signal: { aborted: true } }],
        ['GENERATION_AFTER_COMMANDS', 'normal'], ['GENERATION_STOPPED'], ['GENERATION_AFTER_COMMANDS', 'normal'], ['CHAT_CHANGED']];
    const log = [];
    for (const [name, ...args] of steps) { h.calls.length = 0; h.emit(name, ...args); log.push([name, ...args.map(value => typeof value === 'object' ? JSON.stringify(value) : value), h.calls.slice()]); }
    return log;
}

test('migrated injectors keep every setExtensionPrompt key, position, depth and text in the original order', async () => {
    const h = await host();
    try {
        const plain = run(h);
        h.ctx.chatMetadata[LINKAGE_KEY] = { ...emptyLinkageState(), enabled: true, modules: Object.fromEntries(Object.keys(MODULES).map(id => [id, { enabled: true, read: true, write: id !== 'dice' }])) };
        h.calls.length = 0; h.emit('GENERATION_AFTER_COMMANDS', 'normal'); const managed = h.calls.slice();
        delete h.ctx.chatMetadata[LINKAGE_KEY];
        h.calls.length = 0; h.dispose(); const disposed = h.calls.slice();
        h.calls.length = 0; h.emit('GENERATION_AFTER_COMMANDS', 'normal'); h.emit('CHAT_CHANGED');
        assert.deepEqual(h.calls, [], 'disposed apps no longer inject or clear');
        // Recorded from the per-app injection code before it moved to the registry.
        const expected = JSON.parse(readFileSync(new URL('./prompt-injectors.expected.json', import.meta.url), 'utf8'));
        assert.deepEqual({ plain, managed, disposed }, expected);
    } finally { h.dispose(); }
});

function fakeHost(extra = {}) {
    const source = new EventEmitter(), calls = [];
    const ctx = { eventSource: source, eventTypes: { GENERATION_AFTER_COMMANDS: 'gac', CHAT_CHANGED: 'chat' }, setExtensionPrompt: (...args) => calls.push(args), ...extra };
    return { ctx, source, calls, getContext: () => ctx };
}

test('registry builds each registered prompt once per generation and clears on dry runs and chat switches', () => {
    const h = fakeHost(), seen = [];
    const injectors = promptInjectors(h.getContext);
    assert.equal(injectors.supported, true);
    const a = injectors.register('a', { build: (type, options) => { seen.push(['a', type, options]); return 'A:' + type; } });
    const b = promptInjectors(h.getContext).register('b', { position: 2, depth: 4, enabled: type => type !== 'quiet', build: () => null });
    const c = injectors.register('c', { keepOnDryRun: true, build: () => '' });
    assert.equal(h.source.listenerCount('gac'), 1, 'one subscription per event source');
    h.source.emit('gac', 'normal', { x: 1 }, false);
    assert.deepEqual(h.calls, [['a', '', 1, 0, false], ['a', 'A:normal', 1, 0, false], ['b', '', 2, 4, false], ['c', '', 1, 0, false], ['c', '', 1, 0, false]]);
    assert.deepEqual(seen, [['a', 'normal', { x: 1 }]]);
    h.calls.length = 0; h.source.emit('gac', 'normal', {}, true);
    assert.deepEqual(h.calls, [['a', '', 1, 0, false], ['b', '', 2, 4, false]], 'dry runs clear but never build');
    h.calls.length = 0; h.source.emit('gac', 'quiet'); h.source.emit('chat');
    assert.deepEqual(h.calls.map(call => call[0] + (call[1] ? '+' : '-')), ['a-', 'a+', 'b-', 'c-', 'c-', 'a-', 'b-', 'c-']);
    h.calls.length = 0; a.dispose(); b.dispose();
    assert.deepEqual(h.calls, [['a', '', 1, 0, false], ['b', '', 2, 4, false]]);
    c.dispose(); assert.equal(h.source.listenerCount('gac'), 0); assert.equal(h.source.listenerCount('chat'), 0);
});

test('a failing app does not stop the other injectors, and unsupported hosts still clear on request', () => {
    const h = fakeHost(), errors = [];
    const injectors = promptInjectors(h.getContext);
    injectors.register('bad', { build: () => { throw Error('boom'); }, onError: error => errors.push(error.message) });
    const good = injectors.register('good', { build: () => 'ok' });
    h.source.emit('gac', 'normal');
    assert.deepEqual(errors, ['boom']); assert.deepEqual(h.calls.at(-1), ['good', 'ok', 1, 0, false]);
    good.dispose();
    const bare = fakeHost({ eventTypes: {} }), handle = promptInjectors(bare.getContext).register('x', { build: () => 'never' });
    assert.equal(handle.supported, false); handle.clear();
    assert.deepEqual(bare.calls, [['x', '', 1, 0, false]]); assert.equal(bare.source.listenerCount('gac'), 0);
});
