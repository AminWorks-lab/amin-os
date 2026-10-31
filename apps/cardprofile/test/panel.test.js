import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfile, setOptions, validateProfile, USER_TOKEN } from '../model.js';
import { buildRules, checkItem, applyItem, describe, storyLine } from '../proposals.js';

const TEXT = '后藤一里=[\n基本信息:[\n*年龄: 15岁\n]\n性格:[\n*自信: 很低\n]\n]';
const make = () => createProfile({ avatar: 'b.png', cardName: '结束乐队', description: TEXT, hash: 'h' });

test('panel play is off by default and normal proposals keep working', () => {
    const profile = make();
    assert.equal(profile.panel, undefined);
    assert.doesNotMatch(buildRules([profile]), /角色面板/);
    assert.equal(checkItem(profile, { op: 'set', path: '性格/自信', value: '稍微高了一点', by: '山田凉' }, 'x').status, 'pending', 'by is ignored while panel play is off');
});

test('only listed editors may rewrite the panel, within their sections', () => {
    let profile = make();
    const personality = profile.current.children[1].id;
    profile = setOptions(profile, { panel: { on: true, editors: [{ name: USER_TOKEN, sections: [] }, { name: '山田凉', sections: [personality] }] } });
    validateProfile(profile);
    const rules = buildRules([profile], { user: '阿明' });
    assert.match(rules, /只有 阿明（全部）、山田凉（仅 性格） 能在剧情里改写它/);
    assert.match(rules, /"by":"改写者名字"/);
    const ok = checkItem(profile, { op: 'set', path: '性格/自信', value: '高', by: '山田凉' }, 'a', { user: '阿明' });
    assert.equal(ok.status, 'pending');
    assert.equal(describe(ok).title, '山田凉 改写：修改 性格 / 自信');
    assert.match(checkItem(profile, { op: 'set', path: '基本信息/年龄', value: '16岁', by: '山田凉' }, 'b', { user: '阿明' }).error, /只能改写后藤一里面板的 性格/);
    assert.match(checkItem(profile, { op: 'set', path: '性格/自信', value: '高', by: '伊地知虹夏' }, 'c', { user: '阿明' }).error, /没有改写后藤一里面板的权限/);
    assert.equal(checkItem(profile, { op: 'set', path: '基本信息/年龄', value: '16岁', by: '阿明' }, 'd', { user: '阿明' }).status, 'pending', '{{user}} resolves to the persona name');
    assert.equal(checkItem(profile, { op: 'set', path: '基本信息/年龄', value: '16岁' }, 'e', { user: '阿明' }).status, 'pending', 'natural changes need no editor');
    const applied = applyItem(profile, ok);
    assert.match(applied.history.at(-1).label, /^山田凉 改写面板：/);
    assert.throws(() => setOptions(profile, { panel: { editors: [{ name: ' ', sections: [] }] } }), /需要名字/);
});

test('story line for a rewrite made from the app', () => {
    assert.equal(storyLine({ by: '阿明', target: '后藤一里', path: ['性格', '自信'], before: '很低', after: '高' }), '【面板改写】阿明 把 后藤一里 面板上的 性格/自信 从“很低”改成了“高”');
});

