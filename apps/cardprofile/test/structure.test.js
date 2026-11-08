import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCard, writeCard } from '../format.js';
import { createProfile, normalizeProfile, validateProfile } from '../model.js';
import { checkItem, applyItem, undoItem, describe } from '../proposals.js';

const SOURCE = `伊地知虹夏=[
称呼: 虹夏
外貌=[
*发色: 金
]
时间线:[
事件: a
事件: b
]
]

背景=[
*背景1: 下北泽
]
关键词=[
关键词1: 鼓
]
备注文字`;

test('blocks after the root and 键=[ groups are read as sections and written back', () => {
    const tree = parseCard(SOURCE);
    assert.deepEqual(tree.children.map(node => [node.key, node.kind, !!node.block]), [['称呼', 'field', false], ['外貌', 'group', false], ['时间线', 'group', false], ['背景', 'group', true], ['关键词', 'group', true]]);
    assert.equal(tree.after, '备注文字');
    assert.equal(writeCard(tree), SOURCE.replace('\n\n背景', '\n背景'));
    assert.deepEqual(parseCard(writeCard(tree)), tree);
});

test('copies saved before the fix get their trailing blocks lifted with matching ids', () => {
    const profile = createProfile({ avatar: 'a', description: SOURCE, hash: 'h' });
    const old = structuredClone(profile);
    for (const tree of [old.baseline, old.current]) { tree.children = tree.children.filter(node => !node.block); tree.after = SOURCE.slice(SOURCE.indexOf('背景=[')); }
    old.nextId = 9;
    const lifted = validateProfile(normalizeProfile(old));
    assert.deepEqual(lifted.current.children.map(node => node.key), ['称呼', '外貌', '时间线', '背景', '关键词']);
    assert.deepEqual(lifted.baseline.children.map(node => node.id), lifted.current.children.map(node => node.id));
    assert.equal(lifted.current.after, '备注文字');
    assert.ok(lifted.nextId > 9);
});

test('add creates missing sections, set past the last duplicate adds a new entry', () => {
    let profile = createProfile({ avatar: 'a', description: SOURCE, hash: 'h' });
    const add = checkItem(profile, { op: 'add', path: '偏好/讨厌', key: '讨厌13', value: '早起' }, 'i1');
    assert.equal(add.status, 'pending');
    assert.deepEqual(add.create, ['偏好', '讨厌']);
    assert.match(describe(add).title, /新建分区 偏好 \/ 讨厌/);
    profile = applyItem(profile, add);
    assert.match(writeCard(profile.current), /偏好:\[\n讨厌:\[\n\*讨厌13: 早起\n\]\n\]/);
    profile = undoItem(profile, add);
    assert.doesNotMatch(writeCard(profile.current), /偏好/);
    const next = checkItem(profile, { op: 'set', path: '时间线/事件#7', value: 'c' }, 'i2');
    assert.deepEqual([next.status, next.op, next.path, next.key], ['pending', 'add', '时间线', '事件']);
    assert.equal(checkItem(profile, { op: 'set', path: '时间线/事件', value: 'c' }, 'i3').status, 'invalid', 'an ambiguous duplicate is not turned into an add');
    assert.equal(checkItem(profile, { op: 'set', path: '没有/这项', value: 'c' }, 'i4').status, 'invalid', 'set does not create sections');
    assert.equal(checkItem(profile, { op: 'set', path: '外貌/发色/深浅', value: 'c' }, 'i5').status, 'invalid', 'a field is not turned into a section');
});
