import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationService } from '../apps/generation/service.js';
import { repairChange } from '../apps/linkage/repair.js';
import { adapter as characters } from '../apps/linkage/adapters/characters.js';
const change=(action,target,data)=>({module:'characters',action,target,data,reason:'世界书角色绑定说明'});
function setup(initial) {
    let changes=initial;
    const ctx={chat:[{name:'玩家',is_user:true,mes:'开场'}],chatMetadata:{},getCurrentChatId:()=>'generation',saveMetadata:async()=>{}};
    const api=createGenerationService(()=>ctx,{ai:{capture:route=>({route}),async generate(){return JSON.stringify({version:1,changes});}},collectSources:async()=>({text:'世界书',provenance:{chat:{start:0,end:0,indices:[0]}}})});
    return {ctx,api,set changes(v){changes=v;}};
}
const options={modules:['characters'],mode:'create',sources:{includeChat:true,start:0,end:0}};

test('generation folds worldbook-only character attributes into notes instead of failing the draft',async()=>{
    const t=setup([change('create-character','kita',{id:'kita',name:'喜多郁代',kind:'npc',age:16,personality:'开朗',tags:['吉他','结束乐队'],hairstyle:'红色侧马尾',appearance:{description:'高中生',eyes:'绿色'}})]);
    try {
        const draft=await t.api.generate(options);
        const data=draft.changes[0].data;
        assert.deepEqual(Object.keys(data).sort(),['appearance','kind','name','notes']);
        assert.equal(data.appearance.hairstyle,'红色侧马尾');assert.equal(data.appearance.description,'高中生');
        assert.match(data.notes,/age：16/);assert.match(data.notes,/personality：开朗/);assert.match(data.notes,/tags：吉他、结束乐队/);assert.match(data.notes,/外观·eyes：绿色/);
        assert.ok(draft.warnings.some(w=>/已并入备注/.test(w)));
        t.api.stage(draft.changes);await t.api.confirm();
        assert.equal(characters.read(t.ctx).characters[0].name,'喜多郁代');
    } finally { t.api.dispose(); }
});
test('supplement never rewrites populated notes when folding extra fields',async()=>{
    const t=setup([change('create-character','kita',{name:'喜多郁代',kind:'npc',notes:'吉他手'})]);
    try {
        await t.api.generate(options);t.api.stage(t.api.draft().changes);await t.api.confirm();
        t.changes=[change('update-character','kita',{age:16,appearance:{hairstyle:'侧马尾'}})];
        const draft=await t.api.generate({...options,mode:'supplement'});
        assert.deepEqual(draft.changes[0].data,{appearance:{hairstyle:'侧马尾'}});
        assert.ok(draft.warnings.some(w=>/age 不是该应用的字段，已忽略/.test(w)));
    } finally { t.api.dispose(); }
});
test('character repair flattens nested appearance and strips stat extras',()=>{
    const appearance=repairChange(change('update-appearance','kita',{appearance:{hairstyle:'侧马尾',eyes:'绿色'}}),{fold:true,previous:()=>({name:'喜多',appearance:{features:'小虎牙'}})});
    assert.deepEqual(appearance.change.data,{hairstyle:'侧马尾',features:'小虎牙\neyes：绿色'});
    const stats=repairChange(change('create-character','@new:kita',{name:'喜多',kind:'npc',stats:[{id:'@new:hp',label:'体力',binding:'人物.体力',component:'current',value:8,max:10}]}));
    assert.deepEqual(stats.change.data.stats,[{id:'@new:hp',label:'体力',binding:'人物.体力',component:'current',check:'none'}]);
    assert.ok(stats.notes.some(note=>/stats\.value、stats\.max 不是该应用的字段，已忽略/.test(note)));
});
test('character adapter names the unsupported field',()=>{
    const ctx={chat:[],chatMetadata:{},getCurrentChatId:()=>'c'};
    assert.throws(()=>characters.apply(ctx,change('create-character','kita',{name:'喜多',kind:'npc',age:16}),{operationId:'op',now:'2026-10-21T00:00:00Z'}),/不支持的字段：age。/);
});
