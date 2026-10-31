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
