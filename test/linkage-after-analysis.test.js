import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisRequest, analyzeTurn } from '../apps/linkage/analysis.js';
import { buildUpdateRules } from '../apps/linkage/prompt.js';
import { validateLinkageState, emptyLinkageState, KEY, MODULES } from '../apps/linkage/policy.js';
import { STATE_KEY } from '../apps/story-state/access.js';

function ctx(extra = {}) {
    const modules = Object.fromEntries(Object.keys(MODULES).map(id => [id, { enabled: true, read: true, write: id !== 'dice' }]));
    return { chat: [{ is_user: false, mes: '开场', name: 'A' }, { is_user: true, mes: '去地表看看', name: '玩家' }, { is_user: false, mes: '运输艇降落在冰原上。<amin_update>{"version":1,"changes":[]}</amin_update>', name: 'A' }],
        characters: [{ avatar: 'a.png', name: 'A' }], characterId: 0, extensionSettings: {},
        chatMetadata: { [STATE_KEY]: { version: 1, modules: {} }, [KEY]: { ...emptyLinkageState(), enabled: true, modules, generator: 'after', ...extra } } };
}

test('the generator setting is validated', () => {
    assert.equal(validateLinkageState({ ...emptyLinkageState(), generator: 'after' }).generator, 'after');
    assert.throws(() => validateLinkageState({ ...emptyLinkageState(), generator: 'later' }), /生成方式/);
});

test('analysis rules ask for the block only; the request carries the turn without old blocks', () => {
    const c = ctx();
    assert.match(buildUpdateRules(c, { analysis: true }), /只输出一个完整 <amin_update>JSON<\/amin_update>，不写正文/);
    assert.match(buildUpdateRules(c), /正常输出剧情正文/);
    const request = analysisRequest(c, 2);
    assert.match(request.system, /剧情记录员/);
    assert.match(request.payload, /【本轮用户输入】\n去地表看看/);
    assert.match(request.payload, /【本轮剧情正文】\n运输艇降落在冰原上。\n/);
    assert.doesNotMatch(request.payload, /amin_update>\{/);
    assert.match(request.payload, /【上一轮回复（仅供衔接，不要重复记录）】\n开场/);
});

test('analyzeTurn wraps a bare JSON answer and skips the extra data prompts', async () => {
    const calls = [];
    const ai = { capture: () => ({}), generate: async (app, c, request, options) => { calls.push({ app, options }); return '{"version":1,"changes":[]}'; } };
    const text = await analyzeTurn(ctx(), 2, { ai });
    assert.equal(text, '<amin_update>{"version":1,"changes":[]}</amin_update>');
    assert.equal(calls[0].app, '联动更新 · 回复后分析');
    assert.equal(calls[0].options.includeLinkage, false);
});
