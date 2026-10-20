import {BLOCKS,defaultPreset} from './presets.js';

export function renderPresetEditor(form,library,current,setCurrent,kit){
    const {el,field,input,select,button,uid}=kit;
    let draft=structuredClone(library.list().find(p=>p.id===current)??library.list()[0]),notice='',noticeState='';
    const group=(host,cls='amin-toolbar')=>{const row=el('div',undefined,cls);host.append(row);return row;};
    let status;
    const report=(text,state='success')=>{notice=text;noticeState=state;if(status){status.textContent=text;status.hidden=!text;status.dataset.state=state;}};
    const safe=(fn,message='已保存预设')=>{try{fn();report(message);}catch(error){report(error.message,'error');}};
    const mark=()=>report('预设已修改，保存后生效。','pending');
    function draw(){
        form.replaceChildren();
        const heading=el('div',undefined,'amin-context');
        heading.append(el('h3','生成预设','amin-section-heading'),el('p',kit.help??'按顺序组合生成消息。调整资料块、消息角色和内容后保存。地图协议与生成范围始终由插件附加。','amin-meta'));
        form.append(heading);
        const selection=el('section',undefined,'amin-card amin-stack'),fields=group(selection,'amin-form-grid');
        const pick=field(fields,'选择预设',select(library.list(),draft.id));
        pick.onchange=()=>safe(()=>{setCurrent(pick.value);draft=structuredClone(library.list().find(p=>p.id===pick.value));draw();},'已切换预设');
        const name=field(fields,'预设名称',input(draft.name));
        name.oninput=()=>{draft.name=name.value;mark();};
        const libraryActions=group(selection);
        libraryActions.append(
            button('新建预设',()=>safe(()=>{const next={...defaultPreset(),id:uid('preset'),name:'新预设'};library.save(next);setCurrent(next.id);draft=next;draw();},'已新建预设')),
            button('复制预设',()=>safe(()=>{const next={...structuredClone(draft),id:uid('preset'),name:draft.name+' 副本'};library.save(next);setCurrent(next.id);draft=next;draw();},'已复制预设')),
            button('删除预设',()=>safe(()=>{library.remove(draft.id);draft=library.list()[0];setCurrent(draft.id);draw();},'已删除预设')),
        );
        form.append(selection);

        const blocks=el('div',undefined,'amin-stack');
        draft.blocks.forEach((block,index)=>{
            const row=el('section',undefined,'dm-route amin-card amin-stack');
            row.append(el('h4',`消息 ${index+1} · ${BLOCKS.find(item=>item.id===block.type)?.name??'资料块'}`,'amin-section-heading'));
            const fields=group(row,'amin-form-grid');
            const enabled=field(fields,'启用此消息',input('','checkbox'));enabled.parentElement.classList.add('amin-check','amin-span-full');enabled.checked=block.enabled;enabled.onchange=()=>{block.enabled=enabled.checked;mark();};
            const kind=field(fields,'资料块',select(BLOCKS,block.type));kind.onchange=()=>{block.type=kind.value;mark();draw();};
            const role=field(fields,'消息角色',select(['system','user','assistant'].map(id=>({id,name:id})),block.role));role.onchange=()=>{block.role=role.value;mark();};
            if(block.type==='text'){
                const text=field(fields,'提示词',el('textarea'));text.rows=5;text.parentElement.classList.add('amin-span-full');text.value=block.text;text.oninput=()=>{block.text=text.value;mark();};
            }
            const actions=group(row);
            for(const [label,step]of [['上移',-1],['下移',1]]){
                const action=button(label,()=>{const next=index+step;[draft.blocks[index],draft.blocks[next]]=[draft.blocks[next],draft.blocks[index]];mark();draw();});
                action.disabled=index+step<0||index+step>=draft.blocks.length;action.setAttribute('aria-label',`${label}消息 ${index+1}`);actions.append(action);
            }
            actions.append(button('移除消息',()=>{draft.blocks.splice(index,1);mark();draw();}));
            blocks.append(row);
        });
        if(!draft.blocks.length)blocks.append(el('p','暂无消息块，添加后可设置提示词与资料来源。','amin-empty'));
        form.append(blocks);
        const actions=group(form);
        actions.append(button('添加消息块',()=>{draft.blocks.push({type:'text',role:'system',text:'',enabled:true});mark();draw();}),button('保存预设',()=>safe(()=>library.save(draft))));
        status=el('p',notice,'amin-result');status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.hidden=!notice;status.dataset.state=noticeState;form.append(status);
    }
    draw();
}
