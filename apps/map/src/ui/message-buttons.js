import {mountFloorControl} from '../../../../settings/floor-layout.js';
import {observeChatFloors} from '../../../floor-scheduler.js';
/** UI-only message controls: never insert anything into message text or stored chat. */
export function installMessageButtons(createInlinePanel, preferences, root=document, surface=globalThis.__TAURITAVERN__?.api?.chatSurface) {
    const mounted=new Map();let disposed=false;
    function mount(element){
        if(disposed||mounted.has(element))return mounted.get(element)?.dispose;
        const host=root.createElement('div');host.className='dm-message-map';
        const b=root.createElement('button');b.type='button';b.className='dm-message-button';b.textContent='🗺 地图';b.title='在这条消息末尾展开地图窗口';b.setAttribute('aria-expanded','false');host.append(b);
        const dock=mountFloorControl(element,'map',host,b,root);
        let panel;
        const close=()=>{if(!panel)return;panel.destroy();panel=null;dock.setOpen(false);b.setAttribute('aria-expanded','false');b.textContent='🗺 地图';};
        b.addEventListener('click',()=>{if(panel)close();else{panel=createInlinePanel(host);dock.setOpen(true);b.setAttribute('aria-expanded','true');b.textContent='🗺 关闭地图';}});
        const dispose=()=>{close();dock.dispose();mounted.delete(element);};mounted.set(element,{host,dispose,close,dock});reflect();return dispose;
    }
    function reflect(){const p=preferences.snapshot();for(const {host,close,dock}of mounted.values()){if(!p.messageButtons)close();dock.setVisible(p.messageButtons!==false);}}
    const managed=surface?.isManagedOwnershipRequired?.()===true;
    let unregister;
    if(managed){unregister=surface.registerParticipant({id:'dynamic-map/message-button',protocolVersion:surface.protocolVersion,didMount:({element})=>mount(element)});}
    function reflectFloors(elements){if(disposed)return;for(const [element,item]of mounted)if(!element.isConnected)item.dispose();if(!managed)for(const element of elements)mount(element);reflect();}
    const off=preferences.subscribe(reflect);
    const floors=observeChatFloors(reflectFloors,{document:root});
    return {refresh:floors.refresh,destroy(){disposed=true;off();floors.dispose();if(typeof unregister==='function')unregister();else unregister?.dispose?.();for(const item of [...mounted.values()])item.dispose();}};
}
