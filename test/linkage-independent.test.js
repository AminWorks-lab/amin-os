import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinkageService } from '../apps/linkage/service.js';
import { createLinkageHost, LINKAGE_UPDATE_PROMPT_KEY, LINKAGE_DATA_PROMPT_KEY } from '../apps/linkage/host.js';
import { KEY, MODULES, emptyLinkageState, compactLinkageReceipts, moduleAvailable, readLinkageSettings } from '../apps/linkage/policy.js';
import { buildDataPrompt, buildUpdateRules } from '../apps/linkage/prompt.js';
import { createStoryStateRuntime } from '../apps/story-state/runtime.js';
import { STATE_KEY, emptyState, validateState } from '../apps/story-state/schema.js';
import { adapter as characters } from '../apps/linkage/adapters/characters.js';
import { adapter as inventory } from '../apps/linkage/adapters/inventory.js';
import { adapter as status } from '../apps/linkage/adapters/status.js';
import { emptyState as emptyInventory } from '../apps/inventory/model.js';

const clone = value => structuredClone(value);
const change = (module, action, target, data) => ({ module, action, target, data, reason: '正文中已发生' });
const batch = (...changes) => ({ version: 1, changes });
const person = change('characters', 'create-character', '@new:alice', { name: '艾琳', kind: 'npc', stats: [], notes: '原名 @new:alice 不变' });
const potion = change('inventory', 'create-item', '@new:potion', { name: '药剂', ownerId: '@new:alice', quantity: 2, equipped: false, notes: '' });
const tagged = update => '普通正文照常保留。<amin_update>' + JSON.stringify(update) + '</amin_update>';

function fixture() {
    let active, saves = 0, fail = false, sequence = 0;
    const handlers = new Map(), prompts = new Map();
    const ctx = { characterId: 1, getCurrentChatId: () => 'current-chat', extensionSettings: {},
        chat: [{ is_user: true, name: 'user', mes: '起点' }],
        chatMetadata: { variables: { Foreign: 'native is unrelated' }, world_info: 'keep', apiSettings: { provider: 'keep' },
            [KEY]: { ...emptyLinkageState(), enabled: true, mode: 'auto', modules: Object.fromEntries(['characters','inventory','status'].map(id => [id,{ enabled:true,read:true,write:true }])) } },
        eventTypes: Object.fromEntries(['GENERATION_AFTER_COMMANDS','WORLDINFO_ENTRIES_LOADED','MESSAGE_RECEIVED','GENERATION_ENDED','GENERATION_STOPPED','CHAT_CHANGED'].map(name => [name,name])),
        eventSource: { on(name, callback) { const list = handlers.get(name) ?? []; list.push(callback); handlers.set(name,list); },
            removeListener(name,callback) { handlers.set(name,(handlers.get(name)??[]).filter(fn=>fn!==callback)); } },
        setExtensionPrompt(key, value, ...options) { prompts.set(key,{value,options}); },
        async saveMetadata() { saves++; if (fail) throw Error('disk offline'); },
    };
    const state = emptyState({updatedAt:'2026-10-10T00:00:00.000Z'});
    state.modules.characters = {version:1,characters:[]};
    state.modules.inventory = emptyInventory();
    state.modules.status = {版本:1,项目:{玩家:{生命:10}}};
    ctx.chatMetadata[STATE_KEY] = validateState(state);
    active = ctx;
    const get = () => active;
    const runtime = createStoryStateRuntime(get,{backups:{available:()=>false,status:()=>({available:false}),savePrevious:async()=>{}}});
    const api = createLinkageService(get,{adapters:[characters,inventory,status],createId:()=>`00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`});
    const protectedData = clone({variables:ctx.chatMetadata.variables,world_info:ctx.chatMetadata.world_info,apiSettings:ctx.chatMetadata.apiSettings});
    const resources = [];
    return {ctx,api,runtime,prompts,get,handlers,get saves(){return saves;},set fail(value){fail=value;},set active(value){active=value;},
        async emit(name,...args){for(const fn of [...handlers.get(name)??[]])await fn(...args);},
        host(){ const host = createLinkageHost(get,{captureGeneration:api.captureGeneration,collectReply:api.collectReply,
            cancelGeneration:api.cancelGeneration,buildPrompt:buildUpdateRules,buildDataPrompt,beforeGeneration:()=>runtime.prepareGeneration()});resources.push(host);return host;},
        assertProtected(){ assert.deepEqual({variables:ctx.chatMetadata.variables,world_info:ctx.chatMetadata.world_info,apiSettings:ctx.chatMetadata.apiSettings},protectedData);
            for (const key of ['amin_os_characters_v1','amin_os_inventory_v1','world_status_hud_history_v1','LWB_RULES_V2','extensions']) assert.equal(ctx.chatMetadata[key],undefined); },
        dispose(){for(const host of resources)host.destroy();api.dispose();runtime.destroy();},
    };
}

