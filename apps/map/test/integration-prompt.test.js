import test from 'node:test';
import assert from 'node:assert/strict';
import { mapIntegrationPrompt, LEGACY_MAP_INTEGRATION_PROMPT } from '../src/ui/integration-prompt.js';
import { createDemoDocument } from '../src/core/demo.js';
import { KEY, MODULES, emptyLinkageState } from '../../linkage/policy.js';
import { buildDataPrompt, buildUpdateRules } from '../../linkage/prompt.js';
import { parseUpdate } from '../../linkage/protocol.js';
import { createLinkageService } from '../../linkage/service.js';
import { adapter as mapAdapter } from '../../linkage/adapters/map.js';
import { STATE_KEY, emptyState, validateState } from '../../story-state/schema.js';
import { createStoryStateRuntime } from '../../story-state/runtime.js';

function fixture() {
    let saves = 0;
    const state = emptyState({ updatedAt: '2026-10-10T00:00:00.000Z' });
    state.modules.map = createDemoDocument();
    const ctx = { characterId: 1, getCurrentChatId: () => 'map-prompt', extensionSettings: {},
        chat: [{ is_user: true, mes: '起点' }], async saveMetadata() { saves++; },
        chatMetadata: { [STATE_KEY]: validateState(state), world_info: '用户世界书保持原样',
            variables: { 地图: '旧地图摘要', AminOS地图: '无效的旧地图' },
            [KEY]: { ...emptyLinkageState(), enabled: true, modules: Object.fromEntries(Object.keys(MODULES).map(id => [id,
                { enabled: id === 'map', read: id === 'map', write: id === 'map' }])) } } };
    return { ctx, get saves() { return saves; } };
}

test('legacy map copy prompt keeps its native worldbook protocol unchanged', () => {
    assert.equal(mapIntegrationPrompt({ chatMetadata: {} }), LEGACY_MAP_INTEGRATION_PROMPT);
    assert.match(LEGACY_MAP_INTEGRATION_PROMPT, /{{xbgetvar_yaml::地图}}/);
    assert.match(LEGACY_MAP_INTEGRATION_PROMPT, /才在 <state> 中完整写入/);
});

test('independent map preview uses actual shared context and typed rules without changing metadata or worldbooks', () => {
    const f = fixture(), before = JSON.stringify(f.ctx), prompt = mapIntegrationPrompt(f.ctx);
    assert.match(prompt, /无需复制到世界书/);
    assert.ok(prompt.includes(buildDataPrompt(f.ctx)));
    assert.ok(prompt.includes(buildUpdateRules(f.ctx)));
    assert.match(prompt, /module:map/);
    assert.match(prompt, /move-to\(mapId\)/);
    assert.match(prompt, /<amin_update>/);
    assert.match(prompt, /qingyun_sect/);
    assert.match(prompt, /青云宗/);
    assert.ok(!prompt.includes('才在 <state> 中完整写入'));
    assert.ok(!prompt.includes('地图移动请求:'));
    assert.ok(!prompt.includes('{{xbgetvar_yaml::地图}}'));
    assert.ok(!prompt.includes('旧地图摘要'));
    assert.ok(!prompt.includes('无效的旧地图'));
    assert.equal(JSON.stringify(f.ctx), before);
    assert.equal(f.saves, 0);
});

test('independent map preview does not grant disabled or read-only permissions', () => {
    const f = fixture(), policy = f.ctx.chatMetadata[KEY];
    policy.modules.map.write = false;
    let prompt = mapIntegrationPrompt(f.ctx);
    assert.match(prompt, /未授权模型更新地图/);
    assert.match(prompt, /青云宗/);
    assert.ok(!prompt.includes('module:map'));
    assert.ok(!prompt.includes('<amin_update>'));
    policy.modules.status = { enabled: true, read: true, write: true };
    prompt = mapIntegrationPrompt(f.ctx);
    assert.match(prompt, /module:status/);
    assert.ok(!prompt.includes('module:map'));
    policy.modules.map.read = false;
    prompt = mapIntegrationPrompt(f.ctx);
    assert.match(prompt, /未加入可读取的联动范围/);
    assert.ok(!prompt.includes('青云宗'));
    policy.enabled = false;
    assert.match(mapIntegrationPrompt(f.ctx), /统一联动未启用/);
});

test('independent map preview respects external sources and reports context errors without native fallback', () => {
    const f = fixture(), policy = f.ctx.chatMetadata[KEY];
    policy.dataSource = 'external';
    let prompt = mapIntegrationPrompt(f.ctx);
    assert.match(prompt, /Amin 不发送地图资料/);
    assert.ok(!prompt.includes('青云宗'));
    assert.ok(prompt.includes(buildUpdateRules(f.ctx)));
    policy.modules.map.write = 'invalid';
    prompt = mapIntegrationPrompt(f.ctx);
    assert.match(prompt, /联动预览暂不可用/);
    assert.ok(!prompt.includes('地图移动请求:'));
});

test('the map move advertised by independent preview parses and commits current canonical position once', async () => {
    const f = fixture(), get = () => f.ctx;
    const runtime = createStoryStateRuntime(get, { backups: { available: () => false,
        status: () => ({ available: false }), savePrevious: async () => {} } });
    const service = createLinkageService(get, { adapters: [mapAdapter] });
    const protectedData = JSON.stringify({ world_info: f.ctx.chatMetadata.world_info,
        variables: f.ctx.chatMetadata.variables, chat: f.ctx.chat });
    try {
        assert.match(mapIntegrationPrompt(f.ctx), /move-to\(mapId\)/);
        const update = parseUpdate('<amin_update>' + JSON.stringify({ version: 1, changes: [{ module: 'map',
            action: 'move-to', target: 'qingyun_sect', data: { mapId: 'world' }, reason: '正文中已到达青云宗' }] }) + '</amin_update>');
        service.stage(update);
        await service.confirm();
        assert.equal(f.ctx.chatMetadata[STATE_KEY].modules.map.maps.world.currentLocation, 'qingyun_sect');
        assert.equal(f.ctx.chatMetadata[STATE_KEY].revision, 1);
        assert.equal(f.saves, 1);
        assert.equal(f.ctx.chatMetadata.dynamicMapV1, undefined);
        assert.equal(f.ctx.chatMetadata.dynamicMapPositionHistoryV1, undefined);
        assert.equal(JSON.stringify({ world_info: f.ctx.chatMetadata.world_info,
            variables: f.ctx.chatMetadata.variables, chat: f.ctx.chat }), protectedData);
    } finally { service.dispose(); runtime.destroy(); }
});
