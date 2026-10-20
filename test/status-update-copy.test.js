import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { isIndependent, STATE_KEY } from '../apps/story-state/access.js';
import { emptyState } from '../apps/story-state/schema.js';
import { createStoryStateRuntime } from '../apps/story-state/runtime.js';
import { createLinkageService } from '../apps/linkage/service.js';
import { buildDataPrompt, buildUpdateRules } from '../apps/linkage/prompt.js';
import { KEY as LINKAGE_KEY, MODULES, emptyLinkageState, managesModule, mayWrite } from '../apps/linkage/policy.js';
import { buildUpdatePrompt } from '../apps/status/state-tools.js';
import { compileRules } from '../apps/status/rules.js';

const state=value=>({版本:1,项目:{人物:{生命:value,描述:'当前事实'}}});
function fixture({independent=true,statusWrite=true,master=true}={}) {
  let saves=0;
  const ctx={characterId:0,characters:[{avatar:'status.png',name:'人物'}],getCurrentChatId:()=> 'copy-status',
    chat:[{is_user:true,mes:'人物受伤了'}],extensionSettings:{},
    chatMetadata:{variables:{状态栏:JSON.stringify(state(999)),foreign:'unchanged'},world_info:'unchanged-book'},
    async saveMetadata(){saves++;}};
  if(independent)ctx.chatMetadata[STATE_KEY]={...emptyState(),modules:{...emptyState().modules,status:state(10)}};
  ctx.chatMetadata[LINKAGE_KEY]={...emptyLinkageState(),enabled:master,
    modules:Object.fromEntries(Object.keys(MODULES).map(module=>[module,{enabled:module==='status',read:module==='status',write:module==='status'&&statusWrite}]))};
  const runtime=independent?createStoryStateRuntime(()=>ctx,{backups:{available:()=>false,status:()=>({available:false}),savePrevious:async()=>{}}}):null;
  return {ctx,get saves(){return saves;},dispose(){runtime?.destroy();}};
}
function actualCopyButton(ctx,{checkIdentity=()=>{}}={}) {
  const source=readFileSync(new URL('../apps/status/index.js',import.meta.url),'utf8');
  const helperStart=source.indexOf('function statusUpdateCopyPrompt()'),helperEnd=source.indexOf('\nconst defaults =',helperStart);
  const buttonStart=source.indexOf('  copy.onclick = async () =>'),buttonEnd=source.indexOf('\n  // Linkage settings live in their own app',buttonStart);
  assert.ok(helperStart>=0&&helperEnd>helperStart&&buttonStart>=0&&buttonEnd>buttonStart);
  const copied=[],navigated=[],copy={},quickStatus={textContent:''};
  const sandbox={context:()=>ctx,KEY:'world_status_hud_v1',isIndependent,mayWrite,buildDataPrompt,buildUpdateRules,
    buildUpdatePrompt,compileRules,readCurrent:()=>JSON.parse(ctx.chatMetadata.variables.状态栏),
    linkageEnabled:()=>managesModule(ctx,'status'),copy,quickStatus,checkIdentity,id:{},dialog:{},
    async openLinkageApp(section){navigated.push('linkage',section);},
    async copyPrompt(text){copied.push(text);return true;}};
  vm.runInNewContext(source.slice(helperStart,helperEnd)+'\n'+source.slice(buttonStart,buttonEnd),sandbox);
  return {copied,navigated,quickStatus,click:()=>copy.onclick()};
}

test('independent status copy invokes the real clipboard action with typed current data and permitted protocol',async()=>{
  const f=fixture(),button=actualCopyButton(f.ctx),before=structuredClone(f.ctx.chatMetadata);
  const linkage=createLinkageService(()=>f.ctx);
  try {
    await button.click();assert.equal(button.copied.length,1);assert.deepEqual(button.navigated,[]);
    const text=button.copied[0];assert.equal(text,[buildDataPrompt(f.ctx),buildUpdateRules(f.ctx)].join('\n\n'));
    assert.match(text,/<amin_update>/);assert.match(text,/module:status/);assert.match(text,/"生命":10/);
    assert.doesNotMatch(text,/"生命":999|module:inventory|状态栏\.项目\.|标签名为 state/);
    assert.match(button.quickStatus.textContent,/amin_update/);assert.deepEqual(f.ctx.chatMetadata,before);assert.equal(f.saves,0);
    // The copied typed contract describes the same validated operation used
    // by a real response; copying does not bypass permissions or mutate state.
    linkage.captureGeneration('normal');f.ctx.chat.push({is_user:false,mes:'人物受伤。<amin_update>'+JSON.stringify({version:1,changes:[
      {module:'status',action:'set',target:'人物.生命',data:{value:9},reason:'本轮人物受伤'}]})+'</amin_update>'});
    const suggestion=await linkage.collectReply(1);linkage.stageSuggestion(suggestion.id);await linkage.confirm();
    assert.equal(f.ctx.chatMetadata[STATE_KEY].modules.status.项目.人物.生命,9);assert.equal(f.saves,1);
    assert.deepEqual(f.ctx.chatMetadata.variables,before.variables);assert.equal(f.ctx.chatMetadata.world_info,'unchanged-book');
  } finally {linkage.dispose();f.dispose();}
});

for(const options of [{statusWrite:false},{master:false}])test('independent status copy refuses a disabled update permission instead of reviving native state syntax '+JSON.stringify(options),async()=>{
  const f=fixture(options),button=actualCopyButton(f.ctx),before=structuredClone(f.ctx.chatMetadata);
  try {await button.click();assert.deepEqual(button.copied,[]);assert.deepEqual(button.navigated,[]);
    assert.match(button.quickStatus.textContent,/允许模型更新/);assert.deepEqual(f.ctx.chatMetadata,before);assert.equal(f.saves,0);
  } finally {f.dispose();}
});

test('independent status copy honors external data source and checks chat identity before clipboard use',async()=>{
  const f=fixture();f.ctx.chatMetadata[LINKAGE_KEY].dataSource='external';
  try {
    const button=actualCopyButton(f.ctx);await button.click();assert.equal(button.copied[0],buildUpdateRules(f.ctx));
    const switched=actualCopyButton(f.ctx,{checkIdentity:()=>{throw Error('聊天已切换');}});await switched.click();
    assert.deepEqual(switched.copied,[]);assert.equal(switched.quickStatus.textContent,'聊天已切换');assert.equal(f.saves,0);
  } finally {f.dispose();}
});

test('legacy unmanaged copy retains native prompt while managed legacy copy retains its original navigation',async()=>{
  const f=fixture({independent:false,master:false}),button=actualCopyButton(f.ctx),before=structuredClone(f.ctx.chatMetadata);
  try {
    await button.click();assert.equal(button.copied[0],buildUpdatePrompt(state(999))+'\n\n');
    assert.match(button.copied[0],/标签名为 state/);assert.match(button.copied[0],/状态栏\.项目\.人物\.生命/);
    f.ctx.chatMetadata[LINKAGE_KEY].enabled=true;const managed=actualCopyButton(f.ctx);await managed.click();
    assert.deepEqual(managed.copied,[]);assert.deepEqual(managed.navigated,['linkage','prompt']);
    f.ctx.chatMetadata[LINKAGE_KEY].enabled=false;assert.deepEqual(f.ctx.chatMetadata,before);assert.equal(f.saves,0);
  } finally {f.dispose();}
});
