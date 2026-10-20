import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequestBody } from '../ai/request-body.js';
import { generateText, createStructuredSupport, structuredChannel, validateApiSettings } from '../ai/transport.js';
import { createAI } from '../ai/service.js';
import { runTask } from '../ai/task.js';
import { updateSchema } from '../apps/linkage/contract.js';
import { RELATIONSHIP_SCHEMA } from '../apps/relationships/draft.js';
import { createGenerationService, generationSchema, GENERATION_MODULES } from '../apps/generation/service.js';
import { UPDATE_SPEC } from '../apps/relationships/updates.js';

const storage = () => { const items = new Map(); return { getItem: k => items.get(k) ?? null, setItem: (k, v) => items.set(k, v), removeItem: k => items.delete(k) }; };
const schema = { name: 'demo', schema: { type: 'object', properties: { version: { type: 'integer' } } } };
const config = { enabled: true, baseUrl: 'https://api.test/v1', model: 'm', structuredOutput: true };
const request = { systemPrompt: '只输出 JSON', prompt: '整理', schema };
const ok = content => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ choices: [{ message: { content } }] }), text: async () => '' });
const rejected = (status, message) => ({ ok: false, status, headers: { get: () => 'application/json' }, json: async () => ({ error: { message } }), text: async () => JSON.stringify({ error: { message } }) });
function endpoint(...responses) {
    const sent = [];
    return { sent, fetchImpl: async (url, init) => { sent.push(JSON.parse(init.body)); return responses.shift() ?? ok('{"version":1}'); } };
}

test('structured output is off by default and only adds response_format when the channel enables it', () => {
    assert.equal(validateApiSettings({}).structuredOutput, false);
    assert.throws(() => validateApiSettings({ structuredOutput: 'yes' }), /格式无效/);
    const body = buildRequestBody(validateApiSettings(config), request);
    assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'demo', schema: schema.schema, strict: false } });
    assert.equal(Object.hasOwn(buildRequestBody(validateApiSettings({ ...config, structuredOutput: false }), request), 'response_format'), false);
    assert.equal(Object.hasOwn(buildRequestBody(validateApiSettings(config), { ...request, schema: undefined }), 'response_format'), false);
    // A custom requestBody still wins: null deletes the field, an object replaces it.
    assert.equal(Object.hasOwn(buildRequestBody(validateApiSettings({ ...config, requestBody: '{"response_format":null}' }), request), 'response_format'), false);
    assert.deepEqual(buildRequestBody(validateApiSettings({ ...config, requestBody: '{"response_format":{"type":"json_object"}}' }), request).response_format, { type: 'json_object' });
    assert.throws(() => buildRequestBody(validateApiSettings(config), { ...request, schema: { name: 'bad name', schema: {} } }), /schema 名称/);
});

test('a 400 naming response_format drops the field, retries once and remembers the channel', async () => {
    const structured = createStructuredSupport(storage(), 'retry');
    const first = endpoint(rejected(400, "Unknown parameter: 'response_format'."), ok('{"version":1}'));
    assert.equal(await generateText({}, config, request, { fetchImpl: first.fetchImpl, structured }), '{"version":1}');
    assert.equal(first.sent.length, 2);
    assert.equal(first.sent[0].response_format.type, 'json_schema');
    assert.equal(Object.hasOwn(first.sent[1], 'response_format'), false);
    assert.deepEqual(first.sent[1].messages, first.sent[0].messages);
    assert.deepEqual(structured.list(), [structuredChannel(validateApiSettings(config))]);
    // Remembered: the next request to the same channel goes out without the field, once.
    const second = endpoint();
    await generateText({}, config, request, { fetchImpl: second.fetchImpl, structured });
    assert.equal(second.sent.length, 1); assert.equal(Object.hasOwn(second.sent[0], 'response_format'), false);
    // Another model on the same endpoint is a different channel.
    const other = endpoint();
    await generateText({}, { ...config, model: 'm2' }, request, { fetchImpl: other.fetchImpl, structured });
    assert.equal(other.sent[0].response_format.type, 'json_schema');
    structured.reset(); assert.deepEqual(structured.list(), []);
});

test('other failures are not retried, and the retry itself happens only once', async () => {
    const structured = createStructuredSupport(storage(), 'no-retry');
    const unrelated = endpoint(rejected(400, 'max_tokens too large'));
    await assert.rejects(generateText({}, config, request, { fetchImpl: unrelated.fetchImpl, structured }), /HTTP 400/);
    assert.equal(unrelated.sent.length, 1); assert.deepEqual(structured.list(), []);
    const server = endpoint(rejected(500, 'response_format failed'));
    await assert.rejects(generateText({}, config, request, { fetchImpl: server.fetchImpl, structured }), /HTTP 500/);
    assert.equal(server.sent.length, 1);
    const twice = endpoint(rejected(400, 'response_format unsupported'), rejected(400, 'response_format unsupported'));
    await assert.rejects(generateText({}, config, request, { fetchImpl: twice.fetchImpl, structured }), /HTTP 400/);
    assert.equal(twice.sent.length, 2);
    // Toggle off: no field, so a 400 mentioning it is not a reason to retry.
    const off = endpoint(rejected(400, 'response_format'));
    await assert.rejects(generateText({}, { ...config, structuredOutput: false }, request, { fetchImpl: off.fetchImpl, structured: createStructuredSupport(null, 'off') }), /HTTP 400/);
    assert.equal(off.sent.length, 1); assert.equal(Object.hasOwn(off.sent[0], 'response_format'), false);
});

