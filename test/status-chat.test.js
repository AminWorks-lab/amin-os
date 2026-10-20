import test from 'node:test';
import assert from 'node:assert/strict';
import {readStatusChat,requireStatusChat} from '../apps/status/chat-context.js';
import {compilePreset,defaultPreset} from '../ai/presets.js';
test('status conversation reads latest named messages, excludes system and keeps recent twenty',()=>{
 const ctx={name1:'旅人',name2:'守卫',chat:[...Array.from({length:25},(_,i)=>({is_user:i%2===0,mes:String(i)})),{is_system:true,mes:'不读取'}, {mes:' '}]};
 const history=readStatusChat(ctx);assert.equal(history.length,20);assert.equal(history[0].内容,'5');assert.equal(history.at(-1).内容,'24');assert.equal(history.at(-1).角色,'旅人');
 ctx.chat.push({name:'同伴',mes:'刚刚到达城门'});assert.deepEqual(readStatusChat(ctx).at(-1),{角色:'同伴',内容:'刚刚到达城门'});
 assert.deepEqual(readStatusChat({}),[]);
});
test('status always includes chat even with a disabled or missing preset block without mutating saved presets',()=>{
 for(const blocks of [defaultPreset().blocks,defaultPreset().blocks.filter(b=>b.type!=='chat'),defaultPreset().blocks.map(b=>({...b,enabled:b.type!=='chat'}))]){
 const original={preset:{id:'test',name:'test',blocks}};const before=structuredClone(original);
 const snapshot=requireStatusChat(original);const messages=compilePreset(snapshot.preset,{chat:[{内容:'当前剧情'}],request:'生成'});
 assert.equal(messages.filter(m=>m.content.includes('当前剧情')).length,1);assert.deepEqual(original,before);
 }
});

import {readFile} from 'node:fs/promises';
test('fill, replace and update submit current conversation to the model',async()=>{
 let source=await readFile(new URL('../apps/status/generator.js',import.meta.url),'utf8');
 source=source.replace(/from '(.*?)'/g,(_,path)=>`from '${new URL(path,new URL('../apps/status/generator.js',import.meta.url)).href}'`);
 source=source.replace(/import '(.*?)';/g,(_,path)=>`import '${new URL(path,new URL('../apps/status/generator.js',import.meta.url)).href}';`);
 const mock=code=>'data:text/javascript,'+encodeURIComponent(code);
 source=source.replace("import('/scripts/world-info.js')",`import('${mock('export const selected_world_info=[];export const loadWorldInfo=async()=>({entries:{}});')}')`)
 .replace("import('/scripts/variables.js')",`import('${mock('export const setLocalVariable=()=>{};')}')`)
 .replace("import('/scripts/utils.js')",`import('${mock('export const getCharaFilename=()=>"card";')}')`);
 const {generateStatus}=await import(mock(source));
 const requests=[];const ctx={characterId:0,characters:[{avatar:'card.png',name:'守卫'}],getCurrentChatId:()=>1,chatMetadata:{variables:{状态栏:{版本:1,项目:{人物:{地点:'旧地点'}}}}},chat:[{name:'旅人',is_user:true,mes:'我们已经抵达城门。'}],generateRaw:async request=>{requests.push(request);throw Error('captured-request');}};
 const previous=globalThis.window;globalThis.window={SillyTavern:{getContext:()=>ctx}};
 try {for(const mode of ['fill','replace','update']){
 assert.equal((await generateStatus({mode,api:{baseUrl:'',timeoutMs:5000,maxTokens:1000},extraBooks:[],maxSourceChars:100000})).message,'captured-request');
 const data=JSON.parse(requests.at(-1).prompt);assert.equal(data.设定素材.最近对话[0].内容,'我们已经抵达城门。');
 }}finally{globalThis.window=previous;}
 assert.equal(requests.length,3);
});
