import test from 'node:test';
import assert from 'node:assert/strict';
import { createCardProfileService } from '../service.js';
import { KEY } from '../model.js';

const KITA = '喜多郁代=[\n基本信息:[\n*年龄: 16岁\n*乐器: 吉他\n]\n]';
const NIJIKA = '伊地知虹夏=[\n基本信息:[\n*年龄: 17岁\n*乐器: 鼓\n]\n]';
const book = { entries: {
    0: { uid: 0, comment: '喜多郁代', content: KITA, constant: true, disable: false },
    1: { uid: 1, comment: '伊地知虹夏', content: NIJIKA, constant: true, disable: false },
    2: { uid: 2, comment: '地点', content: 'STARRY 是一家 livehouse。', constant: false },
} };

function host() {
    const handlers = {}, notices = [];
    const ctx = { chatMetadata: {}, chat: [], getCurrentChatId: () => 'c1', characters: [{ avatar: 'band.png', name: '结束乐队', description: '多人卡，角色见世界书。' }], characterId: 0,
        saveMetadata: async () => {}, setExtensionPrompt() {},
        eventTypes: { MESSAGE_RECEIVED: 'recv', CHAT_COMPLETION_PROMPT_READY: 'ccp' },
        eventSource: { on: (name, fn) => { (handlers[name] ??= []).push(fn); }, removeListener() {} } };
    const service = createCardProfileService(() => ctx, { notice: text => notices.push(text), worldbooks: { choices: async () => [{ name: '结束乐队' }], load: async () => structuredClone(book) } });
    service.install();
    return { ctx, service, notices };
}

test('world-info entries are listed, imported one copy each, and swapped in the prompt', async () => {
    const { ctx, service, notices } = host();
    const { entries } = await service.worldCandidates();
    assert.deepEqual(entries.map(item => item.name), ['喜多郁代', '伊地知虹夏'], 'only bracket templates are offered');
    const keys = await service.importWorld(entries);
    assert.deepEqual(keys, ['wi:结束乐队#0', 'wi:结束乐队#1']);
    assert.ok((await service.worldCandidates()).entries.every(item => item.imported));
    const snapshot = service.snapshot();
    assert.deepEqual(snapshot.map(item => [item.kind, item.name]), [['card', '结束乐队'], ['world', '喜多郁代'], ['world', '伊地知虹夏']]);
    await service.set(keys[0], snapshot[1].profile.current.children[0].children[0].id, { value: '16岁（已加入乐队）' });
    const chat = [{ role: 'system', content: '多人卡，角色见世界书。' }, { role: 'system', content: `${KITA}\n${NIJIKA}` }];
    service.hooks.onChatPrompt({ chat, dryRun: false });
    assert.match(chat[1].content, /\*年龄: 16岁（已加入乐队）/);
    assert.match(chat[1].content, /伊地知虹夏=\[/);
    assert.equal(chat[0].content, '多人卡，角色见世界书。', 'the card description is untouched');
    assert.equal(notices.length, 0);
    const missing = [{ role: 'system', content: NIJIKA }];
    service.hooks.onChatPrompt({ chat: missing, dryRun: false });
    assert.equal(notices.length, 0, 'an entry that was not triggered is normal: no toast');
    assert.equal(service.snapshot().find(item => item.name === '喜多郁代')?.result?.absent, true, 'the app shows it as not triggered');
    await service.remove(keys[0]);
    assert.equal(Object.keys(ctx.chatMetadata[KEY].profiles).length, 1);
});

test('proposals for a multi-character card go to the copy the char name points at', async () => {
    const { ctx, service } = host();
    await service.importWorld((await service.worldCandidates()).entries);
    assert.match(service.rules(), /"char":"设定名"/);
    ctx.chat.push({ is_user: false, name: '结束乐队', original_avatar: 'band.png', swipe_id: 0, send_date: 't', mes: '正文<!--amin_card [{"char":"伊地知虹夏","op":"set","path":"基本信息/年龄","value":"18岁","reason":"生日"},{"op":"set","path":"基本信息/年龄","value":"x"}] -->' });
    await service.receive(0);
    const entries = service.proposalsFor(0);
    assert.equal(entries.length, 1, 'an item without char is dropped when several copies could match');
    assert.equal(entries[0].avatar, 'wi:结束乐队#1');
    assert.equal(entries[0].name, '伊地知虹夏');
    await service.accept(entries[0].id, [entries[0].items[0].id]);
    assert.match(service.rendered('wi:结束乐队#1'), /\*年龄: 18岁/);
});

test('a created 世界资料 is sent as an extra block and can be a world panel', async () => {
    const { ctx, service } = host();
    const prompts = new Map(); ctx.setExtensionPrompt = (key, text, position) => prompts.set(key, { text, position });
    const key = await service.createNote({ kind: 'world', text: '下北泽=[\n地点:[\n*STARRY: 地下 livehouse\n]\n]' });
    assert.match(key, /^note:/);
    assert.deepEqual(service.snapshot().at(-1).kind, 'note');
    assert.match(service.notesPrompt(), /下北泽=\[\n地点:\[\n\*STARRY: 地下 livehouse/);
    await service.options(key, { panel: { on: true, editors: [{ name: '{{user}}', sections: [] }] } });
    ctx.name1 = '阿明';
    assert.match(service.rules(), /【世界面板】下北泽/);
    await service.options(key, { replace: false });
    assert.equal(service.notesPrompt(), null);
});

test('AI draft parsing keeps only the template', async () => {
    const { parseDraft, generateNote } = await import('../generate.js');
    assert.equal(parseDraft('好的：\n```\n世界=[\n概况:[\n*时代: 现代\n]\n]\n```\n以上'), '世界=[\n概况:[\n*时代: 现代\n]\n]');
    assert.throws(() => parseDraft('没有模板'), /名字=\[/);
    const asked = [];
    const ai = { capture: () => ({}), generate: async (app, ctx, request) => { asked.push(request); return '世界=[\n概况:[\n*时代: 现代\n]\n]'; } };
    const ctx = { chat: [{ name: '喜多', mes: '去 STARRY 吧<!--amin_card [] -->' }] };
    const text = await generateNote(ctx, { kind: 'world', characters: [{ name: '结束乐队', description: '四人乐队' }], worldbooks: { choices: async () => [{ name: 'b', data: book }] } }, { ai });
    assert.match(text, /^世界=\[/);
    assert.match(asked[0].prompt, /四人乐队/); assert.match(asked[0].prompt, /STARRY 是一家 livehouse/); assert.doesNotMatch(asked[0].prompt, /amin_card/);
});

test('an entry edited after import is reported as changed and can be refreshed', async () => {
    const { ctx, service, notices } = host();
    const [key] = await service.importWorld((await service.worldCandidates()).entries.slice(0, 1));
    const edited = KITA.replace('16岁', '18岁');
    service.hooks.onChatPrompt({ chat: [{ role: 'system', content: edited }], dryRun: false });
    assert.ok(notices.some(text => /发送了，但内容和导入时不一样/.test(text)));
    book.entries[0].content = edited;
    try {
        assert.equal(await service.refreshWorldSource(key), true);
        const chat = [{ role: 'system', content: edited }];
        service.hooks.onChatPrompt({ chat, dryRun: false });
        assert.notEqual(chat[0].content, edited, 'replaced again after refreshing');
        assert.equal(ctx.chatMetadata.amin_os_card_profile_v1.profiles[key].source.text, edited);
    } finally { book.entries[0].content = KITA; }
});
