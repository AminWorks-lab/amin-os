import test from 'node:test';
import assert from 'node:assert/strict';
import { generateText, validateApiSettings } from '../ai/transport.js';
import { HOST_ROUTE, relayPayload } from '../ai/host-relay.js';

const config = { enabled: true, baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'sk-own', timeoutSeconds: 30 };
const tt = { __TAURITAVERN__: { invoke: { safeInvoke() {} } } };
const json = (status, value) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => value, text: async () => JSON.stringify(value) });
const ok = text => json(200, { choices: [{ message: { content: text } }] });
const request = { prompt: '继续', systemPrompt: '规则' };
function recorder(answer) { const calls = []; return { calls, fetchImpl: async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return answer(calls.length, url); } }; }

test('in TauriTavern the independent API goes through the host generate route', async () => {
    const r = recorder(() => ok('完成'));
    assert.equal(await generateText({}, { ...config, requestBody: '{"temperature":0.6,"thinking":{"type":"enabled"}}' }, request, { fetchImpl: r.fetchImpl, host: tt }), '完成');
    assert.equal(r.calls.length, 1); const { url, init, body } = r.calls[0];
    assert.equal(url, HOST_ROUTE); assert.equal(init.headers.Authorization, undefined);
    assert.equal(body.chat_completion_source, 'custom'); assert.equal(body.custom_url, 'https://api.example.com/v1');
    assert.deepEqual(body.custom_include_headers, { Authorization: 'Bearer sk-own' });
    assert.equal(body.type, 'quiet'); assert.equal(body.model, 'm'); assert.equal(body.stream, false); assert.equal(body.messages.length, 2);
    assert.deepEqual(body.custom_include_body, { max_tokens: 4096, temperature: 0.6, thinking: { type: 'enabled' } });
});
test('outside TauriTavern, without a key, or with the option off the request is sent directly', async () => {
    for (const [c, host] of [[config, {}], [{ ...config, apiKey: '' }, tt], [{ ...config, hostRelay: false }, tt]]) {
        const r = recorder(() => ok('完成'));
        await generateText({}, c, request, { fetchImpl: r.fetchImpl, host });
        assert.equal(r.calls[0].url, 'https://api.example.com/v1/chat/completions');
    }
});
test('a host failure shows the message TT reports', async () => {
    const r = recorder(() => json(502, { error: { message: 'Upstream returned 401: invalid key' } }));
    await assert.rejects(generateText({}, config, request, { fetchImpl: r.fetchImpl, host: tt }), /经 TT 后台发送.*invalid key/);
});
test('a host that forbids custom endpoints falls back to the direct request', async () => {
    const r = recorder(n => n === 1 ? json(502, { error: { message: 'iOS policy disabled capability: llm.endpoint_overrides' } }) : ok('直连'));
    assert.equal(await generateText({}, config, request, { fetchImpl: r.fetchImpl, host: tt }), '直连');
    assert.equal(r.calls[1].url, 'https://api.example.com/v1/chat/completions'); assert.equal(r.calls[1].init.headers.Authorization, 'Bearer sk-own');
});
test('structured output rejected through the host is retried once without response_format', async () => {
    const r = recorder(n => n === 1 ? json(502, { error: { message: 'HTTP 400: unknown field response_format' } }) : ok('{"a":1}'));
    const schema = { name: 'x', schema: { type: 'object' } }, marks = [];
    const structured = { unsupported: () => false, mark: id => marks.push(id) };
    assert.equal(await generateText({}, { ...config, structuredOutput: true }, { ...request, schema }, { fetchImpl: r.fetchImpl, host: tt, structured }), '{"a":1}');
    assert.ok(r.calls[0].body.custom_include_body.response_format); assert.equal(r.calls[1].body.custom_include_body.response_format, undefined); assert.equal(marks.length, 1);
});
test('a stream error chunk from TT is an error, not model text', async () => {
    const frames = ['data: {"id":"tauritavern-error-chunk-1","choices":[{"delta":{"content":"[API Error]\\n额度不足"}}]}', 'data: [DONE]', ''].join('\n\n');
    const stream = () => ({ ok: true, status: 200, headers: { get: () => 'text/event-stream; charset=utf-8' }, body: new Response(frames).body });
    const r = recorder(stream);
    await assert.rejects(generateText({}, { ...config, stream: true }, request, { fetchImpl: r.fetchImpl, host: tt }), /后台发送）：额度不足$/);
    assert.equal(r.calls[0].body.stream, true);
});
test('hostRelay defaults on and must be a boolean', () => {
    assert.equal(validateApiSettings({}).hostRelay, true);
    assert.throws(() => validateApiSettings({ hostRelay: 'yes' }), /格式无效/);
    assert.equal(relayPayload({ apiKey: 'k' }, { model: 'm', messages: [], stream: true }, 'https://x.test/v1/chat/completions').custom_include_body, undefined);
});
test('a cancelled TT endpoint authorization is explained', async () => {
    const fetchImpl = async () => { throw new DOMException('The operation was aborted.', 'AbortError'); };
    await assert.rejects(generateText({}, config, request, { fetchImpl, host: tt }), /授权弹窗被取消/);
});