test('independent automatic typed updates allocate NPC IDs and commit all modules once without native variables', async () => {
    const f = fixture();
    try {
        assert.equal(f.api.captureGeneration('normal'),true);
        const reply = {is_user:false,mes:tagged(batch(person,potion)),swipe_id:0};
        f.ctx.chat.push(reply);
        await f.api.collectReply(1);
        const modules=f.ctx.chatMetadata[STATE_KEY].modules, alice=modules.characters.characters[0], item=modules.inventory.items[0];
        assert.match(alice.id,/^e_[0-9a-f-]{36}$/);assert.notEqual(alice.id,'@new:alice');
        assert.equal(item.ownerId,alice.id);assert.equal(alice.notes,person.data.notes);
        assert.equal(f.saves,1);assert.equal(f.ctx.chatMetadata[STATE_KEY].revision,1);
        assert.equal(f.ctx.chat[1],reply);assert.equal(reply.mes,tagged(batch(person,potion)));
        assert.equal(await f.api.collectReply(1),null);assert.equal(f.saves,1);f.assertProtected();
    } finally {f.dispose();}
});

test('independent batch rejects AI persisted IDs and skips an invalid or unwritable change without mutation', () => {
    const f=fixture();
    try {
        const before=clone(f.ctx.chatMetadata);
        assert.throws(()=>f.api.stage(batch({...person,target:'ai_picked_id'})),/临时|别名|插件/);
        let preview=f.api.stage(batch(person,{...potion,data:{...potion.data,ownerId:'missing'}}));
        assert.equal(preview.changes.length,1);assert.match(preview.skipped[0].reason,/人物|持有/);f.api.discard();
        f.ctx.chatMetadata[KEY].modules.inventory.write=false;
        const noPermission=clone(f.ctx.chatMetadata);
        preview=f.api.stage(batch(person,potion));assert.match(preview.skipped[0].reason,/更新范围/);f.api.discard();
        assert.throws(()=>f.api.stage(batch({...potion,data:{...potion.data,ownerId:'missing'}})),/更新范围/);
        assert.deepEqual(f.ctx.chatMetadata,noPermission);assert.equal(f.saves,0);
        f.ctx.chatMetadata[KEY].modules.inventory.write=true;assert.deepEqual(f.ctx.chatMetadata,before);f.assertProtected();
    } finally {f.dispose();}
});

test('independent failed save retries persistence only and compact receipt makes the source idempotent', async () => {
    const f=fixture();
    try {
        f.api.stage(batch(person,potion));f.fail=true;
        await assert.rejects(f.api.confirm(),/保存失败/);
        assert.equal(f.api.dirty(),true);const committed=clone(f.ctx.chatMetadata[STATE_KEY]);
        f.fail=false;await f.api.retrySave();assert.deepEqual(f.ctx.chatMetadata[STATE_KEY],committed);
        assert.equal(committed.modules.inventory.items[0].quantity,2);assert.equal(f.saves,2);
        assert.throws(()=>f.api.stage(batch(person,potion)),/已经应用/);
        const receipt=f.ctx.chatMetadata[KEY].applied[0];
        assert.deepEqual(receipt.changes,[]);assert.match(receipt.changesHash,/^sha256:/);
        assert.deepEqual(Object.keys(receipt.source).sort(),['identity','index','pathHash','swipe','textHash']);f.assertProtected();
    } finally {f.dispose();}
});

test('independent successful updates keep exactly 64 compact receipts and never retain source prose in them', async () => {
    const f=fixture();
    try {
        for(let i=0;i<70;i++){
            f.ctx.chat.push({is_user:false,mes:`long-original-prose-${i}`.repeat(500),swipe_id:0});
            f.api.stage(batch(change('status','set','玩家.生命',{value:i})));await f.api.confirm();
        }
        const receipts=f.ctx.chatMetadata[KEY].applied;
        assert.equal(receipts.length,64);assert.equal(receipts[0].source.index,7);
        assert.ok(JSON.stringify(receipts).length<35000);assert.ok(!JSON.stringify(receipts).includes('long-original-prose'));
        assert.equal(f.ctx.chatMetadata[STATE_KEY].modules.status.项目.玩家.生命,69);f.assertProtected();
    } finally {f.dispose();}
});

