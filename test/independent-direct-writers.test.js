import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistory } from '../apps/status/history.js';
import { generateStatus } from '../apps/status/generator.js';
import { createStore as createOrganizations } from '../apps/organizations/service.js';
import { empty as emptyOrganizations } from '../apps/organizations/model.js';
import { createVariableBridge } from '../apps/map/src/integrations/chat-variables.js';
import { createDemoDocument } from '../apps/map/src/core/demo.js';
import { createStore as createMapStore } from '../apps/map/src/core/store.js';
import { bindChatStore } from '../apps/map/src/adapters/chat.js';
import { readHistory, createDiceService } from '../apps/dice/service.js';
import { STATE_KEY, readModule, toLegacyContext } from '../apps/story-state/access.js';
import { emptyState } from '../apps/story-state/schema.js';
import { createStoryStateRuntime } from '../apps/story-state/runtime.js';
import { adapter as statusAdapter } from '../apps/linkage/adapters/status.js';
import { createDraftSession } from '../apps/map/src/core/draft.js';
import { publishExternalMetadataChange } from '../apps/shared/operations.js';
import { registerMapRuntime } from '../apps/map/src/integrations/runtime.js';
import { createSavesService } from '../apps/saves/service.js';

const status = value => ({版本:1,项目:{人物:{生命:value}}});
function fixture(modules={}) {
  let saves=0;
  const ctx={characterId:0,characters:[{avatar:'a.png',data:{name:'角色'}}],getCurrentChatId:()=> 'independent',
    chat:[{mes:'正文',swipe_id:0,swipes:['正文','另一段']}],extensionSettings:{},
    chatMetadata:{[STATE_KEY]:{...emptyState(),revision:1,modules:{...emptyState().modules,...modules}},variables:{unrelated:'keep'},
      extensions:{LittleWhiteBox:{stateCkptV2:{version:999},stateLogV2:{version:999}}}},
    saveMetadata:async()=>{saves++;},saveSettingsDebounced(){}};
  return {ctx,get saves(){return saves;}};
}
// Exercise the real independent transaction and shared save boundary. Only
// external backup IO is replaced; disk integrity has its own storage tests.
function canonicalPreparation(f) {
  const runtime=createStoryStateRuntime(()=>f.ctx,{backups:{available:()=>true,status:()=>({available:true}),savePrevious:async()=>{}}});
  return ()=>runtime.destroy();
}

test('independent history observation and Swipe changes allocate no IDs, snapshots or saves',()=> {
  const f=fixture({status:status(9)}),before=structuredClone(f.ctx.chatMetadata);
  const history=createHistory({context:()=>f.ctx,read:()=>status(9),write:()=>{throw Error('must not replay');},nativeState:()=>({managed:false})});
  try {history.sync();f.ctx.chat[0].swipe_id=1;history.sync();assert.deepEqual(f.ctx.chatMetadata,before);assert.equal(f.ctx.chat[0].extra,undefined);assert.equal(f.saves,0);}
  finally {history.dispose();}
});

test('independent status generation uses canonical current status and never loads host variable writer',async()=> {
  const f=fixture({status:status(9)}),oldWindow=globalThis.window;let loaded=0;
  const before=structuredClone(f.ctx.chatMetadata.extensions);
  f.ctx.generateRaw=async()=>JSON.stringify(status(12));
  globalThis.window={SillyTavern:{getContext:()=>f.ctx}};
  const off=canonicalPreparation(f);
  try {
    const result=await generateStatus({mode:'update',includeCharacter:false,readWorldbooks:false,api:{baseUrl:'',timeoutMs:5000,maxTokens:1000}},undefined,
      {loadVariables:async()=>{loaded++;throw Error('host writer must not load');}});
    assert.equal(result.ok,true,result.message);assert.equal(loaded,0);assert.equal(f.saves,1);
    assert.deepEqual(readModule(f.ctx,'status'),status(12));assert.deepEqual(f.ctx.chatMetadata.variables,{unrelated:'keep'});
    assert.deepEqual(f.ctx.chatMetadata.extensions,before);
  } finally {off();globalThis.window=oldWindow;}
});

test('independent organization editing uses canonical source and shared save without host variable writes',async()=> {
  const doc=emptyOrganizations();doc.name='旧资料';
  const f=fixture({organizations:{version:1,doc,locks:[],assessment:null}}),off=canonicalPreparation(f);
  const store=createOrganizations({context:()=>f.ctx,setVariable:()=>{throw Error('host write forbidden');},nativeState:()=>({managed:false})});
  try {const next=structuredClone(doc);next.name='新资料';store.stage(next,store.capture(),{manual:true});await store.confirm();
    assert.equal(readModule(f.ctx,'organizations').doc.name,'新资料');assert.equal(f.saves,1);
    assert.equal(f.ctx.chatMetadata.variables.势力资料,undefined);assert.equal(f.ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.version,999);
  }finally{off();store.dispose();}
});

