import test from 'node:test';
import assert from 'node:assert/strict';
import { createSavesService } from '../apps/saves/service.js';
import { KEY,LIMITS,parseImport,validateSnapshot } from '../apps/saves/model.js';
import { materialize } from '../apps/saves/adapters.js';
import * as Characters from '../apps/characters/model.js';
import * as Inventory from '../apps/inventory/model.js';
import * as Relations from '../apps/relationships/model.js';
import * as Scene from '../apps/scene/model.js';
import * as Effects from '../apps/effects/model.js';
import * as Journal from '../apps/journal/model.js';
import * as Info from '../apps/information/model.js';
import * as Org from '../apps/organizations/model.js';
import { createDemoDocument } from '../apps/map/src/core/demo.js';
import { rollBatch,formatRoll } from '../apps/dice/engine.js';
import { registerMapRuntime } from '../apps/map/src/integrations/runtime.js';
import * as Linkage from '../apps/linkage/policy.js';
import { chatIdentity, chatPath } from '../apps/shared/operations.js';
import { branchAvailability, assertOpenedBranch } from '../apps/saves/branch.js';

const at='2026-09-23T00:00:00.000Z';
function fixture({populated=true}={}){
    let writes=0,seq=0,fail=false;
    let ctx={chatId:'one',getCurrentChatId(){return this.chatId;},characterId:0,characters:[{avatar:'hero.png'}],chat:[{name:'玩家',is_user:true,mes:'进入旅店',swipe_id:0,extra:{dynamic_map_message_id:'map-message'}}],chatMetadata:{variables:{other:'KEEP'},unrelated:{nested:'PROTECTED'}},extensionSettings:{apiKey:'SECRET',theme:'keep'},async saveMetadata(){writes++;if(fail)throw Error('offline');}};
    if(populated){
        ctx.chatMetadata.variables.状态栏=JSON.stringify({版本:1,项目:{主角:{力量:3,生命:{当前:8,最大:10}}}});
        const chars={version:1,characters:[{id:'hero',name:'旅人',kind:'pc',notes:'人物资料',stats:[{id:'strength',label:'力量',binding:'主角.力量',component:'value',check:'d20'}]},{id:'innkeeper',name:'店主',kind:'npc',notes:'',stats:[]}]};
        ctx.chatMetadata[Characters.KEY]=Characters.buildRestore(ctx,chars,{id:'char-start',at});
        ctx.chatMetadata[Inventory.KEY]=Inventory.buildRestoreStore(ctx,{version:1,items:[{id:'potion',ownerId:'hero',name:'药剂',notes:'',quantity:3,equipped:false}],balances:[{id:'gold',ownerId:'hero',name:'金币',unit:'枚',notes:'',amount:12}],ledger:[]},{id:'inv-start',at});
        ctx.chatMetadata[Relations.KEY]=Relations.buildRestore(ctx,{version:1,relationships:[{id:'trust',fromId:'hero',toId:'innkeeper',type:'信任',label:'旅店熟客',notes:'',strength:2}],settings:{includeInContext:false}},{id:'rel-start',at});
        const state=Scene.emptyState();state.clock={year:2026,month:9,day:23,hour:8,minute:0,calendarLabel:''};state.scenes.room=Scene.validateScene({id:'room',name:'客房',participants:'旅人',weather:'晴'});state.activeSceneId='room';
        ctx.chatMetadata[Scene.KEY]=Scene.appendEvent(Scene.emptyStore(),ctx.chat,{state,op:'save-scene',reason:'起始场景',details:{}},{eventId:'scene-start',at});
        const effects={...Effects.empty(),skills:[{id:'focus',name:'专注',reminder:'对持有者生效',book:'',entryId:'',ui:{targetMode:'direct'}}]};
        ctx.chatMetadata[Effects.KEY]=Effects.change(effects,ctx.chat,'create',{skillId:'focus',holder:'旅人',targetMode:'direct',scope:'观察',condition:'10分钟',durationMinutes:10},{clock:state.clock});
        const record={id:'hook',kind:'hook',title:'约定',body:'店主约好再见',actors:['旅人'],gameTime:null,gameTimeText:'早晨',sourceNote:'',sources:Journal.sourceFromRange(ctx.chat,0,0),enabled:true,status:'open',remindAfter:3};
        ctx.chatMetadata[Journal.KEY]=Journal.change(Journal.empty(),ctx.chat,'create',record,'journal-start');
        const die=rollBatch({formula:'1d20'},()=>14),roll={id:'fixed',createdAt:1,settings:die.settings,results:die.results,status:'appended',rerollOf:null,pending:{chatKey:'old',firstIndex:1}};roll.text=formatRoll(roll);ctx.chatMetadata.amin_os_dice_v1={version:1,rolls:[roll]};
        ctx.chatMetadata.dynamicMapV1={updatedAt:1,document:createDemoDocument()};ctx.chatMetadata.dynamicMapPositionHistoryV1={records:{old:{mapId:'old',nodeId:'old'}},sequence:['map-message:0']};
        ctx.chatMetadata.variables[Org.ROOT]=JSON.stringify({...Org.empty(),summary:'商会控制市场'});ctx.chatMetadata.amin_os_organizations_v1={locks:[],assessment:null,backups:[{keep:true}],custom:'retain'};
        const info={id:'person',name:'店主',kind:'person',mode:'forward',fields:[{id:'occupation',category:'基本',label:'身份',value:'店主',status:'edited'}],baselineFields:[{id:'occupation',category:'基本',label:'身份',value:'守卫',status:'known'}]};
        ctx.chatMetadata[Info.KEY]=Info.apply(Info.empty(),ctx.chat,info);ctx.chatMetadata[Info.LIBRARY_KEY]=[{record:info,search:null,at}];
    }
    const api=createSavesService(()=>ctx,{createId:()=>`save-id-${++seq}`,now:()=>at});
    return {get ctx(){return ctx;},api,writes:()=>writes,fail:v=>{fail=v;},switch(){ctx={...ctx,chatId:'two',chat:[{name:'玩家',is_user:true,mes:'另一条剧情',swipe_id:0}],chatMetadata:{variables:{other:'NEW'},unrelated:{new:true}},extensionSettings:ctx.extensionSettings};return ctx;}};
}
async function save(h,name='旅店'){h.api.stageSave({name});await h.api.confirm();return h.api.read().saves.at(-1);}