test('independent model prompt has writable contracts, typed data, and no native engine requirement', () => {
    const f=fixture();
    try {
        const rules=buildUpdateRules(f.ctx),data=buildDataPrompt(f.ctx);
        assert.match(rules,/<amin_update>/);assert.match(rules,/@new:/);assert.match(rules,/UUID/);
        assert.ok(!rules.includes('请输出 <state>'));assert.match(data,/当前剧情资料/);
        assert.ok(!data.includes('nativeVariables'));assert.ok(!data.includes('native is unrelated'));
        f.ctx.chatMetadata[KEY].modules.inventory.write=false;
        assert.ok(!buildUpdateRules(f.ctx).includes('create-item'));f.assertProtected();
    } finally {f.dispose();}
});

test('independent host captures after user input and updates without worldbook activation or LWB events', async () => {
    const f=fixture(),host=f.host();
    try {
        assert.equal(host.status().supported,true);
        await f.emit('GENERATION_AFTER_COMMANDS','normal',{},false);
        f.ctx.chat.push({is_user:true,mes:'她获得药剂'});
        await f.emit('WORLDINFO_ENTRIES_LOADED',{characterLore:[],globalLore:[]});
        const update=f.prompts.get(LINKAGE_UPDATE_PROMPT_KEY),data=f.prompts.get(LINKAGE_DATA_PROMPT_KEY);
        assert.match(update.value,/<amin_update>/);assert.equal(update.options.at(-1)(),true);assert.equal(data.options.at(-1)(),true);
        f.ctx.chat.push({is_user:false,mes:tagged(batch(person,potion)),swipe_id:0,gen_finished:'done'});
        await f.emit('MESSAGE_RECEIVED',2);await f.emit('GENERATION_ENDED');
        await new Promise(resolve=>setTimeout(resolve,25));
        assert.equal(f.saves,1);assert.equal(f.ctx.chatMetadata[STATE_KEY].modules.characters.characters.length,1);f.assertProtected();
    } finally {f.dispose();}
});

test('independent stopped, stale and cross-chat generations never write typed state', async () => {
    const f=fixture(),host=f.host();
    try {
        await f.emit('GENERATION_AFTER_COMMANDS','normal',{},false);await f.emit('WORLDINFO_ENTRIES_LOADED',{});
        f.ctx.chat.push({is_user:false,mes:tagged(batch(person)),swipe_id:0});
        await f.emit('MESSAGE_RECEIVED',1);await f.emit('GENERATION_ENDED');await f.emit('GENERATION_STOPPED');
        await new Promise(resolve=>setTimeout(resolve,25));assert.equal(f.saves,0);
        assert.equal(f.prompts.get(LINKAGE_UPDATE_PROMPT_KEY).value,'');
        f.api.captureGeneration('normal');f.ctx.chat.push({is_user:false,mes:tagged(batch(person))});
        f.ctx.chatMetadata[STATE_KEY].modules.status.项目.玩家.生命=9;
        await f.api.collectReply(2);assert.equal(f.saves,0);assert.equal(f.ctx.chatMetadata[STATE_KEY].modules.characters.characters.length,0);
        f.api.captureGeneration('normal');f.active={...f.ctx,getCurrentChatId:()=> 'other',chatMetadata:clone(f.ctx.chatMetadata)};
        assert.equal(await f.api.collectReply(2),null);assert.equal(f.saves,0);f.assertProtected();
    } finally {f.dispose();}
});

