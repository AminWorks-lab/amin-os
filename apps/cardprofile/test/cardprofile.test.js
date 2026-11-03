import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCard, writeCard } from '../format.js';
import { createProfile, setNode, addNode, removeNode, restoreNode, moveNode, resetProfile, setOptions, diffProfile, renderForPrompt, locate, validateStore, KEY } from '../model.js';
import { candidates, replaceInMessages, replaceInText } from '../prompt.js';
import { createCardProfileService, hashDescription } from '../service.js';
import { CARD } from './fixture.js';

const find = (tree, key) => { let hit = null; const walk = nodes => { for (const node of nodes) { if (!hit && node.key === key) hit = node; if (node.children) walk(node.children); } }; walk(tree.children); return hit; };
const make = (text = CARD) => createProfile({ avatar: 'frieren.png', cardName: '芙莉莲', description: text, hash: 'h', at: 't0' });

test('parses the bracket template and writes it back line for line', () => {
    const tree = parseCard(CARD);
    assert.equal(tree.name, '芙莉莲');
    assert.equal(writeCard(tree), CARD);
    const group = find(tree, '原则一');
    assert.equal(group.kind, 'group'); assert.equal(group.star, true);
    const examples = find(tree, '对话范例').children;
    assert.deepEqual(examples.map(node => node.key), ['情境', '对话', '情境', '对话']);
    const bare = find(tree, '其他身体特征').children[0];
    assert.equal(bare.kind, 'text'); assert.equal(bare.star, false);
    assert.deepEqual(find(tree, '关键词').children.map(node => [node.kind, node.star, node.value]), [['text', true, '精灵魔法使'], ['text', true, '银发双马尾']]);
});

test('keeps text around the template, odd separators and indentation-insensitive input', () => {
    const source = '前言一行\n角色=[\n  *键：值\n分组 :[\n*空:\n]\n]\n后记';
    const tree = parseCard(source);
    assert.equal(tree.before, '前言一行'); assert.equal(tree.after, '后记');
    assert.equal(writeCard(tree), '前言一行\n角色=[\n*键：值\n分组 :[\n*空:\n]\n]\n后记');
});

