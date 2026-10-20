import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExtractedTime, recentMessages, extractStoryTime, EXTRACT_TIME_TASK } from '../apps/scene/extract-time.js';
import { AI_APPS } from '../ai/service.js';

test('extracted time fills known fields and reports the missing ones', () => {
    const result = parseExtractedTime('```json\n{"found":true,"year":1024,"month":3,"day":null,"hour":18,"minute":30,"evidence":"黄昏时分","note":"按黄昏推断"}\n```');
    assert.deepEqual(result.clock, { year: 1024, month: 3, hour: 18, minute: 30 });
    assert.deepEqual(result.missing, ['day']);
    assert.equal(result.found, true);
    assert.equal(result.evidence, '黄昏时分');
    assert.equal(parseExtractedTime('{"found":false,"note":"没有时间"}').found, false);
    assert.equal(parseExtractedTime('{"year":null}').found, false, 'no field at all counts as not found');
    assert.throws(() => parseExtractedTime('{"month":13}'), /月超出范围/);
    assert.equal(parseExtractedTime('{"month":20}', { maxMonth: 24 }).clock.month, 20, 'custom calendars allow longer years');
    assert.throws(() => parseExtractedTime('{"hour":1.5}'), /时超出范围/);
});

test('only recent non-system messages are sent, newest kept within budget', () => {
    const chat = [{ mes: '旧', name: 'A' }, { mes: '系统', is_system: true }, { mes: '新'.repeat(20), name: 'B', is_user: true }];
    assert.deepEqual(recentMessages(chat).map(item => item.楼层), [1, 3]);
    assert.deepEqual(recentMessages(chat, { budget: 20 }).map(item => item.楼层), [3]);
    assert.deepEqual(recentMessages(chat, { limit: 1 }).map(item => item.楼层), [3]);
});

test('extraction runs as a scene task on the shared AI and returns the parsed form values', async () => {
    assert.ok(AI_APPS.find(app => app.id === 'scene').tasks.includes(EXTRACT_TIME_TASK));
    const requests = [];
    const ai = { capture: channel => ({ channel }), async generate(app, ctx, request, options) { requests.push({ app, request, options }); return '{"found":true,"year":3,"month":2,"day":1,"hour":7,"minute":5}'; } };
    const result = await extractStoryTime({ ai, ctx: { chat: [{ mes: '第三年二月初一清晨七点' }] }, current: { year: 1 } });
    assert.deepEqual(result.clock, { year: 3, month: 2, day: 1, hour: 7, minute: 5 });
    assert.equal(requests[0].app, EXTRACT_TIME_TASK);
    assert.equal(requests[0].options.snapshot.channel, 'scene');
    assert.equal(requests[0].options.includeScene, false);
    assert.match(requests[0].request.prompt, /第三年二月初一清晨七点/);
    await assert.rejects(extractStoryTime({ ai, ctx: { chat: [] } }), /没有可读取的正文/);
});