test('old full-message save paths still validate and open the exact matching branch',async()=>{
    const h=fixture(),snapshot=structuredClone(await save(h));
    snapshot.source.path=h.ctx.chat.map(m=>JSON.stringify([m.name??'',!!m.is_user,m.mes??'',m.swipe_id??0]));
    delete snapshot.source.candidateBinding;
    assert.deepEqual(validateSnapshot(snapshot).source.path,snapshot.source.path);
    assert.equal(branchAvailability(h.ctx,snapshot).available,true);
    const branch={...h.ctx,chatId:'branch-chat',chat:structuredClone(h.ctx.chat)};
    assert.equal(assertOpenedBranch(branch,snapshot.source,'branch-chat'),branch);
    branch.chat[0].swipe_id=1;
    assert.equal(branchAvailability({...branch,chatId:'one'},snapshot).available,false);
    assert.throws(()=>assertOpenedBranch(branch,snapshot.source,'branch-chat'),/不一致/);
    h.api.dispose();
});

test('current materialized snapshots include all apps and exclude global settings and chat replacement',async()=>{
    const h=fixture(),metadata=structuredClone(h.ctx.chatMetadata),chat=structuredClone(h.ctx.chat),settings=structuredClone(h.ctx.extensionSettings);
    const preview=h.api.stageSave({name:'旅店',note:'上午'});assert.equal(h.ctx.chatMetadata[KEY],undefined);assert.equal(preview.summary.kind,'save');
    await h.api.confirm();const snapshot=h.api.read().saves[0],raw=h.api.exportSave(snapshot.id);
    assert.equal(h.writes(),1);assert.equal(Object.values(snapshot.modules).filter(v=>v!==null).length,12);
    assert.equal(snapshot.modules.characters.characters[0].stats[0].binding,'主角.力量');assert.equal(snapshot.modules.effects.effects.length,1);
    assert.equal(raw.includes('SECRET'),false);assert.equal(raw.includes('PROTECTED'),false);assert.equal(snapshot.modules.effects.skills,undefined);
    assert.deepEqual(h.ctx.chat,chat);assert.deepEqual(h.ctx.extensionSettings,settings);delete h.ctx.chatMetadata[KEY];assert.deepEqual(h.ctx.chatMetadata,metadata);h.api.dispose();
});
test('restore rebases every branch store to current tail, applies resources once and keeps unrelated metadata',async()=>{
    const h=fixture(),saved=await save(h),oldCharacterEvents=h.ctx.chatMetadata[Characters.KEY].events.length;
    h.ctx.chat.push({name:'角色',is_user:false,mes:'到达市场',swipe_id:0,extra:{dynamic_map_message_id:'map-next'}});
    const changed=Characters.readCharacters(h.ctx);changed.characters[0].name='后来名字';h.ctx.chatMetadata[Characters.KEY]=Characters.buildRestore(h.ctx,changed,{id:'future-char',at});
    h.ctx.chatMetadata.variables.状态栏=JSON.stringify({版本:1,项目:{主角:{力量:99,生命:{当前:1,最大:10}}}});
    const metadata=structuredClone(h.ctx.chatMetadata),chat=structuredClone(h.ctx.chat),settings=structuredClone(h.ctx.extensionSettings),beforeWrites=h.writes();
    const p=h.api.stageRestore(saved.id);assert.equal(p.summary.kind,'restore');assert.ok(p.summary.changes.some(c=>c.module==='status'));assert.deepEqual(h.ctx.chatMetadata,metadata);
    await h.api.confirm();assert.equal(h.writes(),beforeWrites+1);assert.equal(Characters.readCharacters(h.ctx).characters[0].name,'旅人');assert.equal(Characters.resolveStat(h.ctx,'hero','strength').value,3);
    assert.equal(h.ctx.chatMetadata[Characters.KEY].events.length,oldCharacterEvents+2);assert.deepEqual(h.ctx.chat,chat);assert.deepEqual(h.ctx.extensionSettings,settings);
    assert.equal(Inventory.readInventory(h.ctx).items[0].quantity,3);assert.equal(Inventory.readInventory(h.ctx).balances[0].amount,12);assert.deepEqual(Inventory.readInventory(h.ctx).ledger,saved.modules.inventory.ledger);assert.equal(h.ctx.chatMetadata[Inventory.KEY].events.at(-1).op,'restore');
    assert.equal(Scene.readCurrentScene(h.ctx).clock.hour,8);assert.equal(Effects.activeEffects(h.ctx.chatMetadata[Effects.KEY],h.ctx.chat).length,1);
    assert.equal(h.ctx.chatMetadata.amin_os_dice_v1.rolls[0].status,'rolled');assert.equal(h.ctx.chatMetadata.amin_os_dice_v1.rolls[0].pending,undefined);
    assert.deepEqual(h.ctx.chatMetadata.unrelated,{nested:'PROTECTED'});assert.equal(h.ctx.chatMetadata.variables.other,'KEEP');assert.deepEqual(h.ctx.chatMetadata.amin_os_organizations_v1.backups,[{keep:true}]);assert.equal(h.ctx.chatMetadata.amin_os_organizations_v1.custom,'retain');
    assert.equal(h.api.read().backups.length,1);assert.equal(h.api.read().backups[0].modules.status.项目.主角.力量,99);
    assert.equal(h.ctx.chatMetadata[Effects.KEY].trash,undefined);assert.equal(h.ctx.chatMetadata[Effects.KEY].groups,undefined);
    h.ctx.chat[1].swipe_id=1;assert.equal(Characters.readCharacters(h.ctx).characters[0].name,'旅人'); // original earlier branch survives
    h.api.dispose();
});
test('cross-chat import only stores a snapshot; restore rebases facts and disables invalid source references',async()=>{
    const h=fixture(),saved=await save(h),raw=h.api.exportSave(saved.id);h.switch();const original=structuredClone(h.ctx.chat);
    h.api.stageImport(raw);assert.equal(h.ctx.chatMetadata[KEY],undefined);await h.api.confirm();assert.equal(h.ctx.chatMetadata[Characters.KEY],undefined);
    const preview=h.api.stageRestore(saved.id);assert.ok(preview.summary.warnings.some(text=>text.includes('来源不匹配')));await h.api.confirm();
    assert.deepEqual(h.ctx.chat,original);assert.equal(Characters.readCharacters(h.ctx).characters[0].name,'旅人');
    const entry=Journal.currentEntries(Journal.readStore(h.ctx),h.ctx.chat)[0];assert.equal(entry.enabled,false);assert.equal(entry.sources,null);assert.equal(entry.body,'店主约好再见');assert.equal(Journal.currentPrompt(h.ctx),'');
    h.ctx.chat[0].mes='改写来源';assert.equal(Characters.readCharacters(h.ctx).characters.length,0);assert.equal(Effects.activeEffects(h.ctx.chatMetadata[Effects.KEY],h.ctx.chat).length,0);h.api.dispose();
});
test('save failures retain one application and one backup; retry only persists',async()=>{
    const h=fixture(),saved=await save(h);h.ctx.chat.push({name:'角色',mes:'继续',swipe_id:0});h.api.stageRestore(saved.id);h.fail(true);
    await assert.rejects(h.api.confirm(),/保存失败/);const after=structuredClone(h.ctx.chatMetadata);assert.equal(h.api.dirty(),true);assert.equal(h.api.preview(),null);
    await assert.rejects(h.api.confirm(),/没有待确认/);h.fail(false);await h.api.retrySave();assert.deepEqual(h.ctx.chatMetadata,after);assert.equal(h.api.dirty(),false);assert.equal(h.api.read().backups.length,1);h.api.dispose();
});
test('stale chat, candidate, or any snapshot dependency rejects before mutation',async()=>{
    for(const type of ['candidate','chat','data']){const h=fixture(),saved=await save(h);h.api.stageRestore(saved.id);
        if(type==='candidate')h.ctx.chat[0].swipe_id=1;if(type==='chat')h.switch();if(type==='data')h.ctx.chatMetadata.variables.状态栏=JSON.stringify({版本:1,项目:{}});
        const before=structuredClone(h.ctx.chatMetadata),writes=h.writes();await assert.rejects(h.api.confirm(),/变化/);assert.deepEqual(h.ctx.chatMetadata,before);assert.equal(h.writes(),writes);h.api.dispose();}
});
test('import rejects unknown versions, module paths, unsafe keys and oversized data before writes',async()=>{
    const h=fixture(),saved=await save(h);for(const mutate of [s=>s.version=99,s=>s.modules.unknown={},s=>s.modules.scene.version=99,s=>delete s.modules.dice,s=>s.modules.inventory.items[0].quantity=-1,s=>s.source.floor=-1]){
        const copy=structuredClone(saved);mutate(copy);const before=structuredClone(h.ctx.chatMetadata);assert.throws(()=>h.api.stageImport(JSON.stringify(copy)));assert.deepEqual(h.ctx.chatMetadata,before);
    }
    assert.throws(()=>parseImport('{"__proto__":{}}'),/受保护/);assert.throws(()=>parseImport(' '.repeat(LIMITS.snapshotBytes+1)),/8 MiB/);
    const malformed=structuredClone(saved);malformed.modules.dice.rolls[0].results[0].total=NaN;assert.throws(()=>validateSnapshot(malformed),/JSON/);
    h.ctx.chatMetadata[KEY]={version:99,saves:[],backups:[],unknown:'KEEP'};const before=structuredClone(h.ctx.chatMetadata);assert.throws(()=>h.api.stageSave({name:'禁止'}));assert.deepEqual(h.ctx.chatMetadata,before);h.api.dispose();
});
test('empty saved modules clear current branch with history preserved and no unrelated variable removal',async()=>{
    const empty=fixture({populated:false}),saved=await save(empty,'空白状态'),h=fixture(),history=h.ctx.chatMetadata[Characters.KEY].events.length;
    h.api.stageRestore(saved);await h.api.confirm();assert.equal(Characters.readCharacters(h.ctx).characters.length,0);assert.equal(h.ctx.chatMetadata[Characters.KEY].events.length,history+1);
    assert.equal(Effects.activeEffects(h.ctx.chatMetadata[Effects.KEY],h.ctx.chat).length,0);assert.equal(Info.current(Info.read(h.ctx),h.ctx.chat).length,0);assert.equal(Info.compile(Info.read(h.ctx),h.ctx.chat),'');
    assert.equal(h.ctx.chatMetadata.variables.状态栏,undefined);assert.equal(h.ctx.chatMetadata.dynamicMapV1,undefined);assert.equal(h.ctx.chatMetadata.variables.other,'KEEP');empty.api.dispose();h.api.dispose();
});
test('restore checks live map draft on preview and again before confirmation',async()=>{
    const h=fixture(),saved=await save(h);let dirty=true;
    const release=registerMapRuntime({context:()=>h.ctx,persistence:{ensureActive(){},saving:()=>false},draft:{status:()=>({dirty})},store:{snapshot:()=>h.ctx.chatMetadata.dynamicMapV1.document}});
    assert.throws(()=>h.api.stageRestore(saved.id),/未保存/);dirty=false;h.api.stageRestore(saved.id);dirty=true;
    const before=structuredClone(h.ctx.chatMetadata);assert.throws(()=>h.api.confirm(),/未保存/);assert.deepEqual(h.ctx.chatMetadata,before);release();h.api.dispose();
});
test('delete is staged and without external storage only two pre-restore backups stay inline',async()=>{
    const h=fixture({populated:false}),saved=await save(h);for(let i=0;i<7;i++){h.api.stageRestore(saved.id);await h.api.confirm();}
    assert.equal(h.api.read().backups.length,2);assert.equal(h.ctx.chatMetadata[KEY].ring.filter(item=>item.snapshot).length,2);h.api.stageDelete(saved.id);assert.equal(h.api.read().saves.length,1);h.api.discard();assert.equal(h.api.read().saves.length,1);h.api.stageDelete(saved.id);await h.api.confirm();assert.equal(h.api.read().saves.length,0);h.api.dispose();
});
test('present malformed legacy roots are rejected without overwriting original data',async()=>{
    for(const key of [Journal.KEY,Info.KEY,Effects.KEY,Scene.KEY,'amin_os_dice_v1','dynamicMapV1',Info.LIBRARY_KEY,'amin_os_organizations_v1'])for(const value of [null,false,0,'']){
        const h=fixture({populated:false}),saved=await save(h);h.ctx.chatMetadata[key]=value;const before=structuredClone(h.ctx.chatMetadata);
        assert.throws(()=>h.api.stageRestore(saved.id),/格式|版本/);assert.deepEqual(h.ctx.chatMetadata,before);h.api.dispose();
    }
});
test('restore preview shows concrete same-count field changes and its effective source adjustments',async()=>{
    const h=fixture(),saved=await save(h);const status=JSON.parse(h.ctx.chatMetadata.variables.状态栏);status.项目.主角.力量=9;h.ctx.chatMetadata.variables.状态栏=JSON.stringify(status);
    const preview=h.api.stageRestore(saved.id),change=preview.summary.changes.find(row=>row.module==='status');
    assert.equal(change.before,change.after);assert.equal(change.changed,true);assert.deepEqual(change.details.find(row=>row.path==='项目.主角.力量'),{path:'项目.主角.力量',before:'9',after:'3',beforeTruncated:false,afterTruncated:false});
    const dice=preview.summary.changes.find(row=>row.module==='dice');assert.ok(dice.details.some(row=>row.path==='rolls.0.status'&&row.after==='rolled'));
    h.api.dispose();
});
test('a valid maximum-length save name remains restorable with a bounded backup name',async()=>{
    const h=fixture({populated:false}),saved=await save(h,'长'.repeat(120));h.api.stageRestore(saved.id);await h.api.confirm();assert.equal(h.api.read().backups[0].name.length,120);h.api.dispose();
});
test('restoring into a clean initial map view may establish saved map metadata',async()=>{
    const source=fixture(),saved=await save(source),target=fixture({populated:false});
    const release=registerMapRuntime({context:()=>target.ctx,persistence:{ensureActive(){},saving:()=>false},draft:{status:()=>({dirty:false})},store:{snapshot:()=>createDemoDocument()}});
    target.api.stageRestore(saved);await target.api.confirm();assert.deepEqual(target.ctx.chatMetadata.dynamicMapV1.document,saved.modules.map);release();source.api.dispose();target.api.dispose();
});

