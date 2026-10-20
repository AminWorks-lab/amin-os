import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelJSON } from '../ai/json.js';
import { parseUpdate } from '../apps/linkage/protocol.js';

test('plain, fenced and BOM-prefixed objects and arrays parse', () => {
    assert.deepEqual(parseModelJSON('{"a":1}'), { a: 1 });
    assert.deepEqual(parseModelJSON('﻿  [1,2]  '), [1, 2]);
    assert.deepEqual(parseModelJSON('```json\n{"a":[1,{"b":2}]}\n```'), { a: [1, { b: 2 }] });
    assert.deepEqual(parseModelJSON('```\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseModelJSON('```JSON {"a":1}```'), { a: 1 });
    assert.deepEqual(parseModelJSON('﻿```json\n﻿{"a":1}\n```'), { a: 1 });
});

test('explanatory text before and after the payload is ignored', () => {
    assert.deepEqual(parseModelJSON('好的，结果如下：\n{"version":1,"changes":[]}\n以上为最终输出。'), { version: 1, changes: [] });
    assert.deepEqual(parseModelJSON('说明 [注] 见下文。\n```json\n{"a":1}\n```\n完毕'), { a: 1 });
    assert.deepEqual(parseModelJSON('参考 [注一] 与 {备注}，结果：{"ok":true} 结束 (完)'), { ok: true });
});

test('brackets and escaped quotes inside strings do not affect matching', () => {
    const value = { text: '他说："}{][" 然后离开 \\ 了', nested: ['[', ']', '{"x":1}'] };
    assert.deepEqual(parseModelJSON('前言 ' + JSON.stringify(value) + ' 后记'), value);
    assert.deepEqual(parseModelJSON('结果：{"a":"\\"}\\"","b":"]"}'), { a: '"}"', b: ']' });
});

test('dangerous keys stay plain own properties for later validation', () => {
    const value = parseModelJSON('{"__proto__":{"polluted":true}}');
    assert.equal(Object.hasOwn(value, '__proto__'), true);
    assert.equal({}.polluted, undefined);
});

test('invalid, truncated and non-structured output throws a labeled Chinese error', () => {
    assert.throws(() => parseModelJSON('globalThis.polluted=true', { label: '测试结果' }), /^Error: 测试结果不是完整合法的 JSON（没有找到/);
    assert.throws(() => parseModelJSON('{"a":1', { label: '测试结果' }), /测试结果.*截断/);
    assert.throws(() => parseModelJSON('{"a":1}{', { label: '测试结果' }), /测试结果.*合法.*截断/);
    assert.throws(() => parseModelJSON('{"fields":[{"a":1}', { label: '地图' }), /地图.*截断/);
    assert.throws(() => parseModelJSON('{"a":[1,2}', { label: '地图' }), /不匹配/);
    assert.throws(() => parseModelJSON('{"a":1,}'), /模型输出不是完整合法的 JSON/);
    assert.throws(() => parseModelJSON('42'), /对象或数组/);
    assert.throws(() => parseModelJSON('', { label: '空结果' }), /空结果为空/);
    assert.throws(() => parseModelJSON(null, { label: '空结果' }), /空结果/);
});

test('linkage parseUpdate tolerates fences and surrounding text but keeps its validation', () => {
    const change = { module: 'characters', action: 'create-character', target: 'alice', data: { name: '艾琳' }, reason: '已经发生' };
    const body = JSON.stringify({ version: 1, changes: [change] });
    assert.deepEqual(parseUpdate('```json\n' + body + '\n```').changes, [change]);
    assert.deepEqual(parseUpdate('<amin_update>\n```json\n' + body + '\n```\n</amin_update>').changes, [change]);
    assert.deepEqual(parseUpdate('更新如下：' + body).changes, [change]);
    assert.throws(() => parseUpdate('```json\n{"version":1,"changes":[],"__proto__":{}}\n```'), /保护/);
    assert.throws(() => parseUpdate('没有更新'), /联动更新不是完整合法的 JSON/);
});
