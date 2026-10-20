import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppearance,defaults,themeVariables,validate,resolveFloor,FLOOR_BUTTON_ORDER,normalizeFloorButtonOrder,mergeFloorToolbarDraft,defaultMoreButtons} from '../settings/appearance.js';
import {drawerPlacement,clampPosition} from '../window-state.js';
test('appearance follows global defaults while explicit app overrides persist across reloads',()=>{
 const ctx={extensionSettings:{other:{keep:true}},saveSettingsDebounced(){}};const service=createAppearance(()=>ctx);
 let state=service.snapshot();state.global.theme='paper';state.apps.status={...state.global,theme:'violet'};service.save(state);
 state=service.snapshot();state.global.theme='rose';service.save(state);
 assert.equal(service.resolve('map').theme,'rose');assert.equal(service.resolve('status').theme,'violet');
 const loaded=createAppearance(()=>ctx);assert.deepEqual(loaded.snapshot(),service.snapshot());assert.deepEqual(ctx.extensionSettings.other,{keep:true});
 state=loaded.snapshot();delete state.apps.status;loaded.save(state);assert.equal(loaded.resolve('status').theme,'rose');
});
test('invalid settings fail atomically; snapshots cannot mutate live appearance',()=>{
 const ctx={extensionSettings:{},saveSettingsDebounced(){}};const service=createAppearance(()=>ctx),before=service.snapshot();
 const state=service.snapshot();state.global.fontSize=100;assert.throws(()=>service.save(state));assert.deepEqual(service.snapshot(),before);assert.deepEqual(ctx.extensionSettings,{});
 assert.throws(()=>validate({...defaults(),window:{width:NaN,height:720}}));
 const broken=createAppearance(()=>({extensionSettings:{amin_os_appearance_v1:{global:{theme:'missing'}}}}));assert.deepEqual(broken.snapshot(),defaults());
});
test('configured wide desktop window stays inside desktop and mobile viewports',()=>{
 for(const [w,h]of [[1440,900],[390,844],[320,568]]){const p=clampPosition({x:1300,y:810},w,h),r=drawerPlacement(p,w,h,{width:800,height:1000});assert.ok(r.x>=0&&r.y>=0);assert.ok(r.x+r.width<=w);assert.ok(r.y+r.height<=h);}
});
test('unified palette drives map and status alongside shell font and surface settings',()=>{
 const vars=themeVariables({...defaults().global,theme:'paper',fontSize:17,radius:6,density:'compact'});
 assert.equal(vars['--amin-bg'],vars['--wsh-bg']);assert.equal(vars['--amin-bg'],vars['--dm-bg']);assert.equal(vars['--wsh-scheme'],'light');assert.equal(vars['--amin-font'],'17px');assert.equal(vars['--amin-gap'],'8px');assert.equal(vars['--wsh-radius'],'6px');
});
test('floor dimensions migrate, share defaults, and allow independent overrides',()=>{
 const state=validate({floor:{width:800,desktopHeight:60,mobileHeight:50}});
 assert.equal(state.floor.alignment,'left');assert.equal(state.floor.sizeMode,'fixed');
 assert.equal(resolveFloor(state,'map').width,800);assert.equal(resolveFloor(state,'status').width,800);
 state.floor.overrides.map={width:500,desktopHeight:45,mobileHeight:40};state.floor.alignment='right';
 const saved=validate(state);assert.equal(resolveFloor(saved,'map').width,500);assert.equal(resolveFloor(saved,'status').width,800);
 delete saved.floor.overrides.map;assert.equal(resolveFloor(saved,'map').width,800);
 assert.throws(()=>validate({...saved,floor:{...saved.floor,alignment:'bad'}}));
});