test('uninitialized generation remains ordinary chat without legacy fallback or typed updates', async () => {
    const f=fixture();
    delete f.ctx.chatMetadata[STATE_KEY];
    // Legacy factory compatibility remains available to callers without a
    // readiness hook; the new application explicitly returns false here.
    f.ctx.eventTypes.WORLD_INFO_ACTIVATED='WORLD_INFO_ACTIVATED';
    const before=clone(f.ctx.chatMetadata),host=f.host();
    try {
        await f.emit('GENERATION_AFTER_COMMANDS','normal',{},false);
        assert.match(host.status().message,/尚未初始化/);
        assert.equal(host.status().active,false);
        assert.equal(f.prompts.get(LINKAGE_UPDATE_PROMPT_KEY).value,'');
        assert.equal(f.prompts.get(LINKAGE_DATA_PROMPT_KEY).value,'');
        await f.emit('WORLDINFO_ENTRIES_LOADED',{});
        f.ctx.chat.push({is_user:false,mes:'普通剧情正文',gen_finished:'done'});
        await f.emit('MESSAGE_RECEIVED',1);await f.emit('GENERATION_ENDED');
        await new Promise(resolve=>setTimeout(resolve,15));
        assert.equal(f.saves,0);assert.deepEqual(f.ctx.chatMetadata,before);
        assert.equal(f.ctx.chat[1].mes,'普通剧情正文');
    } finally {f.dispose();}
});

test('migration receipt compaction and settings saves preserve every non-receipt option and canonical module', async () => {
    const f=fixture();
    try {
        const settings=f.ctx.chatMetadata[KEY];
        settings.extraRules='保留手写规则';settings.dataSource='external';
        settings.contextBudget={enabled:false,maxChars:5000,requiredModules:['characters']};
        settings.links=[{id:'link',from:'characters:alice',to:'inventory:potion',label:'保留关联'}];
        settings.applied=Array.from({length:80},(_,i)=>({id:`old_${i}`,at:'2026-10-10T00:00:00.000Z',
            source:{identity:'old-chat',index:i,path:[`source-${i}`],text:'旧正文应保留在外置原件而非当前配置'.repeat(1000)},
            changes:[person],...(i===79?{archived:true}:{})}));
        const old=clone(settings),state=clone(f.ctx.chatMetadata[STATE_KEY]),compact=compactLinkageReceipts(settings);
        assert.deepEqual(settings,old);assert.equal(compact.applied.length,64);assert.equal(compact.applied[0].id,'old_16');
        assert.equal(compact.applied.at(-1).archived,true);assert.equal(compact.applied[0].source.swipe,0);
        assert.deepEqual({...compact,applied:[]},{...old,applied:[]});
        await f.api.saveSettings(settings);
        assert.deepEqual(f.ctx.chatMetadata[KEY],compact);assert.deepEqual(f.ctx.chatMetadata[STATE_KEY],state);
        assert.equal(f.saves,1);f.assertProtected();
    } finally {f.dispose();}
});

test('runtime empty initialization exposes every application and can generate the first NPC using saved user permissions', async () => {
    const f=fixture();
    try {
        delete f.ctx.chatMetadata[STATE_KEY];delete f.ctx.chatMetadata[KEY];
        await f.runtime.initializeEmpty();
        assert.ok(Object.values(f.ctx.chatMetadata[STATE_KEY].modules).every(module=>module===null));
        const original=f.ctx.chatMetadata[STATE_KEY];
        assert.equal(readLinkageSettings(f.ctx).enabled,false);
        for(const module of Object.keys(MODULES)) assert.equal(moduleAvailable(f.ctx,module),true,module);
        assert.equal(moduleAvailable(f.ctx,'unknown'),false);
        assert.equal(readLinkageSettings(f.ctx).modules.dice.write,false);
        const settings={...emptyLinkageState(),enabled:true,mode:'auto',modules:Object.fromEntries(Object.keys(MODULES).map(module=>[module,
            {enabled:module==='characters',read:module==='characters',write:module==='characters'}]))};
        await f.api.saveSettings(settings);
        assert.equal(f.ctx.chatMetadata[STATE_KEY],original);
        assert.equal(f.api.captureGeneration('normal'),true);
        f.ctx.chat.push({is_user:false,mes:tagged(batch(person)),swipe_id:0});
        await f.api.collectReply(1);
        const people=f.ctx.chatMetadata[STATE_KEY].modules.characters.characters;
        assert.equal(people.length,1);assert.match(people[0].id,/^e_[0-9a-f-]{36}$/);
        assert.equal(people[0].name,'艾琳');assert.equal(f.saves,3);
        for(const module of Object.keys(MODULES))assert.equal(moduleAvailable(f.ctx,module),true,module);
        assert.equal(readLinkageSettings(f.ctx).modules.inventory.enabled,false);f.assertProtected();
    } finally {f.dispose();}
});
