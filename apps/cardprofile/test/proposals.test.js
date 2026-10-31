import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfile, setOptions, locate } from '../model.js';
import { buildRules, extract, resolvePath, checkItem, applyItem, messageKey, targetAvatar } from '../proposals.js';
import { renderProposalRow } from '../floor.js';
import { createCardProfileService } from '../service.js';
import { KEY } from '../model.js';
import { CARD } from './fixture.js';

const LOCKED_CARD = CARD.replace(/\n\]$/, '\nNSFW设定:[\n*说明: 略\n]\n]');
const make = (text = CARD) => createProfile({ avatar: 'f.png', cardName: '芙莉莲', description: text, hash: 'h' });

test('rules name the copy and its locked sections; NSFW sections lock on import', () => {
    const profile = make(LOCKED_CARD);
    assert.equal(profile.locked.length, 1);
    const rules = buildRules([profile]);
    assert.match(rules, /芙莉莲=\[/);
    assert.match(rules, /<!--amin_card/);
    assert.match(rules, /不要提议修改：NSFW设定/);
});

test('extracts proposal comments and tolerates junk', () => {
    const reply = '正文……\n<!--amin_card [{"op":"set","path":"基本信息/基本设定/年龄","value":"1001岁","reason":"过了生日"}] -->';
    assert.deepEqual(extract(reply).items.map(item => item.value), ['1001岁']);
    assert.deepEqual(extract('<!--amin_card {不是json} -->').errors.length, 1);
    assert.deepEqual(extract('普通回复'), { items: [], errors: [] });
    assert.equal(extract('<!-- amin_card\n{"op":"remove","path":"关键词"}\n-->').items[0].op, 'remove');
});

test('paths resolve by key, ignore * marks and need #n for duplicates', () => {
    const profile = make();
    assert.equal(resolvePath(profile.current, '*基本信息 / 基本设定 / *年龄').node.value, '1000岁以上');
    assert.throws(() => resolvePath(profile.current, '说话风格/对话范例/情境'), /情境#2/);
    assert.equal(resolvePath(profile.current, '说话风格/对话范例/情境#2').node.value, '被宝箱怪咬住。');
    assert.throws(() => resolvePath(profile.current, '基本信息/不存在'), /找不到/);
});

test('items are checked against the copy and applied on acceptance', () => {
    let profile = make(LOCKED_CARD);
    const set = checkItem(profile, { op: 'set', path: '基本信息/基本设定/年龄', value: '1001岁', reason: '生日' }, 'a');
    assert.equal(set.status, 'pending'); assert.equal(set.before, '1000岁以上');
    assert.equal(checkItem(profile, { op: 'set', path: 'NSFW设定/说明', value: 'x' }, 'b').status, 'locked');
    assert.equal(checkItem(profile, { op: 'set', path: '基本信息/基本设定', value: 'x' }, 'c').status, 'invalid');
    assert.equal(checkItem(profile, { op: 'set', path: '基本信息/基本设定/年龄', value: '1000岁以上' }, 'd').error, '与当前内容相同。');
    const add = checkItem(profile, { op: 'add', path: '重要关系', key: '关系二', items: [{ key: '对象', value: '菲伦' }, { key: '描述', value: '弟子' }] }, 'e');
    assert.equal(add.status, 'pending');
    profile = applyItem(profile, set);
    profile = applyItem(profile, add);
    profile = applyItem(profile, checkItem(profile, { op: 'remove', path: '关键词' }, 'f'));
    assert.equal(resolvePath(profile.current, '基本信息/基本设定/年龄').node.value, '1001岁');
    assert.equal(resolvePath(profile.current, '重要关系/关系二/对象').node.value, '菲伦');
    assert.throws(() => resolvePath(profile.current, '关键词'));
    assert.match(profile.history.at(-3).label, /采纳 AI 建议：修改 基本信息 \/ 基本设定 \/ 年龄（生日）/);
    profile = setOptions(profile, { lock: { id: resolvePath(profile.current, '基本信息').node.id, on: true } });
    assert.throws(() => applyItem(profile, checkItem(make(), { op: 'set', path: '基本信息/名字/中文', value: 'x' }, 'g')), /已锁定/);
});

test('group replies go to the speaker; explicit char names win', () => {
    const a = make(), b = { ...make(), avatar: 's.png', cardName: '菲伦', current: { ...make().current, name: '菲伦' } };
    assert.equal(targetAvatar({}, { original_avatar: 's.png' }, [a, b]), 's.png');
    assert.equal(targetAvatar({ char: '芙莉莲' }, { original_avatar: 's.png' }, [a, b]), 'f.png');
    assert.equal(targetAvatar({}, {}, [a]), 'f.png');
    assert.equal(targetAvatar({}, {}, [a, b]), null);
    assert.notEqual(messageKey({ swipe_id: 0, send_date: 'x' }, 3), messageKey({ swipe_id: 1, send_date: 'y' }, 3));
});

function host() {
    const handlers = {}, prompts = new Map(), notices = [];
    const card = { avatar: 'f.png', name: '芙莉莲', description: LOCKED_CARD };
    const ctx = { chatMetadata: {}, chat: [], getCurrentChatId: () => 'c1', characters: [card], characterId: 0,
        saveMetadata: async () => {}, setExtensionPrompt: (key, text) => prompts.set(key, text),
        eventTypes: { MESSAGE_RECEIVED: 'recv', GENERATION_AFTER_COMMANDS: 'gac', CHAT_CHANGED: 'chat', CHAT_COMPLETION_PROMPT_READY: 'ccp' },
        eventSource: { on: (name, fn) => { (handlers[name] ??= []).push(fn); }, removeListener() {} } };
    const service = createCardProfileService(() => ctx, { notice: text => notices.push(text) });
    service.install();
    const emit = (name, ...args) => Promise.all((handlers[name] ?? []).map(fn => fn(...args)));
    return { ctx, service, emit, prompts, notices };
}

test('service injects rules, records proposals from a reply and applies accepted ones', async () => {
    const { ctx, service, emit, prompts } = host();
    await emit('gac', 'normal', {}, false);
    assert.equal(prompts.get('amin-os-card-profile') ?? '', '', 'no copy, no rules');
    await service.importCard('f.png');
    await emit('gac', 'normal', {}, false);
    assert.match(prompts.get('amin-os-card-profile'), /amin_card/);
    ctx.chat.push({ is_user: false, name: '芙莉莲', swipe_id: 0, send_date: 't1', mes: '正文\n<!--amin_card [{"op":"set","path":"基本信息/基本设定/年龄","value":"1001岁","reason":"生日"},{"op":"set","path":"NSFW设定/说明","value":"x"},{"op":"set","path":"没有/这项","value":"x"}] -->' });
    await service.receive(0);
    await service.receive(0);
    const entries = service.proposalsFor(0);
    assert.equal(entries.length, 1, 'a reply is recorded once');
    assert.deepEqual(entries[0].items.map(item => item.status), ['pending', 'invalid'], 'locked items are dropped, invalid ones explained');
    await service.accept(entries[0].id, [entries[0].items[0].id]);
    assert.match(service.rendered('f.png'), /\*年龄: 1001岁/);
    assert.equal(service.proposalsFor(0)[0].items[0].status, 'accepted');
    ctx.chat[0].swipe_id = 1; ctx.chat[0].send_date = 't2';
    assert.equal(service.proposalsFor(0).length, 0, 'another swipe shows no proposals');
    await service.options('f.png', { propose: false });
    await emit('gac', 'normal', {}, false);
    assert.equal(prompts.get('amin-os-card-profile'), '');
    assert.ok(ctx.chatMetadata[KEY].proposals.length);
});

test('floor row lists items with accept and ignore buttons', () => {
    class El { constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.textContent = ''; } append(...items) { this.children.push(...items); } replaceChildren(...items) { this.children = items; } addEventListener(name, fn) { this.listeners[name] = fn; } setAttribute() {} }
    const document = { createElement: tag => new El(tag) }, row = new El('div'), decided = [];
    const entries = [{ id: 'e', avatar: 'f.png', key: 'k', items: [{ id: 'a', op: 'set', path: '基本信息/基本设定/年龄', before: '1000岁以上', value: '1001岁', reason: '生日', status: 'pending' }, { id: 'b', op: 'remove', path: '关键词', status: 'ignored' }] }];
    renderProposalRow(row, entries, { document, names: { 'f.png': '芙莉莲' }, onDecide: (...args) => decided.push(args), onOpen() {} });
    const texts = [];
    const walkTree = node => { if (node.textContent) texts.push(node.textContent); (node.children ?? []).forEach(walkTree); };
    walkTree(row);
    assert.ok(texts.includes('角色设定建议 · 芙莉莲 · 1 条待定'));
    assert.ok(texts.includes('修改 基本信息 / 基本设定 / 年龄'));
    assert.ok(texts.includes('已忽略'));
    const buttons = []; const collect = node => { if (node.tag === 'button') buttons.push(node); (node.children ?? []).forEach(collect); }; collect(row);
    buttons.find(button => button.textContent === '采纳').listeners.click();
    assert.deepEqual(decided, [['e', ['a'], true]]);
});