test('floor button visibility migrates and reply sizes persist independently',()=>{
 const old=validate({floor:{width:800}});assert.deepEqual(old.floor.buttons,{characters:true,inventory:true,relationships:true,saves:true,map:true,status:true,dice:true,scene:true,journal:true,organizations:true,reply:true,effects:true,information:true,worldbooks:true,tts:true});
 old.floor.buttons.status=false;old.floor.overrides.reply={width:500,desktopHeight:40,mobileHeight:45};
 const ctx={extensionSettings:{},saveSettingsDebounced(){}};createAppearance(()=>ctx).save(old);
 const restored=createAppearance(()=>ctx).snapshot();assert.equal(restored.floor.buttons.status,false);
 assert.equal(restored.floor.buttons.reply,true);assert.equal(resolveFloor(restored,'reply').width,500);
 assert.equal(resolveFloor(restored,'map').width,800);
});

test('desktop style migrates independently and persists without changing app themes',()=>{
 const legacy=defaults();delete legacy.desktop;assert.equal(validate(legacy).desktop.style,'classic');
 const ctx={extensionSettings:{},saveSettingsDebounced(){}};const service=createAppearance(()=>ctx);const next=service.snapshot();next.desktop.style='win10';service.save(next);
 const reloaded=createAppearance(()=>ctx);assert.equal(reloaded.snapshot().desktop.style,'win10');assert.deepEqual(reloaded.snapshot().global,defaults().global);assert.throws(()=>validate({...next,desktop:{style:'invalid'}}));
});

test('Windows 10 window pairing follows desktop choice and preserves independent app themes',()=>{
 const ctx={extensionSettings:{},saveSettingsDebounced(){}};const a=createAppearance(()=>ctx);const d=a.snapshot();d.desktop.style='win10';a.save(d);
 assert.equal(a.resolve('').theme,'win10');assert.equal(a.resolve('information').radius,0);
 d.apps.map={...d.global,theme:'paper'};a.save(d);assert.equal(a.resolve('map').theme,'paper');assert.equal(a.resolve('information').theme,'win10');
 d.desktop.windowTheme='current';a.save(d);assert.equal(a.resolve('information').theme,d.global.theme);
});

test('explicit Windows light overrides automatic dark and accent text remains readable',()=>{
 const ctx={extensionSettings:{},saveSettingsDebounced(){}};const a=createAppearance(()=>ctx),d=a.snapshot();d.desktop.style='win10';d.desktop.windowTheme='win10light';a.save(d);assert.equal(a.resolve('').theme,'win10light');assert.equal(themeVariables(a.resolve(''))['--amin-accent-text'],'#202020');
 d.desktop.windowTheme='win10';a.save(d);assert.equal(themeVariables(a.resolve(''))['--amin-accent-text'],'#ffffff');assert.equal(themeVariables(a.resolve(''))['--amin-accent'],'#0078d4');
});
test('worldbook floor visibility and separate dimensions persist without changing other apps',()=>{
 const ctx={extensionSettings:{},saveSettingsDebounced(){}},a=createAppearance(()=>ctx),s=a.snapshot();
 assert.equal(s.floor.buttons.worldbooks,true);s.floor.buttons.worldbooks=false;s.floor.overrides.worldbooks={width:620,desktopHeight:50,mobileHeight:45};a.save(s);
 const restored=createAppearance(()=>ctx).snapshot();assert.equal(restored.floor.buttons.worldbooks,false);assert.equal(resolveFloor(restored,'worldbooks').width,620);assert.equal(resolveFloor(restored,'map').width,900);
});


test('floor toolbar order sanitizes partial and obsolete records while keeping every current entry',()=>{
 const saved=validate({floor:{alignment:'right',buttonOrder:['dice','obsolete','dice','status',null],moreButtons:['status','bad','status','dice']}});
 assert.deepEqual(saved.floor.buttonOrder,['dice','status',...FLOOR_BUTTON_ORDER.filter(id=>!['dice','status'].includes(id))]);
 assert.deepEqual(saved.floor.moreButtons,['status','dice']);assert.equal(saved.floor.toolbarAlignment,'right');
 assert.deepEqual(normalizeFloorButtonOrder(null),FLOOR_BUTTON_ORDER);assert.deepEqual(normalizeFloorButtonOrder('dice'),FLOOR_BUTTON_ORDER);
 assert.deepEqual(validate({floor:{moreButtons:{status:true}}}).floor.moreButtons,defaultMoreButtons());
 assert.throws(()=>validate({floor:{toolbarAlignment:'bad'}}));
});