test('independent map reload and variable bridge use canonical document without LWB writes or position history',async()=> {
  const doc=createDemoDocument(),f=fixture({map:doc}),store=createMapStore(doc);let hostLoads=0,lwbCalls=0;
  const storage={getItem:()=>JSON.stringify({updatedAt:Date.now(),synced:false,document:{broken:true}}),setItem(){}};
  const persistence=bindChatStore(store,{getContext:()=>f.ctx,storage,namespace:'independent'});
  const bridge=createVariableBridge({store,persistence,getContext:()=>f.ctx,interval:0,loadVariables:async()=>{hostLoads++;throw Error('forbidden');},getLwb:()=>({applyText(){lwbCalls++;}})});
  try {await bridge.sync();f.ctx.chat[0].swipe_id=1;await bridge.sync();assert.deepEqual(store.snapshot(),doc);assert.equal(hostLoads,0);assert.equal(lwbCalls,0);
    assert.equal(f.ctx.chatMetadata.dynamicMapPositionHistoryV1,undefined);assert.equal(f.ctx.chatMetadata.variables.地图,undefined);assert.equal(f.saves,0);assert.ok(bridge.summary());
  }finally{bridge.destroy();persistence.destroy();}
});

test('independent dice reads canonical history and settlement shadows suppress old floor snapshots',()=> {
  const f=fixture({dice:{version:1,rolls:[]},status:status(9)});
  assert.deepEqual(readHistory(f.ctx),[]);
  f.ctx.chat[0].extra={wsh_message_id:'floor'};
  const shadow=toLegacyContext(f.ctx),result=statusAdapter.apply(shadow,{module:'status',action:'adjust',target:'人物.生命',data:{delta:1},reason:'确定变化'},{now:new Date().toISOString()});
  assert.equal(result.patches.length,1);assert.equal(JSON.parse(result.patches[0].value).项目.人物.生命,10);
  assert.deepEqual(readModule(f.ctx,'status'),status(9));
});

test('independent dice roll saves once through canonical storage without touching native history',async()=> {
  const f=fixture({dice:{version:1,rolls:[]}}),off=canonicalPreparation(f),before=structuredClone(f.ctx.chatMetadata.extensions);
  const api=createDiceService(()=>f.ctx,{rng:()=>4,createId:()=> 'roll-independent-1',now:()=>12345});
  try {const roll=await api.roll({formula:'d6',label:'测试'});assert.equal(roll.results[0].total,4);
    assert.equal(readModule(f.ctx,'dice').rolls.length,1);assert.equal(f.ctx.chatMetadata.amin_os_dice_v1,undefined);
    assert.equal(f.saves,1);assert.deepEqual(f.ctx.chatMetadata.extensions,before);
  }finally{api.dispose();off();}
});

test('independent map explicit save updates canonical document and reload ignores unsynced browser cache',async()=> {
  const doc=createDemoDocument(),f=fixture({map:doc}),off=canonicalPreparation(f),store=createMapStore(doc);
  const cache=new Map(),storage={getItem:key=>cache.get(key)??null,setItem:(key,value)=>cache.set(key,value)};
  const persistence=bindChatStore(store,{getContext:()=>f.ctx,storage,namespace:'independent-save'});
  try {const next=structuredClone(doc);next.maps[next.activeMap].name='新地图';store.replace(next);
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(readModule(f.ctx,'map').maps[next.activeMap].name,'新地图');assert.equal(f.saves,1);
    assert.equal(f.ctx.chatMetadata.dynamicMapV1,undefined);assert.equal(f.ctx.chatMetadata.variables.地图,undefined);
    persistence.switchChat();assert.deepEqual(store.snapshot(),next);
  }finally{persistence.destroy();off();}
});

test('independent unrelated app notifications preserve an unfinished map draft',()=> {
  const doc=createDemoDocument(),f=fixture({map:doc,status:status(9)}),store=createMapStore(doc),off=canonicalPreparation(f);
  const persistence=bindChatStore(store,{getContext:()=>f.ctx,storage:{getItem:()=>null,setItem(){}},namespace:'draft'});
  const draft=createDraftSession(store,persistence);
  try {draft.mutate(next=>{next.maps[next.activeMap].name='未保存的编辑';});const token=draft.token();
    f.ctx.chatMetadata[STATE_KEY].modules.status=status(10);f.ctx.chatMetadata[STATE_KEY].revision++;
    publishExternalMetadataChange(()=>f.ctx,[[STATE_KEY]],{phase:'applied'});
    assert.equal(draft.status().dirty,true);assert.equal(draft.status().conflict,false);
    assert.equal(draft.token(),token);
    assert.equal(draft.snapshot().maps[doc.activeMap].name,'未保存的编辑');assert.equal(f.saves,0);
  }finally{draft.destroy();persistence.destroy();off();}
});

test('restoring a mapless named save refuses an unfinished canonical map draft',async()=> {
  const f=fixture(),off=canonicalPreparation(f);let id=0;
  const api=createSavesService(()=>f.ctx,{autoCheckpoints:false,createId:()=>`save_${++id}`});
  let persistence,draft,unregister=()=>{};
  try {api.stageSave({name:'没有地图的存档'});await api.confirm();const save=api.read().saves[0];
    const doc=createDemoDocument();f.ctx.chatMetadata[STATE_KEY].modules.map=doc;
    const store=createMapStore(doc);persistence=bindChatStore(store,{getContext:()=>f.ctx,storage:{getItem:()=>null,setItem(){}},namespace:'restore-guard'});
    draft=createDraftSession(store,persistence);unregister=registerMapRuntime({context:()=>f.ctx,store,draft,persistence});
    draft.mutate(next=>{next.maps[next.activeMap].name='尚未保存的地图';});const before=structuredClone(f.ctx.chatMetadata);
    assert.throws(()=>api.stageRestore(save.id),/地图还有未保存的调整/);
    assert.deepEqual(f.ctx.chatMetadata,before);assert.equal(draft.status().dirty,true);assert.equal(f.saves,1);
  }finally{unregister();draft?.destroy();persistence?.destroy();api.dispose();off();}
});
