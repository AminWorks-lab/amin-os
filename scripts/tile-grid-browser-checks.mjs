import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export const tileFixtureSeed=[
    {id:'map',target:'map',label:'旅行地图',size:'medium',x:0,y:0},
    {id:'status',target:'status',label:'',size:'small',x:4,y:0},
    {id:'settings',target:'settings',label:'',size:'small',x:5,y:0},
    {id:'dice',target:'dice',label:'',size:'medium',x:0,y:3},
    {id:'reply',target:'reply',label:'',size:'compactWide',x:3,y:3},
];
export async function checkTileGrid({send,evaluate,waitFor,delay,artifacts,checks}) {
    await evaluate("AminOS.open();window.tileGrid=()=>document.querySelector('.amin-home-apps');window.tileButton=id=>tileGrid().querySelector('[data-tile=\"'+id+'\"]');window.tileRead=()=>JSON.parse(localStorage.getItem('amin-os.tiles.v3')).tiles;window.tileField=(label,value)=>{const e=document.querySelector('.amin-tile-editor [aria-label=\"'+label+'\"]');e.value=value;e.dispatchEvent(new Event(e.type==='color'?'input':'change',{bubbles:true}));};document.querySelector('.amin-edit-tiles').click();tileGrid().scrollIntoView({block:'start'})");
    const coord=async(x,y)=>evaluate(`(()=>{const grid=tileGrid(),r=grid.getBoundingClientRect(),u=parseFloat(grid.style.getPropertyValue('--amin-tile-unit')),g=parseFloat(getComputedStyle(grid).columnGap);return {x:r.left+${x}*(u+g)+u*.3,y:r.top+${y}*(u+g)+u*.3};})()`);
    const center=async id=>evaluate(`(()=>{const r=tileButton('${id}').getBoundingClientRect();return {x:r.left+r.width*.8,y:r.top+r.height*.8};})()`);
    const mouse=async(type,p)=>send('Input.dispatchMouseEvent',{type,...p,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:1});
    const drag=async(id,x,y,valid)=>{
        await evaluate("tileGrid().scrollIntoView({block:'start'})");
        const to=await coord(x,y);await mouse('mousePressed',await center(id));await mouse('mouseMoved',to);
        assert.equal(await evaluate("document.querySelector('.amin-tile-drop-preview')?.dataset.valid"),String(valid),'whole-footprint preview validity');
        if(valid)assert.equal(await evaluate("document.querySelector('.amin-tile-drop-preview').textContent.includes('第 '+"+(y+1)+"+' 行，第 '+"+(x+1)+"+' 列')"),true);
        await mouse('mouseReleased',to);
    };
    await drag('map',1,1,true);
    assert.deepEqual(await evaluate("tileRead().find(t=>t.id==='map')"),{id:'map',target:'map',label:'旅行地图',size:'medium',x:1,y:1},'pointer cell is exact top-left despite bottom-right grab');
    const before=await evaluate('JSON.stringify(tileRead())');
    await drag('map',4,0,false);assert.equal(await evaluate('JSON.stringify(tileRead())'),before,'occupied cell never pushes other tiles');
    await drag('map',5,1,false);assert.equal(await evaluate('JSON.stringify(tileRead())'),before,'right boundary rejects complete footprint');
    await evaluate("tileField('选择磁贴','map');tileField('磁贴尺寸','compactWide')");
    assert.equal(await evaluate("tileButton('map').style.gridColumn"),'2 / span 3');
    await evaluate("tileField('磁贴尺寸','compactTall')");
    assert.equal(await evaluate("tileRead().find(t=>t.id==='map').size"),'compactWide','resize collision rejected');
    await drag('map',2,5,true);
    await evaluate("tileField('磁贴尺寸','compactTall')");
    assert.equal(await evaluate("tileButton('map').style.gridRow"),'6 / span 3');
    for(const [label,value] of [['背景色','#123456'],['文字色','#fefefe'],['图标色','#ffcc00']]){
        await evaluate(`document.querySelector('[aria-label="自定义${label}"]').click();tileField('磁贴${label}','${value}')`);
    }
    assert.equal(await evaluate("getComputedStyle(tileButton('map')).backgroundColor"),'rgb(18, 52, 86)');
    assert.equal(await evaluate("getComputedStyle(tileButton('map').querySelector('.amin-card-copy')).color"),'rgb(254, 254, 254)');
    assert.equal(await evaluate("getComputedStyle(tileButton('map').querySelector('.amin-app-icon')).color"),'rgb(255, 204, 0)');
    assert.equal(await evaluate("(await import('/tile-layout.js')).loadTiles(localStorage).find(t=>t.id==='map').backgroundColor"),'#123456','colors reload');
    await evaluate("window.tileAppearance=(await import('/settings/appearance.js')).getAppearance();window.tileAppearanceBefore=tileAppearance.snapshot();const custom=tileAppearance.snapshot();custom.desktop.style='win10';custom.desktop.windowTheme='win10';custom.desktop.effects.tileOpacity=75;tileAppearance.save(custom)");
    assert.equal(await evaluate("getComputedStyle(tileButton('map')).backgroundColor"),'rgb(18, 52, 86)','custom color overrides Win10 layered finish');
    await evaluate('tileAppearance.save(tileAppearanceBefore)');
    await send('Emulation.setDeviceMetricsOverride',{width:320,height:844,deviceScaleFactor:1,mobile:true});
    await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
    await evaluate("window.dispatchEvent(new Event('resize'));document.querySelector('.amin-edit-tiles').click();tileGrid().scrollIntoView({block:'start'})");
    await delay(150);
    const hold=await center('status');
    await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...hold,id:1}]});await delay(600);await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    assert.equal(await evaluate("document.querySelector('.amin-home').classList.contains('amin-tiles-editing')"),true,'touch long press edits without opening status');
    await evaluate("tileGrid().scrollIntoView({block:'start'})");
    const from=await center('status'),to=await coord(3,0);
    await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...from,id:1}]});
    await send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...to,id:1}]});
    assert.equal(await evaluate("document.querySelector('.amin-tile-drop-preview')?.dataset.valid"),'true');
    await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    assert.equal(await evaluate("tileRead().find(t=>t.id==='status').x"),3,'touch exact cell drop');
    await evaluate("tileGrid().scrollIntoView({block:'start'})");
    const savedTouch=await evaluate('JSON.stringify(tileRead())');
    await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...await center('status'),id:1}]});
    await send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...await coord(2,0),id:1}]});
    await send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
    assert.equal(await evaluate('JSON.stringify(tileRead())'),savedTouch,'cancel retains exact coordinates');
    assert.equal(await evaluate("tileGrid().scrollWidth<=tileGrid().clientWidth+1"),true,'grid fits 320px');
    const screenshot=async name=>{const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(artifacts,name+'.png'),Buffer.from(r.data,'base64'));};
    await evaluate("tileField('选择磁贴','status');tileField('磁贴尺寸','slimTall');tileField('选择磁贴','dice');tileField('磁贴尺寸','slimWide')");
    assert.equal(await evaluate("tileButton('status').style.gridRow"),'1 / span 2','1x2 vertical footprint');
    assert.equal(await evaluate("tileButton('dice').style.gridColumn"),'1 / span 2','2x1 horizontal footprint');
    assert.equal(await evaluate("tileButton('dice').style.gridRow"),'4 / span 1');
    assert.equal(await evaluate("(await import('/tile-layout.js')).loadTiles(localStorage).find(t=>t.id==='status').size"),'slimTall','compact rectangle reload');
    await screenshot('tile-grid-edit-320');
    await evaluate("tileField('网格列数','4')");
    assert.equal(await evaluate("getComputedStyle(tileGrid()).gridTemplateColumns.split(' ').length"),4,'four-column grid');
    assert.equal(await evaluate("await (async()=>{const {tileSpan}=await import('/tile-layout.js');return tileRead().every(t=>t.x>=0&&t.x+tileSpan(t.size).w<=4)})()"),true,'narrow grid preserves bounded positions');
    const gridWidth=await evaluate('tileGrid().clientWidth');
    await evaluate("const range=document.querySelector('[aria-label=\"磁贴整体大小\"]');range.value='80';range.dispatchEvent(new Event('input',{bubbles:true}))");
    await delay(80);
    const scaledWidth=await evaluate('tileGrid().clientWidth');
    assert.ok(Math.abs(scaledWidth/gridWidth-.8)<.02,'overall grid scales to 80 percent');
    assert.deepEqual(await evaluate("(await import('/tile-layout.js')).loadTileGrid(localStorage)"),{columns:4,scale:80},'grid settings persist');
    assert.equal(await evaluate("tileRead().find(t=>t.id==='map').backgroundColor"),'#123456','reflow retains custom colors');
    await evaluate("tileGrid().scrollIntoView({block:'start'})");
    await screenshot('tile-grid-four-80-320');
    await evaluate("tileField('网格列数','6')");
    assert.equal(await evaluate("getComputedStyle(tileGrid()).gridTemplateColumns.split(' ').length"),6,'switch back to six columns');
    await evaluate("const range=document.querySelector('[aria-label=\"磁贴整体大小\"]');range.value='100';range.dispatchEvent(new Event('input',{bubbles:true}))");

    await evaluate("document.querySelector('.amin-edit-tiles').click();document.querySelector('.amin-home').scrollTop=0");
    await screenshot('tile-grid-320');
    await send('Emulation.setTouchEmulationEnabled',{enabled:false});
    await send('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate("window.dispatchEvent(new Event('resize'));(await import('/tile-layout.js')).resetTileLayout();document.querySelector('.amin-home').scrollTop=0");
    await delay(150);await screenshot('tile-grid-default-1280');
    // The default home opens 骰子 through its suite tile (能力与检定), which starts on its first tab.
    await evaluate("tileButton('abilities').scrollIntoView({block:'center'})");
    const launch=await center('abilities');await mouse('mousePressed',launch);await mouse('mouseReleased',launch);
    await waitFor("!pane('abilities').hidden&&!pane('effects').hidden",'suite tile still opens its window outside edit mode');
    await evaluate("pane('abilities').querySelector('[data-suite-tab=dice]').click()");
    await waitFor("!pane('dice').hidden&&!!pane('dice').querySelector('.amin-dice')",'suite tab opens the dice app');
    checks.push('Tile grid: exact top-left mouse/touch drop, full valid/invalid preview, collisions/bounds reject without reflow, 3x2 and 2x3 resizing, independent colors/reload, four/six columns and 80% overall sizing with persisted settings, mobile long press and six-column layout');
}
