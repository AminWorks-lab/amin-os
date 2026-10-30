import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationService, repairSourceRanges } from '../apps/generation/service.js';
import { adapter as characters } from '../apps/linkage/adapters/characters.js';
import { adapter as inventory } from '../apps/linkage/adapters/inventory.js';
const change=(module,action,target,data)=>({module,action,target,data,reason:'所选设定明确说明'});
const person=change('characters','create-character','alice',{name:'艾琳',kind:'npc',notes:''});
const item=change('inventory','create-item','potion',{name:'药水',ownerId:'alice',quantity:2});
function setup(initial=[person,item]) {
    let changes=initial,saves=0,fail=false,sourceText='选定来源',callback=null;
    const ctx={chat:[{name:'玩家',is_user:true,mes:'艾琳有两瓶药水。'}],chatMetadata:{},getCurrentChatId:()=> 'generation',saveMetadata:async()=>{saves++;if(fail)throw Error('offline');}};
    const calls=[];
    const api=createGenerationService(()=>ctx,{ai:{capture:route=>({route}),async generate(...args){calls.push(args);await callback?.();return JSON.stringify({version:1,changes});}},collectSources:async()=>({text:sourceText,provenance:{chat:ctx.chat.length?{start:0,end:0,indices:[0]}:null}})});
    return {ctx,api,calls,get saves(){return saves;},set fail(v){fail=v;},set changes(v){changes=v;},set source(v){sourceText=v;},set callback(v){callback=v;}};
}
const options={modules:['characters','inventory'],mode:'create',sources:{includeChat:true,start:0,end:0}};

