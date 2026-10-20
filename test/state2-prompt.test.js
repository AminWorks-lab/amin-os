import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDataPrompt, buildUpdateRules, STATE2_ROOTS } from '../apps/linkage/prompt.js';
import { KEY, emptyLinkageState } from '../apps/linkage/policy.js';
import { rollBatch } from '../apps/dice/engine.js';
import { appendSnapshot, emptyStore } from '../apps/characters/model.js';
import * as Journal from '../apps/journal/model.js';

const flags = (read = true, write = true) => ({ enabled: true, read, write });
function fixture() {
    const world = { 版本: 1, 项目: { HK416: { 心智状态: '稳定' }, 德尔: { 当前状态: '观察中' } } };
    return {
        chat: [{ is_user: true, name: '玩家', mes: '继续剧情', swipe_id: 0 }],
        chatMetadata: {
            variables: { 状态栏: JSON.stringify(world), LWB_STATE_ERRORS: '- 状态栏.项目.HK416.心智状态: 类型不符\n- 私人变量.密码: 错误' },
            [KEY]: { ...emptyLinkageState(), enabled: true, modules: { status: flags(), dice: flags(true, false) } },
        },
        extensionSettings: {},
    };
}

test('legacy-shaped chats get the same amin_update protocol; State 2.0 <state> rules are gone', () => {
    const ctx = fixture();
    const rules = buildUpdateRules(ctx);
    assert.match(rules, /<amin_update>/);
    assert.match(rules, /module:status/);
    assert.doesNotMatch(rules, /状态栏\.项目\.示例人物|根变量|LWB_STATE_ERRORS|module:dice/);
    assert.doesNotMatch(rules, /观察中|类型不符|私人变量/);
    assert.equal(buildUpdateRules(ctx, { purpose: 'tool' }), '');
    ctx.chatMetadata[KEY].modules.status.write = false;
    assert.equal(buildUpdateRules(ctx), '');
});

test('message data includes native roots and real visible indices without revealing other rolls', () => {
    const ctx = fixture(), batch = rollBatch({ formula: '1d20' }, () => 14);
    const record = (id, text) => ({ id, createdAt: 1, settings: batch.settings, results: batch.results, status: 'sent', text, rerollOf: null });
    const hidden = record('hidden', 'PRIVATE_ROLL');
    hidden.sent = { messageIndex: 0, messageText: '另一个分支', at: 1 };
    const shown = record('shown', 'VISIBLE_ROLL');
    ctx.chat[0].mes += '\nVISIBLE_ROLL';
    shown.sent = { messageIndex: 0, messageText: ctx.chat[0].mes, at: 1 };
    const history = { version: 1, rolls: [hidden, shown] };
    ctx.chatMetadata.amin_os_dice_v1 = history;
    ctx.chatMetadata.variables.AminOS骰子 = JSON.stringify(history);
    const data = buildDataPrompt(ctx);
    assert.match(data, /"root":"状态栏"/);
    assert.match(data, /"root":"AminOS骰子"/);
    assert.match(data, /"rootFields":\["version","rolls"\]/);
    assert.match(data, /"id":"dice:shown","path":"AminOS骰子\.rolls\[1\]"/);
    assert.match(data, /VISIBLE_ROLL|状态栏\.项目\.HK416\.心智状态/);
    assert.match(data, /状态栏\.项目\.HK416\.心智状态: 类型不符/);
    assert.doesNotMatch(data, /PRIVATE_ROLL|"id":"dice:hidden"|私人变量/);
    assert.doesNotMatch(data, /amin_update|更新规则/);
});

test('root names cover every linked app and legacy data remains readable before migration', () => {
    assert.deepEqual(Object.keys(STATE2_ROOTS).sort(), ['characters', 'dice', 'effects', 'information', 'inventory', 'journal', 'map', 'organizations', 'relationships', 'scene', 'status'].sort());
    const ctx = fixture();
    ctx.chatMetadata.amin_os_characters_v1 = appendSnapshot(emptyStore(), ctx.chat,
        { version: 1, characters: [{ id: 'alice', name: '艾琳', kind: 'pc', notes: '', stats: [] }] },
        { id: 'seed', at: '2026-09-24T00:00:00.000Z' });
    ctx.chatMetadata[KEY].modules.characters = flags();
    const data = buildDataPrompt(ctx);
    assert.match(data, /"characters":\{"root":"AminOS人物","available":false/);
    assert.match(data, /"name":"艾琳"/);
    ctx.chatMetadata[KEY].enabled = false;
    assert.equal(buildDataPrompt(ctx), '');
    assert.equal(buildUpdateRules(ctx), '');
});

test('journal path mapping keeps canonical index after private entries are filtered', () => {
    const ctx = fixture();
    const source = Journal.sourceFromRange(ctx.chat, 0, 0);
    let store = Journal.empty();
    store = Journal.change(store, ctx.chat, 'create', { id: 'hidden', kind: 'fact', title: 'PRIVATE_FACT', body: '仅供本地核对', enabled: false, sources: source }, 'hidden-op');
    store = Journal.change(store, ctx.chat, 'create', { id: 'shown', kind: 'fact', title: '公开事实', body: '门已经打开', enabled: true, sources: source }, 'shown-op');
    ctx.chatMetadata[Journal.KEY] = store;
    const snapshot = Journal.snapshotJournal(store, ctx.chat);
    ctx.chatMetadata.variables.AminOS剧情 = JSON.stringify({ version: 1, entries: snapshot.entries, drafts: snapshot.drafts ?? [] });
    ctx.chatMetadata[KEY].modules.journal = flags();
    const data = buildDataPrompt(ctx);
    assert.match(data, /"id":"journal:shown","path":"AminOS剧情\.entries\[1\]"/);
    assert.doesNotMatch(data, /"id":"journal:hidden","path"|PRIVATE_FACT/);
});

test('external data source suppresses Amin data injection while keeping the same update rules', () => {
    const ctx = fixture();
    const own = buildUpdateRules(ctx);
    ctx.chatMetadata[KEY].dataSource = 'external';
    assert.equal(buildDataPrompt(ctx), '');
    assert.equal(buildUpdateRules(ctx), own);
    assert.match(own, /<amin_update>/);
});