test('linked appearance, schedule, memories, relationship reminders and effect rules survive one complete restore',async()=>{
    const h=fixture();
    const characters=Characters.readCharacters(h.ctx);characters.characters[0].appearance={description:'旅行装束',hairstyle:'短发',features:'左眼旁有疤'};
    h.ctx.chatMetadata[Characters.KEY]=Characters.buildRestore(h.ctx,characters,{id:'appearance',at});
    const inventory=Inventory.readInventory(h.ctx);inventory.items.push({id:'coat',ownerId:'hero',name:'长外套',quantity:1,equipped:true,notes:'',wear:{slot:'torso',layer:'outer',description:'蓝色羊毛'},condition:{wetness:20,dirt:10,damage:5,notes:'袖口微湿'}});
    h.ctx.chatMetadata[Inventory.KEY]=Inventory.buildRestoreStore(h.ctx,inventory,{id:'coat',at});
    const relations=Relations.readRelationships(h.ctx);relations.thresholdRules=[{id:'trust-rule',relationshipId:'trust',operator:'gte',value:3,message:'关系已改善',enabled:true,repeat:'once'}];
    const improved=structuredClone(relations);improved.relationships[0].strength=4;improved.relationships[0].evidence={origin:'linkage',reason:'履行了承诺',sources:Relations.sourceReferences(h.ctx.chat,[0])};
    const relationshipState=Relations.evaluateThresholds(relations,improved,{operationId:'reminder',at});
    h.ctx.chatMetadata[Relations.KEY]=Relations.buildRestore(h.ctx,relationshipState,{id:'relationship-rules',at});
    const scene=Scene.readCurrentScene(h.ctx);scene.clock={year:24,month:1,day:23,hour:8,minute:0,calendarLabel:'旅人历',calendar:{monthLengths:[30,30],monthNames:['风月','雨月'],weekDays:['甲日','乙日'],epochWeekday:0}};
    const map=h.ctx.chatMetadata.dynamicMapV1.document,mapId=Object.keys(map.maps)[0],nodeId=Object.keys(map.maps[mapId].nodes)[0];
    scene.schedules=[{id:'work',characterId:'innkeeper',title:'旅店值班',startMinute:480,endMinute:960,mapId,nodeId,notes:'日常作息',enabled:true,weekdays:[0,1]}];
    scene.scenes.room.participantIds=['hero'];scene.absenceRules=[{id:'rain',sceneId:'room',title:'雨水渗漏',field:'notes',value:'窗边积水',intervalMinutes:30,enabled:true,settledAt:null}];
    h.ctx.chatMetadata[Scene.KEY]=Scene.appendEvent(Scene.readStore(h.ctx),h.ctx.chat,{state:scene,op:'restore',reason:'增加日程与历法',details:{}},{eventId:'schedule',at});
    let effects=Effects.readStore(h.ctx);effects.skills.push({id:'poison',name:'轻度中毒',reminder:'周期损失力量',book:'',entryId:'',ui:{targetMode:'direct'}});
    effects=Effects.change(effects,h.ctx.chat,'create',{skillId:'poison',holder:'旅人',targetMode:'direct',scope:'身体',condition:'每五分钟',stacking:{mode:'stack',key:'poison',maxStacks:3,stacks:1},periodic:{intervalMinutes:5,scaleWithStacks:true,operations:[{kind:'stat',characterId:'hero',statId:'strength',delta:-1}]}},{clock:scene.clock});h.ctx.chatMetadata[Effects.KEY]=effects;
    let journal=Journal.readStore(h.ctx);const sources=Journal.sourceFromRange(h.ctx.chat,0,0);
    journal=Journal.change(journal,h.ctx.chat,'create',{id:'fact-door',kind:'fact',title:'门后有路',body:'店主提到暗门通往庭院',truth:'confirmed',sources,enabled:true},'fact',at);
    journal=Journal.change(journal,h.ctx.chat,'create',{id:'memory-door',kind:'knowledge',title:'旅人听说暗门',body:'',factId:'fact-door',characterId:'hero',learnedFromId:'innkeeper',state:'rumor',confidence:60,belief:'暗门可能仍可通行',learnedAtText:'清晨',sources,enabled:true},'memory',at);
    journal=Journal.configureAuto(journal,{enabled:true,every:2,start:0,instruction:'按事实整理'});
    journal=Journal.putAutoDraft(journal,h.ctx.chat,{id:'draft-one',title:'初到旅店',body:'听说了庭院的暗门',sources},'draft',at);h.ctx.chatMetadata[Journal.KEY]=journal;
    const saved=await save(h,'完整联动');
    h.ctx.chat.push({name:'角色',mes:'稍后',swipe_id:0});
    h.ctx.chatMetadata[Characters.KEY]=Characters.buildRestore(h.ctx,Characters.emptyState(),{id:'cleared-chars',at});
    h.ctx.chatMetadata[Inventory.KEY]=Inventory.buildRestoreStore(h.ctx,Inventory.emptyState(),{id:'cleared-inventory',at});
    h.api.stageRestore(saved.id);await h.api.confirm();const restored=materialize(h.ctx);
    assert.deepEqual(restored.characters,saved.modules.characters);assert.deepEqual(restored.inventory,saved.modules.inventory);
    assert.deepEqual(restored.relationships,saved.modules.relationships);assert.deepEqual(restored.scene,saved.modules.scene);
    assert.deepEqual(restored.effects,saved.modules.effects);assert.deepEqual(restored.journal,saved.modules.journal);
    const bad=structuredClone(saved);bad.modules.scene.schedules[0].startMinute=-1;const before=structuredClone(h.ctx.chatMetadata);
    assert.throws(()=>h.api.stageRestore(bad),/日程开始/);assert.deepEqual(h.ctx.chatMetadata,before);h.api.dispose();
});

