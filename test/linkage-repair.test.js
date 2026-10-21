import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinkageService } from '../apps/linkage/service.js';
import { parseUpdate } from '../apps/linkage/protocol.js';
import { repairChange } from '../apps/linkage/repair.js';
import { emptyLinkageState, KEY } from '../apps/linkage/policy.js';
import { adapters } from '../apps/linkage/registry.js';
import { adapter as characters } from '../apps/linkage/adapters/characters.js';
import { adapter as inventory } from '../apps/linkage/adapters/inventory.js';
import { adapter as status } from '../apps/linkage/adapters/status.js';
import { adapter as relationships } from '../apps/linkage/adapters/relationships.js';

const modules = Object.fromEntries(['characters','inventory','status','relationships'].map(id => [id,{enabled:true,read:true,write:true}]));
const change = (module,action,target,data) => ({module,action,target,data,reason:'已经发生的剧情'});
const batch = (...changes) => ({version:1,changes});
function setup() {
    let id=0;
    const ctx={chat:[{name:'玩家',is_user:true,mes:'起点'}],chatMetadata:{variables:{状态栏:JSON.stringify({版本:1,项目:{玩家:{金币:10}}})},[KEY]:{...emptyLinkageState(),enabled:true,modules:structuredClone(modules)}},getCurrentChatId:()=>'chat',characterId:1,saveMetadata:async()=>{}};
    const api=createLinkageService(()=>ctx,{adapters:[characters,inventory,status,relationships],createId:()=>`test_${++id}`,now:()=>'2026-10-21T00:00:00.000Z'});
    return {ctx,api};
}
const alice = change('characters','create-character','alice',{name:'艾琳',kind:'pc',stats:[],notes:''});
const bob = change('characters','create-character','bob',{name:'鲍勃',kind:'npc',stats:[],notes:''});

test('per-turn inventory slips are repaired instead of voiding the batch',async()=>{
    const t=setup();
    t.api.stage(batch(alice,bob)); await t.api.confirm();
    const preview=t.api.stage(batch(
        {...change('inventory','create-item','potion',{id:'potion',name:'药剂',owner:'alice',count:3,description:'红色',rarity:'普通',category:''}),extra:'x'},
        change('inventory','consume-item','potion',{itemId:'potion',amount:1}),
        change('inventory','transfer-item','potion',{quantity:1,to:'bob',newId:'potion_b'}),
        change('inventory','create-balance','gold',{name:'金币',ownerId:'alice',value:5,currency:'枚'}),
        change('inventory','adjust-balance','gold',{change:-2}),
        change('status','adjust-field','玩家.金币',{amount:-1}),
        change('relationships','save-relationship','r1',{from:'alice',to:'bob',relation:'朋友',description:'同伴'}),
    ));
    await t.api.confirm();
    const state=inventory.read(t.ctx), potion=state.items.find(item=>item.id==='potion');
    assert.equal(potion.ownerId,'alice'); assert.equal(potion.quantity,1); assert.equal(potion.notes,'红色');
    assert.equal(state.items.find(item=>item.id==='potion_b').ownerId,'bob');
    assert.equal(state.balances[0].amount,3); assert.equal(state.balances[0].unit,'枚');
    assert.equal(status.read(t.ctx).项目.玩家.金币,9);
    assert.equal(relationships.read(t.ctx).relationships[0].type,'朋友');
    assert.ok(preview.warnings.some(w=>/rarity 不是该应用的字段，已忽略/.test(w)));
    assert.ok(preview.warnings.some(w=>/owner→ownerId/.test(w)));
    assert.ok(preview.warnings.some(w=>/外层多余字段 extra/.test(w)));
});
test('repair leaves valid payloads untouched for every adapter action',()=>{
    const samples=[alice,
        change('inventory','create-item','potion',{name:'药剂',ownerId:'alice',quantity:2,equipped:false,notes:'',wear:{slot:'',layer:'base'},condition:{wetness:0,dirt:0,damage:0}}),
        change('characters','save-stat','alice',{id:'hp',label:'体力',binding:'玩家.体力',component:'value',check:'none'}),
        change('relationships','save-rule','rule1',{relationshipId:'r1',operator:'gte',value:5,message:'好感',enabled:true,repeat:'once'}),
        change('journal','save-knowledge','k1',{factId:'f1',characterId:'alice',state:'known'}),
        change('scene','save-scene','s1',{name:'酒馆',participantIds:['alice'],notes:''}),
        change('effects','end-effect','e1',{}),
        change('status','set-field','玩家.金币',{value:3}),
    ];
    for (const sample of samples) {
        const result=repairChange(structuredClone(sample));
        assert.deepEqual(result.change,sample); assert.deepEqual(result.notes,[]);
    }
    for (const adapter of adapters.filter(a=>a.apply && a.id!=='dice')) for (const action of adapter.spec.actions) assert.ok(Array.isArray(adapter.dataFields(action.name)),`${adapter.id} ${action.name}`);
});
test('repair fills missing data, moves data.id to target and keeps reason fallbacks explicit',()=>{
    const parsed=parseUpdate(batch({module:'effects',action:'end-effect',target:'e1',reason:'解除'},{module:'character',action:'update-character',data:{id:'alice',notes:'补充'},summary:'剧情说明'}),{repair:true});
    assert.deepEqual(parsed.changes[0].data,{});
    assert.equal(parsed.changes[1].module,'characters'); assert.equal(parsed.changes[1].target,'alice'); assert.equal(parsed.changes[1].reason,'剧情说明');
    assert.throws(()=>parseUpdate(batch({module:'effects',action:'end-effect',target:'e1',reason:'解除'})),/data 格式无效/);
});
test('adapters name the rejected field',()=>{
    const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=>'c'}, opts={operationId:'op',now:'2026-10-21T00:00:00Z'};
    assert.throws(()=>inventory.apply(ctx,change('inventory','create-item','x',{name:'x',ownerId:'a',quantity:1,rarity:'普通'}),opts),/不支持的字段：rarity。/);
    assert.throws(()=>inventory.apply(ctx,change('inventory','add-item','x',{}),opts),/不支持此联动操作：add-item/);
    assert.throws(()=>status.apply(ctx,change('status','set-field','玩家.金币',{value:1,note:'x'}),opts),/未知字段或格式无效：note/);
});