test('the remembered channel list persists per namespace in local storage', () => {
    const store = storage(), a = createStructuredSupport(store, 'ns');
    a.mark('https://api.test/v1/chat/completions|m');
    assert.deepEqual(createStructuredSupport(store, 'ns').list(), ['https://api.test/v1/chat/completions|m']);
    assert.deepEqual(createStructuredSupport(store, 'other').list(), []);
    store.setItem('amin-os.ai-structured-unsupported:broken', '{');
    assert.deepEqual(createStructuredSupport(store, 'broken').list(), []);
});

test('service sends the schema only on the independent API channel', async () => {
    const sent = [], fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body)); return ok('{"version":1,"changes":[]}'); };
    const ai = createAI(storage(), 'structured-service', { resolveConnection: async c => c, fetchImpl });
    ai.settings.save({ ...ai.settings.snapshot(), ...config });
    await ai.generate('map', { chat: [], chatMetadata: {} }, request, { includeEffects: false });
    assert.equal(sent[0].response_format.json_schema.name, 'demo');
    assert.match(ai.previews()[0].text, /response_format=json_schema（demo）/);
    // Tavern routes build their own request: the schema never reaches the host.
    const calls = [], ctx = { chatId: 'chat', getCurrentChatId() { return this.chatId; }, chatMetadata: {}, chat: [{ mes: '开场' }], characterId: 0, mainApi: 'openai',
        eventSource: { on() {} }, eventTypes: {}, getPresetManager: () => ({ getSelectedPresetName: () => '剧情预设' }),
        generateQuietPrompt: async options => { calls.push(options); return 'quiet'; } };
    const host = createAI(storage(), 'structured-host', { getHostContext: () => ctx, resolveConnection: () => { throw Error('independent route reached'); } });
    host.settings.save({ ...host.settings.snapshot(), ...config });
    host.setRoute('map', { mode: 'tavern-current' });
    assert.equal(await host.generate('map', ctx, request), 'quiet');
    assert.doesNotMatch(JSON.stringify(calls), /json_schema|response_format/);
    // A disabled independent API falls back to the host's generateRaw without the schema.
    const raw = [];
    await generateText({ generateRaw: async value => { raw.push(value); return 'raw'; } }, {}, { ...request, messages: [{ role: 'system', content: 'a' }, { role: 'user', content: 'b' }] });
    assert.equal(Object.hasOwn(raw[0], 'schema'), false);
});

test('runTask forwards a schema only when given one', async () => {
    const requests = [], ai = { capture: () => ({}), generate: async (app, ctx, value) => { requests.push(value); return '{}'; } };
    await runTask('任务', { ai, ctx: {}, system: 's', payload: 'p', schema });
    await runTask('任务', { ai, ctx: {}, system: 's', payload: 'p' });
    assert.deepEqual(requests, [{ systemPrompt: 's', prompt: 'p', schema }, { systemPrompt: 's', prompt: 'p' }]);
});

test('update schemas are generated from adapter specs with canonical action names only', () => {
    const items = RELATIONSHIP_SCHEMA.schema.properties.changes.items;
    assert.equal(RELATIONSHIP_SCHEMA.name, 'relationship_suggestions');
    assert.deepEqual(items.properties.module.enum, ['relationships']);
    assert.deepEqual(items.properties.action.enum, ['save-relationship', 'delete-relationship']);
    assert.deepEqual(items.required, ['module', 'action', 'data', 'reason']);
    assert.equal(RELATIONSHIP_SCHEMA.schema.properties.changes.maxItems, 30);
    assert.throws(() => updateSchema('x', [{ id: 'relationships', spec: UPDATE_SPEC, actions: ['save'] }]), /未知操作：save/);
    assert.throws(() => updateSchema('x', [{ id: 'relationships', spec: UPDATE_SPEC, actions: ['nope'] }]), /未知操作/);
    assert.deepEqual(updateSchema('all', [{ id: 'relationships', spec: UPDATE_SPEC }]).schema.properties.changes.items.properties.action.enum, UPDATE_SPEC.actions.map(a => a.name));
    for (const id of GENERATION_MODULES) assert.equal(generationSchema([id]).name, `${id}_generation`);
    const joint = generationSchema(['characters', 'inventory']);
    assert.equal(joint.name, 'joint_generation');
    assert.deepEqual(joint.schema.properties.changes.items.anyOf.map(branch => branch.properties.module.enum[0]), ['characters', 'inventory']);
    assert.ok(joint.schema.properties.changes.items.anyOf[0].properties.action.enum.includes('create-character'));
});

test('joint initialization passes the schema for the modules it generates', async () => {
    const ctx = { chat: [{ name: '玩家', is_user: true, mes: '艾琳来了。' }], chatMetadata: {}, getCurrentChatId: () => 'g', saveMetadata: async () => {} };
    const calls = [];
    const api = createGenerationService(() => ctx, { ai: { capture: route => ({ route }), async generate(...args) { calls.push(args); return '{"version":1,"changes":[]}'; } },
        collectSources: async () => ({ text: '来源', provenance: { chat: { start: 0, end: 0, indices: [0] } } }) });
    try {
        await api.generate({ modules: ['characters', 'relationships'], mode: 'create', sources: { includeChat: true, start: 0, end: 0 } });
        assert.deepEqual(calls[0][2].schema, generationSchema(['characters', 'relationships']));
    } finally { api.dispose(); }
});
