import test from 'node:test';
import assert from 'node:assert/strict';
import { generateText } from '../ai/transport.js';

const config = { enabled: true, baseUrl: 'https://api.example.com/v1', model: 'm', timeoutSeconds: 30 };
const ok = text => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ choices: [{ message: { content: text } }] }) });
function visibility() {
    let count = 0, waits = 0;
    return { background() { count++; }, count: () => count, whenVisible: async () => { waits++; }, waits: () => waits };
}

test('a request cut off while the app was in the background is retried once in the foreground', async () => {
    const page = visibility(); let calls = 0;
    const fetchImpl = async () => { calls++; if (calls === 1) { page.background(); throw new TypeError('Failed to fetch'); } return ok('完成'); };
    assert.equal(await generateText({}, config, { prompt: '继续', systemPrompt: '规则' }, { fetchImpl, visibility: page }), '完成');
    assert.equal(calls, 2); assert.equal(page.waits(), 1);
});
test('a second background failure explains the cause instead of blaming CORS', async () => {
    const page = visibility();
    const fetchImpl = async () => { page.background(); throw new TypeError('Failed to fetch'); };
    await assert.rejects(generateText({}, config, { prompt: '继续', systemPrompt: '规则' }, { fetchImpl, visibility: page }), /切到后台.*保持在前台/);
});
test('a network error without going to the background is not retried', async () => {
    const page = visibility(); let calls = 0;
    const fetchImpl = async () => { calls++; throw new TypeError('Failed to fetch'); };
    await assert.rejects(generateText({}, config, { prompt: '继续', systemPrompt: '规则' }, { fetchImpl, visibility: page }), /跨域/);
    assert.equal(calls, 1);
});