test('journal AI generation accepts linked tasks and clues without awarding rewards', async () => {
    const t=setup([
        change('journal','set_task','task-one',{title:'调查信件',body:'寻找寄信人',goal:'确认寄信人',reward:'一瓶药水',sourceStart:0,sourceEnd:0}),
        change('journal','set_clue','clue-one',{title:'署名',body:'信尾有署名',taskId:'task-one',source:'所选楼层',confidence:50,sourceStart:0,sourceEnd:0}),
    ]);
    try {
        const draft=await t.api.generate({...options,modules:['journal']});t.api.stage(draft.changes);await t.api.confirm();
        assert.equal(t.saves,1);assert.equal(inventory.read(t.ctx).items.length,0);
        const snapshots=t.ctx.chatMetadata.amin_os_journal_v1.events;
        assert.ok(snapshots.length>=2);
    } finally { t.api.dispose(); }
});
test('joint generation and preview stay read-only then commit once with master off',async()=>{
    const t=setup();const draft=await t.api.generate(options);assert.deepEqual(t.ctx.chatMetadata,{});assert.equal(t.saves,0);
    t.api.stage(draft.changes);assert.deepEqual(t.ctx.chatMetadata,{});await t.api.confirm();
    assert.equal(t.saves,1);assert.equal(inventory.read(t.ctx).items[0].ownerId,'alice');assert.equal(t.ctx.chatMetadata.amin_os_linkage_v1.enabled,false);
    assert.equal(t.calls[0][3].includeLinkage,false);assert.equal(t.calls[0][3].snapshot.route,'linkage');t.api.dispose();
});
test('supplement rejects overwriting populated values but permits filling notes',async()=>{
    const t=setup([person]);await t.api.generate({...options,modules:['characters']});t.api.stage(t.api.draft().changes);await t.api.confirm();
    t.changes=[change('characters','save-character','alice',{name:'改名'})];
    await assert.rejects(t.api.generate({...options,modules:['characters'],mode:'supplement'}),/不能覆盖/);
    t.changes=[change('characters','save-character','alice',{notes:'补充背景'})];await t.api.generate({...options,modules:['characters'],mode:'supplement'});t.api.stage(t.api.draft().changes);await t.api.confirm();
    assert.equal(characters.read(t.ctx).characters[0].notes,'补充背景');t.api.dispose();
});
test('create refuses existing targets and source changes reject confirm without writes',async()=>{
    const t=setup([person]);await t.api.generate({...options,modules:['characters']});t.api.stage(t.api.draft().changes);t.source='已编辑来源';await assert.rejects(t.api.confirm(),/来源已变化/);assert.deepEqual(t.ctx.chatMetadata,{});
    t.api.discard();await t.api.generate({...options,modules:['characters']});t.api.stage(t.api.draft().changes);await t.api.confirm();
    t.changes=[change('characters','save-character','alice',{notes:'修改'})];await assert.rejects(t.api.generate({...options,modules:['characters']}),/仅允许新增/);t.api.dispose();
});
test('unchecked module and spending cannot enter edited previews',async()=>{
    const t=setup([person]);await t.api.generate({...options,modules:['characters']});assert.throws(()=>t.api.stage([item]),/未选择/);assert.equal(t.api.preview(),null);
    t.changes=[person,item];await t.api.generate(options);assert.throws(()=>t.api.stage([person,item,change('inventory','consume-item','potion',{quantity:1})]),/不允许/);assert.deepEqual(t.ctx.chatMetadata,{});t.api.dispose();
});
test('dependency removal rejects the entire selected batch',async()=>{
    const t=setup();await t.api.generate(options);assert.throws(()=>t.api.stage([item]),/人物|持有/);assert.deepEqual(t.ctx.chatMetadata,{});t.api.dispose();
});
test('data changes while model runs reject stale draft',async()=>{
    const t=setup([person]);t.callback=()=>{t.ctx.chat[0].mes='新的正文';};await assert.rejects(t.api.generate(options),/已变化/);assert.equal(t.api.draft(),null);assert.equal(t.saves,0);t.api.dispose();
});
test('failed persistence retries without applying the changes twice',async()=>{
    const t=setup();await t.api.generate(options);t.api.stage(t.api.draft().changes);t.fail=true;await assert.rejects(t.api.confirm(),/offline/);assert.equal(t.api.dirty(),true);t.fail=false;await t.api.retrySave();assert.equal(inventory.read(t.ctx).items[0].quantity,2);assert.equal(t.ctx.chatMetadata.amin_os_linkage_v1.applied.length,1);assert.equal(t.saves,2);t.api.dispose();
});
test('empty chat skips journal while other modules initialize and journal sources stay bounded',async()=>{
    const t=setup([person]);t.ctx.chat=[];const draft=await t.api.generate({...options,modules:['characters','journal']});assert.deepEqual(draft.modules,['characters']);assert.equal(draft.warnings.length,1);t.api.stage(draft.changes);await t.api.confirm();
    await assert.rejects(t.api.generate({...options,modules:['journal']}),/真实聊天楼层/);t.api.dispose();
    const u=setup([change('journal','set_fact','fact',{title:'事实',body:'内容',sourceStart:1,sourceEnd:1})]);const fixed=await u.api.generate({...options,modules:['journal']});
    assert.equal(fixed.changes[0].data.sourceStart,0);assert.equal(fixed.changes[0].data.sourceEnd,0);assert.match(fixed.warnings.join(),/修正/);
    assert.throws(()=>u.api.stage([{...fixed.changes[0],data:{...fixed.changes[0].data,sourceStart:3,sourceEnd:3}}]),/超出/);u.api.dispose();
});
test('cancelled model result is never accepted even if provider ignores abort',async()=>{
    const t=setup([person]);t.callback=()=>t.api.cancel();await assert.rejects(t.api.generate(options),/已取消/);assert.equal(t.api.draft(),null);assert.equal(t.saves,0);t.api.dispose();
});
test('blank requests cannot invent sources and reference catalogs resolve existing people',async()=>{
    const t=setup([person]);await assert.rejects(t.api.generate({modules:['characters'],sources:{},instruction:' '}),/请选择资料来源/);assert.equal(t.calls.length,0);
    await t.api.generate({...options,modules:['characters']});t.api.stage(t.api.draft().changes);await t.api.confirm();t.changes=[item];
    await t.api.generate({...options,modules:['inventory']});const prompt=JSON.parse(t.calls.at(-1)[2].prompt);
    assert.deepEqual(prompt.references.characters,[{id:'alice',name:'艾琳'}]);assert.equal(prompt.existing.characters,undefined);t.api.dispose();
});
test('supplement preserves zero amounts and false equipment flags',async()=>{
    const t=setup([person,{...item,data:{...item.data,quantity:0}}]);await t.api.generate(options);t.api.stage(t.api.draft().changes);await t.api.confirm();
    t.changes=[change('inventory','save-item','potion',{quantity:2})];await assert.rejects(t.api.generate({...options,modules:['inventory'],mode:'supplement'}),/不能覆盖/);
    t.changes=[change('inventory','save-item','potion',{equipped:true})];await assert.rejects(t.api.generate({...options,modules:['inventory'],mode:'supplement'}),/不能覆盖|数量/);t.api.dispose();
});

test('model source ranges are shifted from floor numbers or clamped into the selected floors',()=>{
    const j=data=>({module:'journal',action:'set_fact',target:'f',data,reason:'r'}), idx=[4,5,6,7], w=[];
    const out=repairSourceRanges([j({sourceStart:5,sourceEnd:6}),j({sourceStart:6,sourceEnd:8}),j({sourceStart:2,sourceEnd:12}),j({sourceStart:20,sourceEnd:30}),j({}),j({sourceStart:'5'}),
        {module:'relationships',action:'x',target:'r',data:{sources:[5,8]},reason:'r'},{module:'relationships',action:'x',target:'r',data:{sources:[1,9]},reason:'r'}],idx,w);
    assert.deepEqual(out.slice(0,6).map(c=>[c.data.sourceStart,c.data.sourceEnd]),[[5,6],[5,7],[4,7],[4,7],[4,7],[5,5]]);
    assert.deepEqual(out[6].data.sources,[4,7]);assert.deepEqual(out[7].data.sources,[]);assert.equal(w.length,1);assert.match(w[0],/6 项.*第 5–8 楼/);
});
