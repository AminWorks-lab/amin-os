import test from 'node:test';
import assert from 'node:assert/strict';
import {mountFloorControl} from '../settings/floor-layout.js';
class Node{
 constructor(){this.children=[];this.dataset={};this.hidden=false;this.style={};}
 append(...nodes){for(const n of nodes){n.remove();n.parent=this;this.children.push(n);}}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);this.parent=null;}
 setAttribute(){}querySelector(){return null;}
}
test('floor controls share one row and preserve independent lifecycle and visibility',()=>{
 const document={createElement:()=>new Node()},message=new Node(),text=new Node();message.append(text);
 const mapHost=new Node(),mapButton=new Node(),statusHost=new Node(),statusButton=new Node();
 const map=mountFloorControl(message,'map',mapHost,mapButton,document),status=mountFloorControl(message,'status',statusHost,statusButton,document);
 assert.equal(message.children.length,2);const root=message.children[1];assert.equal(root.children[0].children.length,2);assert.equal(mapHost.parent,statusHost.parent);
 map.setVisible(false);assert.equal(mapButton.hidden,true);assert.equal(statusButton.hidden,false);assert.equal(root.hidden,false);
 status.setVisible(false);assert.equal(root.hidden,true);status.setVisible(true);assert.equal(root.hidden,false);
 map.dispose();assert.equal(root.children[0].children.length,1);status.dispose();assert.deepEqual(message.children,[text]);
});

test('three windows keep opening order and reopening moves a window to the end',()=>{
 const document={createElement:()=>new Node()},message=new Node();
 const hosts=[new Node(),new Node(),new Node()],buttons=[new Node(),new Node(),new Node()];
 const docks=['map','status','reply'].map((id,i)=>mountFloorControl(message,id,hosts[i],buttons[i],document));
 docks[2].setOpen(true);docks[0].setOpen(true);docks[1].setOpen(true);
 assert.deepEqual(hosts.map(h=>h.style.order),['2','3','1']);
 docks[2].setOpen(false);docks[2].setOpen(true);
 assert.deepEqual(hosts.map(h=>h.style.order),['1','2','3']);
 docks[0].dispose();assert.deepEqual(hosts.slice(1).map(h=>h.style.order),['1','2']);
 docks[1].dispose();docks[2].dispose();assert.equal(message.children.length,0);
});

test('five floor apps use fixed button order and click order for windows',()=>{
 const document={createElement:()=>new Node()},message=new Node(),ids=['information','effects','reply','map','status'];
 const hosts=ids.map(()=>new Node()),buttons=ids.map(()=>new Node()),docks=ids.map((id,i)=>mountFloorControl(message,id,hosts[i],buttons[i],document));
 assert.deepEqual(message.children[0].children[0].children.map(b=>b.dataset.floorApp),['map','status','reply','effects','information']);
 docks.forEach(d=>d.setOpen(true));assert.deepEqual(hosts.map(h=>h.style.order),['1','2','3','4','5']);
 docks[0].setOpen(false);docks[0].setOpen(true);assert.equal(hosts[0].style.order,'5');
 buttons[1].click=()=>docks[1].setOpen(false);docks[1].setVisible(false);assert.equal(buttons[1].hidden,true);assert.equal(hosts[0].style.order,'4');
 docks.forEach(d=>d.dispose());assert.equal(message.children.length,0);
});
test('worldbook floor window shares button order and follows opening order',()=>{
 const document={createElement:()=>new Node()},message=new Node(),ids=['worldbooks','information','effects','reply','status','map'];
 const hosts=ids.map(()=>new Node()),buttons=ids.map(()=>new Node()),docks=ids.map((id,i)=>mountFloorControl(message,id,hosts[i],buttons[i],document));
 assert.deepEqual(message.children[0].children[0].children.map(b=>b.dataset.floorApp),['map','status','reply','effects','information','worldbooks']);
 docks[0].setOpen(true);docks[5].setOpen(true);assert.equal(hosts[0].style.order,'1');assert.equal(hosts[5].style.order,'2');
 docks[0].setOpen(false);docks[0].setOpen(true);assert.equal(hosts[0].style.order,'2');assert.equal(hosts[5].style.order,'1');
 buttons[0].click=()=>docks[0].setOpen(false);docks[0].setVisible(false);assert(buttons[0].hidden);assert.equal(hosts[5].style.order,'1');docks.forEach(d=>d.dispose());
});

test('opening and reordering windows never reparents existing iframe hosts',()=>{
 const document={createElement:()=>new Node()},message=new Node(),hosts=[new Node(),new Node()],buttons=[new Node(),new Node()];
 const docks=['status','map'].map((id,i)=>mountFloorControl(message,id,hosts[i],buttons[i],document));
 const root=hosts[0].parent,original=[...root.children];let appends=0;const append=root.append.bind(root);root.append=(...nodes)=>{appends++;append(...nodes);};
 docks[1].setOpen(true);docks[0].setOpen(true);docks[1].setOpen(false);docks[1].setOpen(true);
 assert.equal(appends,0);assert.deepEqual(root.children,original);assert.deepEqual(hosts.map(h=>h.style.order),['1','2']);
 docks.forEach(d=>d.dispose());
});

test('latest-only floors withdraw idle rows and keep open windows mounted',async()=>{
 const {initializeAppearance}=await import('../settings/appearance.js');
 const ctx={chat:[{mes:'a'},{mes:'b'}],extensionSettings:{},saveSettingsDebounced(){}};const previous=globalThis.SillyTavern;globalThis.SillyTavern={getContext:()=>ctx};
 try{
  initializeAppearance(()=>ctx);
  const document={createElement:()=>new Node()},old=new Node(),latest=new Node();old.getAttribute=()=>'0';latest.getAttribute=()=>'1';
  const oldHost=new Node(),latestHost=new Node(),oldDock=mountFloorControl(old,'map',oldHost,new Node(),document),latestDock=mountFloorControl(latest,'map',latestHost,new Node(),document);
  const oldRoot=old.children[0],latestRoot=latest.children[0];
  assert.equal(oldRoot.hidden,true);assert.equal(latestRoot.hidden,false);
  oldDock.setOpen(true);assert.equal(oldRoot.hidden,false);assert.equal(oldHost.parent,oldRoot);
  oldDock.setOpen(false);assert.equal(oldRoot.hidden,true);
  ctx.chat.pop();oldDock.setVisible(true);assert.equal(oldRoot.hidden,false);
  oldDock.dispose();latestDock.dispose();
 }finally{globalThis.SillyTavern=previous;}
});