test('floor toolbar layout persists independently from window placement and visibility',()=>{
 const ctx={extensionSettings:{},saveSettingsDebounced(){}},service=createAppearance(()=>ctx),state=service.snapshot();
 state.floor.toolbarAlignment='center';state.floor.alignment='right';state.floor.buttonOrder=normalizeFloorButtonOrder(['tts','dice']);state.floor.moreButtons=['tts'];state.floor.buttons.tts=false;
 service.save(state);const restored=createAppearance(()=>ctx).snapshot();
 assert.deepEqual(restored.floor,state.floor);assert.equal(restored.floor.toolbarAlignment,'center');assert.equal(restored.floor.alignment,'right');assert.equal(restored.floor.buttons.tts,false);
 state.floor.buttonOrder.reverse();state.floor.moreButtons.push('map');assert.notDeepEqual(service.snapshot().floor.buttonOrder,state.floor.buttonOrder);assert.deepEqual(service.snapshot().floor.moreButtons,['tts']);
});

test('saving an unrelated settings draft preserves live toolbar changes and retains explicit edits',()=>{
 const draft=defaults(),current=defaults();draft.global.fontSize=16;current.floor.buttonOrder=normalizeFloorButtonOrder(['dice']);current.floor.moreButtons=['tts'];current.floor.toolbarAlignment='right';
 const merged=mergeFloorToolbarDraft(draft,current);assert.equal(merged.global.fontSize,16);assert.deepEqual(merged.floor.buttonOrder,current.floor.buttonOrder);assert.deepEqual(merged.floor.moreButtons,['tts']);assert.equal(merged.floor.toolbarAlignment,'right');
 draft.floor.moreButtons=['status'];const edited=mergeFloorToolbarDraft(draft,current,['moreButtons']);assert.deepEqual(edited.floor.moreButtons,['status']);assert.deepEqual(edited.floor.buttonOrder,current.floor.buttonOrder);
 edited.floor.buttonOrder.reverse();assert.notDeepEqual(edited.floor.buttonOrder,current.floor.buttonOrder);assert.deepEqual(draft.floor.buttonOrder,FLOOR_BUTTON_ORDER);
});

test('floor more buttons upgrade the untouched old default but keep explicit choices',()=>{
 const fresh=defaults().floor;assert.deepEqual(fresh.moreButtons,FLOOR_BUTTON_ORDER.filter(id=>!['map','status','characters','reply'].includes(id)));assert.equal(fresh.latestOnly,true);assert.equal(fresh.moreButtonsCustomized,false);
 assert.deepEqual(validate({floor:{moreButtons:[]}}).floor.moreButtons,defaultMoreButtons());
 assert.deepEqual(validate({floor:{}}).floor.moreButtons,defaultMoreButtons());
 const explicit=validate({floor:{moreButtons:[],moreButtonsCustomized:true}});assert.deepEqual(explicit.floor.moreButtons,[]);assert.equal(explicit.floor.moreButtonsCustomized,true);
 const listed=validate({floor:{moreButtons:['tts']}});assert.deepEqual(listed.floor.moreButtons,['tts']);assert.equal(listed.floor.moreButtonsCustomized,true);
 assert.equal(validate({floor:{latestOnly:false}}).floor.latestOnly,false);assert.equal(validate({}).floor.latestOnly,true);
 const draft=defaults(),current=defaults();current.floor.moreButtons=[];current.floor.moreButtonsCustomized=true;assert.equal(mergeFloorToolbarDraft(draft,current).floor.moreButtonsCustomized,true);
});