test('reports unbalanced or missing templates', () => {
    assert.throws(() => parseCard('只是普通描述'), /名字=\[/);
    assert.throws(() => parseCard('角色=[\n分组:[\n*a: b\n]'), /缺少 1 个/);
});

test('edits keep the baseline and record a change log', () => {
    let profile = make();
    const age = find(profile.current, '年龄');
    profile = setNode(profile, age.id, { value: '1001岁' }, { at: 't1' });
    assert.equal(find(profile.baseline, '年龄').value, '1000岁以上');
    assert.equal(find(profile.current, '年龄').value, '1001岁');
    assert.match(profile.history.at(-1).label, /基本信息 \/ 基本设定 \/ 年龄/);
    const relations = find(profile.current, '重要关系');
    const added = addNode(profile, relations.id, { kind: 'group', key: '关系二' });
    profile = added.profile;
    profile = addNode(profile, added.id, { key: '对象', value: '菲伦' }).profile;
    const keywords = find(profile.current, '关键词');
    profile = removeNode(profile, keywords.children[1].id);
    const changes = diffProfile(profile);
    assert.deepEqual(changes.map(change => change.type).sort(), ['added', 'changed', 'removed']);
    const text = renderForPrompt(profile);
    assert.match(text, /\*年龄: 1001岁/);
    assert.match(text, /修改 基本信息 \/ 基本设定 \/ 年龄：初始「1000岁以上」 → 当前「1001岁」/);
    assert.match(text, /新增 重要关系 \/ 关系二：（分组）/);
    assert.match(text, /删除 关键词 \/ 银发双马尾：初始「银发双马尾」/);
    assert.doesNotMatch(text, /对象：「菲伦」/, 'children of a new group are reported once, through the group');
});

test('inline and off comparison modes', () => {
    let profile = make();
    profile = setNode(profile, find(profile.current, '年龄').id, { value: '1001岁' });
    profile = setOptions(profile, { diff: 'inline' });
    assert.match(renderForPrompt(profile), /\*年龄: 1001岁\n（初始：1000岁以上）\n/);
    profile = setOptions(profile, { diff: 'off' });
    assert.doesNotMatch(renderForPrompt(profile), /初始/);
    assert.throws(() => setOptions(profile, { diff: 'all' }), /对照格式/);
});

test('restore puts a field or a deleted subtree back without duplicating moved children', () => {
    let profile = make();
    const rule = find(profile.current, '原则一');
    profile = setNode(profile, rule.children[0].id, { value: '改过' });
    profile = restoreNode(profile, rule.children[0].id);
    assert.equal(diffProfile(profile).length, 0);
    const relations = find(profile.current, '重要关系');
    profile = removeNode(profile, relations.id);
    profile = restoreNode(profile, relations.id);
    assert.equal(writeCard(profile.current), CARD);
    const name = find(profile.current, '名字');
    profile = moveNode(profile, name.id, 1);
    assert.notEqual(writeCard(profile.current), CARD);
    profile = resetProfile(profile);
    assert.equal(writeCard(profile.current), CARD);
    const added = addNode(profile, null, { kind: 'group', key: '新分区' });
    assert.throws(() => restoreNode(added.profile, added.id), /新增/);
});

test('values stay on one line and keys cannot break the template', () => {
    let profile = make();
    const age = find(profile.current, '年龄');
    profile = setNode(profile, age.id, { value: '第一行\n第二行' });
    assert.equal(find(profile.current, '年龄').value, '第一行 第二行');
    assert.throws(() => setNode(profile, age.id, { key: '坏]键' }), /键名无效/);
    assert.throws(() => setNode(profile, age.id, { key: '' }), /键名无效/);
});

test('prompt replacement swaps one exact description in chat or text prompts', () => {
    const forms = candidates('  {{char}}=[\n*a: b\n]  ', text => text.replaceAll('{{char}}', '芙莉莲'));
    assert.equal(forms[0], '{{char}}=[\n*a: b\n]  '.length > forms[0].length ? forms[0] : forms[0]);
    const messages = [{ role: 'system', content: '前文\n芙莉莲=[\n*a: b\n]\n后文' }, { role: 'user', content: [{ type: 'text', text: '芙莉莲=[\n*a: b\n]' }] }];
    assert.equal(replaceInMessages(messages, forms, '新版'), true);
    assert.equal(messages[0].content, '前文\n新版\n后文');
    assert.equal(messages[1].content[0].text, '芙莉莲=[\n*a: b\n]', 'only the first occurrence is replaced');
    assert.deepEqual(replaceInText('无关内容', forms, '新版'), { prompt: '无关内容', matched: false });
    assert.equal(replaceInText('x 芙莉莲=[\n*a: b\n] y', forms, '$&新版').prompt, 'x $&新版 y');
});

function host({ description = CARD, metadata = {} } = {}) {
    const handlers = {}, notices = [];
    const card = { avatar: 'frieren.png', name: '芙莉莲', description, data: { description } };
    const ctx = { chatMetadata: metadata, chat: [], getCurrentChatId: () => 'chat-1', characters: [card], characterId: 0, groupId: null,
        substituteParams: text => text.replaceAll('{{char}}', '芙莉莲'), saveMetadata: async () => {},
        eventTypes: { CHAT_COMPLETION_PROMPT_READY: 'ccp', GENERATE_AFTER_COMBINE_PROMPTS: 'tcp', CHAT_CHANGED: 'chat' },
        eventSource: { on: (name, fn) => { handlers[name] = fn; }, removeListener() {} } };
    const service = createCardProfileService(() => ctx, { notice: message => notices.push(message) });
    service.install();
    return { ctx, card, handlers, notices, service };
}

test('service imports a per-chat copy, edits it and replaces the description when sending', async () => {
    const { ctx, handlers, service, notices } = host();
    const [entry] = service.snapshot();
    assert.equal(entry.profile, null);
    await service.importCard('frieren.png');
    validateStore(ctx.chatMetadata[KEY]);
    const stored = ctx.chatMetadata[KEY].profiles['frieren.png'];
    const age = locate(stored.current, find(stored.current, '年龄').id).node;
    await service.set('frieren.png', age.id, { value: '1001岁' });
    const chat = [{ role: 'system', content: `设定：\n${CARD}\n其他` }];
    handlers.ccp({ chat, dryRun: false });
    assert.match(chat[0].content, /\*年龄: 1001岁/);
    assert.match(chat[0].content, /【与初始设定的差异/);
    assert.equal(chat[0].content.split('芙莉莲=[').length, 2, 'the original is not sent alongside the copy');
    const text = { prompt: `A\n${CARD}\nB`, dryRun: false };
    handlers.tcp(text);
    assert.match(text.prompt, /1001岁/);
    assert.equal(service.snapshot()[0].result.matched, true);
    const missing = [{ role: 'system', content: '预设用别的方式引用了描述' }];
    handlers.ccp({ chat: missing, dryRun: false });
    handlers.ccp({ chat: missing, dryRun: false });
    assert.equal(missing[0].content, '预设用别的方式引用了描述');
    assert.equal(notices.length, 1, 'a missing description warns once per chat');
    await service.options('frieren.png', { replace: false });
    const off = [{ role: 'system', content: CARD }];
    handlers.ccp({ chat: off, dryRun: false });
    assert.equal(off[0].content, CARD);
});

test('card edits are detected and the copy can be kept or re-imported', async () => {
    const { card, service } = host();
    await service.importCard('frieren.png');
    card.description = card.data.description = CARD.replace('1000岁以上', '千岁');
    assert.equal(service.snapshot()[0].cardChanged, true);
    await service.keepCopy('frieren.png');
    assert.equal(service.snapshot()[0].cardChanged, false);
    assert.equal(service.snapshot()[0].profile.sourceHash, hashDescription(card.data.description));
    await service.reimport('frieren.png');
    assert.match(service.rendered('frieren.png'), /千岁/);
});

test('chats without a copy are left untouched', () => {
    const { handlers } = host();
    const chat = [{ role: 'system', content: CARD }];
    handlers.ccp({ chat, dryRun: false });
    assert.equal(chat[0].content, CARD);
});

test('matches descriptions after SillyTavern trims, drops \\r and collapses blank lines', () => {
    const forms = candidates('\r\n名=[\r\n\r\n*a: b\r\n]\r\n', null);
    const messages = [{ role: 'system', content: 'x\n名=[\n*a: b\n]\ny' }];
    assert.equal(replaceInMessages(messages, forms, '新'), true);
    assert.equal(messages[0].content, 'x\n新\ny');
});

test('replacement never edits earlier assistant replies', async () => {
    const { replaceInMessages } = await import('../prompt.js');
    const messages = [{ role: 'assistant', content: '原文' }, { role: 'system', content: '设定：原文' }];
    assert.equal(replaceInMessages(messages, ['原文'], '新文'), true);
    assert.deepEqual(messages.map(m => m.content), ['原文', '设定：新文']);
});

test('a preset assistant block can be replaced, chat history assistant replies cannot', async () => {
    const { replaceInMessages } = await import('../prompt.js');
    const messages = [{ role: 'system', content: '规则' }, { role: 'assistant', content: '角色定义：原文' }, { role: 'assistant', content: '她说：原文' }];
    assert.equal(replaceInMessages(messages, ['原文'], '新文', { history: ['她说：原文'] }), true);
    assert.deepEqual(messages.map(m => m.content), ['规则', '角色定义：新文', '她说：原文']);
    const onlyHistory = [{ role: 'assistant', content: '她说：原文' }];
    assert.equal(replaceInMessages(onlyHistory, ['原文'], '新文', { history: ['她说：原文'] }), false);
});
