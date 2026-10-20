import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeTiles,worldFields,pcHealth,compactNumber,isSmallTile,LIVE_TARGETS} from '../tile-live.js';
import {collectLiveSnapshot,createLiveTileFeed} from '../tile-live-feed.js';
import {linkageMode} from '../apps/linkage/badge.js';
import {KEY as LINKAGE_KEY,MODULES,emptyLinkageState} from '../apps/linkage/policy.js';

const world={版本:1,项目:{玩家:{姓名:'旅人',生命:{当前:76,最大:100},金币:128},世界:{地点:'星港 · 观测站',时间:'黄昏',天气:'微雨'}}};
const pc={id:'pc1',name:'旅人',kind:'pc',stats:[{id:'hp',label:'生命',binding:'玩家.生命',component:'current',check:'none'}]};
const snapshot=()=>({
 chat:true,world,characters:[{id:'npc',name:'向导',kind:'npc',stats:[]},pc],
 scene:{clock:{year:1024,month:3,day:7,hour:18,minute:5},periods:[{name:'清晨',startMinute:360},{name:'黄昏',startMinute:1020}],sceneName:'观测站'},
 effects:[{id:'a'},{id:'b',paused:true},{id:'c'}],
 journal:[{kind:'task',status:'active'},{kind:'task',status:'active'},{kind:'task',status:'open'},{kind:'clue',status:'confirmed'}],
 inventory:{items:[{ownerId:'pc1',quantity:2},{ownerId:'npc',quantity:5}],balances:[{ownerId:'npc',name:'银币',unit:'',amount:3},{ownerId:'pc1',name:'金币',unit:'枚',amount:12800}]},
 relationships:{relationships:[{fromId:'pc1',toId:'npc'},{fromId:'npc',toId:'pc1'}]},
});

test('a full snapshot yields two lines and a short value for every live tile',()=>{
 assert.deepEqual(summarizeTiles(snapshot()),{
  status:{lines:['星港 · 观测站','黄昏 · 微雨'],short:'微雨'},
  characters:{lines:['旅人','生命 76/100'],short:'76/100'},
  scene:{lines:['1024-03-07 18:05','黄昏 · 观测站'],short:'18:05'},
  effects:{lines:['2 个效果生效中','1 个已暂停'],short:'2'},
  journal:{lines:['2 项任务进行中','1 项待开始'],short:'2'},
  inventory:{lines:['金币 1.3万枚','2 件物品'],short:'1.3万'},
  relationships:{lines:['2 条关系','涉及 2 位人物'],short:'2'},
 });
 assert.deepEqual(Object.keys(summarizeTiles(snapshot())).sort(),[...LIVE_TARGETS].sort());
});

test('no chat or no story data shows no summary at all',()=>{
 assert.deepEqual(summarizeTiles({...snapshot(),chat:false}),{});
 assert.deepEqual(summarizeTiles(null),{});
 assert.deepEqual(summarizeTiles({chat:true,world:null,characters:[],scene:{clock:null,periods:[]},effects:null,journal:null,inventory:{items:[],balances:[],ledger:[]},relationships:{relationships:[]}}),{});
});

test('world fields are found by common names and skipped when missing or not text',()=>{
 assert.deepEqual(worldFields({版本:1,项目:{场景:{当前位置:'旧港',天气:{当前:1,最大:2}},环境:{气候:'晴'}}}),{location:'旧港',time:'',weather:'晴'});
 assert.deepEqual(summarizeTiles({chat:true,world:{版本:1,项目:{环境:{时间:'午夜'}}}}).status,{lines:['午夜'],short:'午夜'});
 assert.equal(summarizeTiles({chat:true,world:{版本:1,项目:{玩家:{生命:{当前:1,最大:2}}}}}).status,undefined);
 assert.deepEqual(worldFields('broken'),{location:'',time:'',weather:''});
});

test('the PC card shows health only when a health stat is bound to world state',()=>{
 assert.deepEqual(pcHealth(pc,world),{label:'生命',current:76,max:100});
 const unbound={...pc,stats:[{id:'hp',label:'生命',binding:'玩家.不存在',component:'current'}]};
 assert.equal(pcHealth(unbound,world),null);
 assert.deepEqual(summarizeTiles({chat:true,world:null,characters:[pc]}).characters,{lines:['旅人'],short:'旅人'});
 assert.deepEqual(summarizeTiles({chat:true,world:{版本:1,项目:{玩家:{生命:30}}},characters:[pc]}).characters,{lines:['旅人','生命 30'],short:'30'});
 assert.equal(summarizeTiles({chat:true,world,characters:[{...pc,kind:'npc'}]}).characters,undefined);
});