test('让 AI 改 returns checked items and applies the chosen ones with the chosen rewriter', async () => {
    const { createCardProfileService } = await import('../service.js');
    const ctx = { chatMetadata: {}, chat: [], name1: '阿明', getCurrentChatId: () => 'c1', characters: [{ avatar: 'b.png', name: '后藤一里', description: TEXT }], characterId: 0, saveMetadata: async () => {} };
    const service = createCardProfileService(() => ctx, { notice() {} });
    await service.importCard('b.png');
    const asked = [];
    const ai = { capture: () => ({}), generate: async (app, c, request) => { asked.push(request); return '[{"op":"set","path":"性格/自信","value":"高了一点","by":"别人"},{"op":"add","path":"性格","key":"口头禅","value":"我会努力的"},{"op":"set","path":"没有","value":"x"}]'; } };
    const items = await service.askEdits('b.png', { request: '让她自信一点', by: '山田凉' }, { ai });
    assert.match(asked[0].prompt, /后藤一里=\[/); assert.match(asked[0].prompt, /让她自信一点/); assert.match(asked[0].prompt, /山田凉/);
    assert.deepEqual(items.map(item => [item.status, item.by]), [['pending', '山田凉'], ['pending', '山田凉'], ['invalid', '山田凉']]);
    assert.equal(ctx.chatMetadata.amin_os_card_profile_v1.profiles['b.png'].current.children[1].children[0].value, '很低', 'nothing is saved before applying');
    const done = await service.applyEdits('b.png', items.slice(0, 2));
    assert.deepEqual(done.map(item => item.names), [['性格', '自信'], ['性格']]);
    assert.match(service.rendered('b.png'), /\*自信: 高了一点/); assert.match(service.rendered('b.png'), /\*口头禅: 我会努力的/);
    assert.match(ctx.chatMetadata.amin_os_card_profile_v1.profiles['b.png'].history.at(-1).label, /^山田凉 改写面板/);
});

test('a path that starts with the copy name still resolves', async () => {
    const { resolvePath } = await import('../proposals.js');
    const profile = make();
    assert.equal(resolvePath(profile.current, '后藤一里/性格/自信').node.value, '很低');
    assert.equal(checkItem(profile, { op: 'add', path: '后藤一里/性格', key: '口头禅', value: '我会努力的' }, 'x').status, 'pending');
});

test('the rewrite manner goes into the rules and the story line', async () => {
    const { panelManner } = await import('../proposals.js');
    let profile = setOptions(make(), { panel: { on: true, editors: [{ name: USER_TOKEN, sections: [] }] } });
    assert.equal(panelManner(profile), '', 'left to the story by default');
    profile = setOptions(profile, { panel: { method: 'ability', methodText: '言灵', aware: 'unaware' } });
    assert.equal(profile.panel.editors.length, 1, 'editors are kept');
    assert.equal(panelManner(profile), '改写者使用能力「言灵」来改写；后藤一里 不会察觉，认为自己一直如此');
    assert.match(buildRules([profile], { user: '阿明' }), /改写方式：改写者使用能力「言灵」/);
    assert.match(storyLine({ by: '阿明', target: '后藤一里', path: ['性格', '自信'], before: '很低', after: '高', manner: panelManner(profile) }), /改成了“高”（改写者使用能力「言灵」来改写；/);
    assert.throws(() => setOptions(profile, { panel: { method: 'magic' } }), /改写方式无效/);
});

test('让 AI 改 defaults are remembered on the copy', () => {
    let profile = setOptions(make(), { ask: { by: '山田凉', story: false } });
    assert.deepEqual(profile.ask, { by: '山田凉', story: false });
    profile = setOptions(profile, { ask: { story: true } });
    assert.deepEqual(profile.ask, { by: '山田凉', story: true });
    assert.equal(setOptions(profile, { panel: { on: true, editors: [] } }).ask.by, '山田凉');
});

test('settings changed while the previous one is still saving are all kept', async () => {
    const { createCardProfileService } = await import('../service.js');
    const ctx = { chatMetadata: {}, chat: [], getCurrentChatId: () => 'c1', characters: [{ avatar: 'b.png', name: '后藤一里', description: TEXT }], characterId: 0,
        saveMetadata: () => new Promise(resolve => setTimeout(resolve, 30)) };
    const service = createCardProfileService(() => ctx, { notice() {} });
    await service.importCard('b.png');
    await service.options('b.png', { panel: { on: true, editors: [{ name: USER_TOKEN, sections: [] }] } });
    await Promise.all([service.options('b.png', { panel: { method: 'natural' } }), service.options('b.png', { panel: { aware: 'aware' } }), service.options('b.png', { ask: { by: '阿明' } })]);
    const panel = ctx.chatMetadata.amin_os_card_profile_v1.profiles['b.png'].panel;
    assert.equal(panel.method, 'natural'); assert.equal(panel.aware, 'aware');
    assert.equal(ctx.chatMetadata.amin_os_card_profile_v1.profiles['b.png'].ask.by, '阿明');
});

test('a path that skips the upper levels resolves when it is unambiguous', async () => {
    const { resolvePath } = await import('../proposals.js');
    const profile = createProfile({ avatar: 'x.png', cardName: '', description: '甲=[\n性格:[\n核心:[\n*简要描述: 安静\n]\n]\n关系:[\n友人:[\n*描述: 同学\n]\n家人:[\n*描述: 妹妹\n]\n]\n]', hash: 'h' });
    assert.equal(resolvePath(profile.current, '简要描述').node.value, '安静');
    assert.equal(resolvePath(profile.current, '核心/简要描述').path.length, 3);
    assert.throws(() => resolvePath(profile.current, '描述'), /多个地方/);
    assert.equal(resolvePath(profile.current, '家人/描述').node.value, '妹妹');
    assert.throws(() => resolvePath(profile.current, '没有这个'), /找不到“没有这个”/);
});

test('set on a group goes to its only (or 描述) field', () => {
    const profile = createProfile({ avatar: 'x.png', cardName: '', description: '甲=[\n关系:[\n关系一:[\n*对象: 乙\n*描述: 同学\n]\n关系二:[\n*描述: 邻居\n]\n关系三:[\n*对象: 丁\n*态度: 冷淡\n]\n]\n]', hash: 'h' });
    const one = checkItem(profile, { op: 'set', path: '关系/关系一', value: '挚友' }, 'a');
    assert.equal(one.status, 'pending'); assert.equal(one.path, '关系/关系一/描述'); assert.equal(one.before, '同学');
    assert.equal(checkItem(profile, { op: 'set', path: '关系/关系二', value: '朋友' }, 'b').path, '关系/关系二/描述');
    assert.match(checkItem(profile, { op: 'set', path: '关系/关系三', value: 'x' }, 'c').error, /里面有：对象、态度/);
    assert.match(applyItem(profile, one).current.children[0].children[0].children[1].value, /挚友/);
});

test('让 AI 改 defaults can be kept for the whole chat', async () => {
    const { createCardProfileService } = await import('../service.js');
    const ctx = { chatMetadata: {}, chat: [], getCurrentChatId: () => 'c1', characters: [{ avatar: 'b.png', name: '后藤一里', description: TEXT }], characterId: 0, saveMetadata: async () => {} };
    const service = createCardProfileService(() => ctx, { notice() {} });
    assert.equal(service.askDefaults(), null);
    await service.setAskDefaults({ by: '山田凉', story: false });
    assert.deepEqual(service.askDefaults(), { by: '山田凉', story: false });
});

test('panel settings can be copied to another copy, sections matched by name', async () => {
    const { transferPanel } = await import('../model.js');
    let a = make();
    a = setOptions(a, { panel: { on: true, editors: [{ name: '山田凉', sections: [a.current.children[1].id] }], method: 'natural', aware: 'aware' } });
    const b = createProfile({ avatar: 'k.png', cardName: '', description: '喜多=[\n外貌:[\n*发色: 红\n]\n性格:[\n*开朗: 是\n]\n]', hash: 'h' });
    const copied = transferPanel(a, b, { on: true });
    assert.deepEqual(copied.panel.editors, [{ name: '山田凉', sections: [b.current.children[1].id] }]);
    assert.equal(copied.panel.method, 'natural'); assert.equal(copied.panel.aware, 'aware'); assert.equal(copied.panel.on, true);
});
