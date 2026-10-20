import test from 'node:test';
import assert from 'node:assert/strict';
import { runTask, retryNote } from '../ai/task.js';
import { parseModelJSON } from '../ai/json.js';

function provider(...responses) {
    const calls = [], captures = [];
    return {
        calls, captures,
        capture: app => { captures.push(app); return { app }; },
        generate: async (...args) => { calls.push(args); const next = responses.shift(); return typeof next === 'function' ? next() : next; },
    };
}
const parse = text => parseModelJSON(text, { label: '测试任务' });

test('runTask captures the channel once and forwards system, payload, snapshot and include flags', async () => {
    const ai = provider('```json\n{"ok":true}\n```'), ctx = { chat: [] };
    const result = await runTask('信息面板 · 模拟推演', { ai, ctx, channel: 'information', system: 'SYS', payload: { 目标: '甲' }, parse, include: { includeEffects: false } });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(ai.captures, ['information']);
    const [task, sentCtx, request, options] = ai.calls[0];
    assert.equal(task, '信息面板 · 模拟推演'); assert.equal(sentCtx, ctx);
    assert.equal(request.systemPrompt, 'SYS'); assert.deepEqual(JSON.parse(request.prompt), { 目标: '甲' });
    assert.equal(options.data.request, request.prompt); assert.deepEqual(options.snapshot, { app: 'information' }); assert.equal(options.includeEffects, false);
});

test('a parse failure retries exactly once with the error appended, reusing the captured route', async () => {
    const ai = provider('我无法给出 JSON', '{"ok":1}');
    assert.deepEqual(await runTask('势力概览', { ai, system: 'S', payload: 'REQUEST', parse }), { ok: 1 });
    assert.equal(ai.calls.length, 2); assert.equal(ai.captures.length, 1);
    const retry = ai.calls[1][2].prompt;
    assert.ok(retry.startsWith('REQUEST\n\n上次输出无法解析：测试任务不是完整合法的 JSON'));
    assert.match(retry, /请只输出合法 JSON。$/);
    assert.equal(ai.calls[1][3].data.request, retry); assert.equal(ai.calls[1][3].snapshot, ai.calls[0][3].snapshot);
    assert.equal(ai.calls[1][2].systemPrompt, 'S');
});

test('a second parse failure is thrown without a third request; retry can be disabled', async () => {
    const twice = provider('bad', 'still bad', '{"never":true}');
    await assert.rejects(runTask('势力概览', { ai: twice, payload: 'x', parse }), /测试任务不是完整合法的 JSON/);
    assert.equal(twice.calls.length, 2);
    const once = provider('bad', '{"never":true}');
    await assert.rejects(runTask('势力概览', { ai: once, payload: 'x', parse, retryOnParseError: false }), /测试任务/);
    assert.equal(once.calls.length, 1);
    const validation = provider('{"rows":1}', '{"rows":[]}');
    const rows = await runTask('势力概览', { ai: validation, payload: 'x', parse: text => { const v = parse(text); if (!Array.isArray(v.rows)) throw Error('评估列表格式错误'); return v; } });
    assert.deepEqual(rows, { rows: [] }); assert.match(validation.calls[1][2].prompt, /上次输出无法解析：评估列表格式错误/);
});

test('provider errors, empty output, cancellation and stale guards are never retried', async () => {
    const failing = provider(() => { throw Error('上下文超过模型限制'); });
    await assert.rejects(runTask('势力概览', { ai: failing, payload: 'x', parse }), /上下文超过/); assert.equal(failing.calls.length, 1);
    const empty = provider('   ');
    await assert.rejects(runTask('势力概览', { ai: empty, payload: 'x', parse, emptyMessage: '空内容，未写入' }), /空内容，未写入/); assert.equal(empty.calls.length, 1);
    const controller = new AbortController(), aborted = provider(() => { controller.abort(); return '{"late":true}'; });
    await assert.rejects(runTask('势力概览', { ai: aborted, payload: 'x', parse, signal: controller.signal, cancelled: () => Error('已取消推演') }), /已取消推演/);
    let stale = false; const guarded = provider(() => { stale = true; return 'bad'; });
    await assert.rejects(runTask('势力概览', { ai: guarded, payload: 'x', parse, check: () => { if (stale) throw Error('聊天已变化'); } }), /聊天已变化/);
    assert.equal(guarded.calls.length, 1);
    let second = false; const retryStale = provider('bad', () => { second = true; return '{"ok":true}'; });
    await assert.rejects(runTask('势力概览', { ai: retryStale, payload: 'x', parse, check: () => { if (second) throw Error('重试期间已变化'); } }), /重试期间已变化/);
});

test('a caller snapshot is used as-is and a missing provider fails clearly', async () => {
    const ai = provider('text');
    assert.equal(await runTask('剧情档案 · 编年史', { ai, payload: 'x', snapshot: { frozen: true } }), 'text');
    assert.deepEqual(ai.captures, []); assert.deepEqual(ai.calls[0][3].snapshot, { frozen: true });
    await assert.rejects(runTask('剧情档案 · 编年史', { ai: {}, payload: 'x' }), /共享 AI 尚未就绪/);
    assert.equal(retryNote(Error('E')), '上次输出无法解析：E，请只输出合法 JSON。');
});

test('without an initialized shared layer the host fallback sends the request unchanged through the shared transport', async () => {
    const { getAI, getAIOrHost } = await import('../ai/service.js');
    assert.equal(getAI(), undefined);
    const host = getAIOrHost(), seen = [], request = { systemPrompt: 'S', prompt: 'P', responseLength: 900, trimNames: false };
    assert.equal(host.capture('status'), null);
    assert.equal(await host.generate('世界状态', { generateRaw: async value => { seen.push(value); return 'ok'; } }, request, {}), 'ok');
    assert.deepEqual(seen, [request]);
    await assert.rejects(host.generate('世界状态', {}, request), /请配置酒馆模型/);
});