test('inventory falls back to the item count and damaged sections hide only themselves',()=>{
 const s={chat:true,characters:[pc],inventory:{items:[{ownerId:'pc1',quantity:3},{ownerId:'pc1',quantity:1}],balances:[]},relationships:{relationships:'broken'},effects:[{paused:true}]};
 const result=summarizeTiles(s);
 assert.deepEqual(result.inventory,{lines:['4 件物品'],short:'4'});
 assert.equal(result.relationships,undefined);
 assert.deepEqual(result.effects,{lines:['0 个效果生效中','1 个已暂停'],short:'0'});
 assert.equal(compactNumber(128),'128');assert.equal(compactNumber(250000000),'2.5亿');assert.equal(compactNumber(2.345),'2.35');
 assert.equal(isSmallTile('small'),true);assert.equal(isSmallTile('slimTall'),true);assert.equal(isSmallTile('medium'),false);
});

test('the feed reads services and publishes at most once per interval',async()=>{
 const metadata={variables:{状态栏:JSON.stringify(world)}},ctx={chatMetadata:metadata,chat:[],getCurrentChatId:()=> 'c1'};
 const services={characters:{read:()=>({characters:[pc]})},scene:{read:()=>({clock:null,periods:[],scenes:{},activeSceneId:null})},inventory:{read:()=>{throw Error('damaged');}}};
 const read=collectLiveSnapshot(ctx,services);
 assert.equal(read.chat,true);assert.deepEqual(read.world,world);assert.deepEqual(read.characters,[pc]);assert.equal(read.inventory,null);
 assert.deepEqual(collectLiveSnapshot({chatMetadata:metadata,getCurrentChatId:()=>null},services),{chat:false});

 let clock=0,listener=null;const timers=[],published=[];
 const feed=createLiveTileFeed({getContext:()=>ctx,services:{characters:Promise.resolve({value:{...services.characters,subscribe(fn){listener=fn;return()=>{};}}})},
  apply:value=>published.push(value),now:()=>clock,schedule:(fn,wait)=>{timers.push({fn,wait});return timers.length;}});
 assert.equal(timers.length,1);assert.equal(timers[0].wait,0);
 feed.refresh();assert.equal(timers.length,1,'pending refreshes coalesce');
 timers.shift().fn();assert.deepEqual(published.at(-1).status.lines,['星港 · 观测站','黄昏 · 微雨']);
 clock=100;await Promise.resolve();await Promise.resolve();
 assert.equal(timers.length,1);assert.equal(timers[0].wait,400,'a service ready soon after a publish waits out the interval');
 listener();assert.equal(timers.length,1,'a service change joins the pending refresh');
 timers.shift().fn();assert.deepEqual(published.at(-1).characters.lines,['旅人','生命 76/100']);
 feed.dispose();
});

test('a disabled feed clears the summaries',()=>{
 const published=[],ctx={chatMetadata:{variables:{状态栏:JSON.stringify(world)}},getCurrentChatId:()=> 'c1'};
 let fn;const feed=createLiveTileFeed({getContext:()=>ctx,apply:v=>published.push(v),enabled:()=>false,schedule:f=>{fn=f;return 1;}});
 fn();assert.deepEqual(published,[{}]);feed.dispose();
});

test('linkage badges read the effective mode for each module',()=>{
 const ctx=modules=>({extensionSettings:{},chatMetadata:{[LINKAGE_KEY]:{...emptyLinkageState(),enabled:true,mode:'auto',modules}}});
 const all=flags=>Object.fromEntries(Object.keys(MODULES).map(id=>[id,{...flags,write:flags.write&&id!=='dice'}]));
 assert.equal(linkageMode(ctx(all({enabled:true,read:true,write:true})),'inventory'),'auto');
 assert.equal(linkageMode(ctx(all({enabled:true,read:true,write:true})),'dice'),'readonly');
 assert.equal(linkageMode(ctx(all({enabled:true,read:true,write:false})),'inventory'),'readonly');
 assert.equal(linkageMode(ctx(all({enabled:false,read:false,write:false})),'inventory'),'off');
 const review=ctx(all({enabled:true,read:true,write:true}));review.chatMetadata[LINKAGE_KEY].mode='review';
 assert.equal(linkageMode(review,'journal'),'review');
 review.chatMetadata[LINKAGE_KEY].enabled=false;assert.equal(linkageMode(review,'journal'),'off');
 assert.equal(linkageMode({chatMetadata:{[LINKAGE_KEY]:'broken'}},'map'),'off');
 assert.equal(linkageMode(undefined,'map'),'off');
});
