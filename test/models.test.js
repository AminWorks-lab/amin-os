import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchModels,modelsEndpoint} from '../ai/models.js';
import {createApiProfiles} from '../ai/transport.js';
const config={enabled:true,baseUrl:'https://example.test/v1',model:'',apiKey:'session-key'};
test('model discovery derives endpoint and works without a chosen model',async()=>{
 for(const base of ['https://example.test/v1','https://example.test/v1/','https://example.test/v1/chat/completions'])assert.equal(modelsEndpoint(base),'https://example.test/v1/models');
 const result=await fetchModels(config,{fetchImpl:async(url,options)=>{
  assert.equal(url,'https://example.test/v1/models');assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,'Bearer session-key');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
  return {ok:true,json:async()=>({data:[{id:'z'},{id:'a'},{id:'z'},null,{id:8}]})};
 }});assert.deepEqual(result.models,['a','z']);
});
test('model discovery reports unsupported endpoints, empty and malformed responses',async()=>{
 await assert.rejects(fetchModels(config,{fetchImpl:async()=>({ok:false,status:404})}),/HTTP 404/);
 await assert.rejects(fetchModels(config,{fetchImpl:async()=>({ok:true,json:async()=>({data:[]})})}),/手动填写/);
 await assert.rejects(fetchModels(config,{fetchImpl:async()=>({ok:true,json:async()=>{throw Error('invalid');}})}),/JSON/);
});
test('discovery cancellation aborts fetch and settles even if transport ignores it',async()=>{
 const controller=new AbortController();let transportSignal;
 const pending=fetchModels(config,{signal:controller.signal,fetchImpl:async(_url,options)=>{transportSignal=options.signal;return new Promise(()=>{});}});
 await new Promise(r=>setImmediate(r));controller.abort();await assert.rejects(pending,/取消/);assert.equal(transportSignal.aborted,true);
});
test('named profiles retain independent settings, support replacement and persisted selection',()=>{
 const m=new Map(),storage=()=>({getItem:k=>m.get(k),setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)});
 const p=createApiProfiles(storage(),'profiles');
 p.save('a','配置 A',{...config,model:'a',rememberKey:false});p.save('b','配置 B',{...config,model:'b',apiKey:'remembered',rememberKey:true});p.bind('shared','b');
 p.save('a','重命名 A',{...p.get('a'),model:'a2'});assert.equal(p.list().length,2);assert.equal(p.get('b').model,'b');assert.equal(p.get('a').model,'a2');
 const reload=createApiProfiles(storage(),'profiles');assert.equal(reload.binding('shared'),'b');assert.equal(reload.get('a').apiKey,'');assert.equal(reload.get('b').apiKey,'remembered');assert.ok(!JSON.stringify([...m]).includes('session-key'));
 reload.remove('b');assert.equal(reload.binding('shared'),'');assert.equal(reload.get('a').model,'a2');
});