test('linkage restore archives imported receipts, retains current live receipts and keeps legacy missing settings',async()=>{
    const h=fixture({populated:false});
    const receipt=id=>({id,at,source:{identity:chatIdentity(h.ctx),path:chatPath(h.ctx.chat),index:0,swipe:0,text:h.ctx.chat[0].mes},changes:[]});
    h.ctx.chatMetadata[Linkage.KEY]={...Linkage.emptyLinkageState(),enabled:true,mode:'auto',extraRules:'只更新已发生事实',modules:{characters:{enabled:true,read:true,write:true}},applied:[receipt('old-receipt')]};
    const saved=await save(h,'统一联动');
    h.ctx.chatMetadata[Linkage.KEY]={...Linkage.emptyLinkageState(),applied:[receipt('current-receipt')]};
    const preview=h.api.stageRestore(saved.id);assert.ok(preview.summary.warnings.some(value=>value.includes('归档历史')));await h.api.confirm();
    const restored=Linkage.readLinkageState(h.ctx);assert.equal(restored.enabled,true);assert.equal(restored.mode,'auto');
    assert.equal(restored.applied.find(value=>value.id==='old-receipt').archived,true);assert.equal(restored.applied.find(value=>value.id==='current-receipt').archived,undefined);
    const legacy=structuredClone(saved);delete legacy.modules.linkage;const before=structuredClone(h.ctx.chatMetadata[Linkage.KEY]);
    h.api.stageRestore(legacy);await h.api.confirm();assert.deepEqual(h.ctx.chatMetadata[Linkage.KEY],before);
    const empty=structuredClone(saved);empty.modules.linkage=null;h.api.stageRestore(empty);await h.api.confirm();
    assert.equal(Linkage.readLinkageState(h.ctx).enabled,false);assert.equal(Linkage.readLinkageState(h.ctx).applied.length,2);h.api.dispose();
});
