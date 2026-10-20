import { NONE_STYLE, contentSelection } from './writing-library.js';

// One editor instance per work page. Hidden pages retain unsaved drafts.
export function mountContentStyles(target, {library, getSelection, setSelection, onChange=()=>{}, document:doc=globalThis.document, kind='内容风格', managementOnly=false}) {
    const make=(tag,text)=>{const n=doc.createElement(tag);if(text!=null)n.textContent=text;return n;};
    const root=make('section');root.className='amin-card amin-content-styles';
    const row=make('label'),select=make('select');select.setAttribute('aria-label',`${kind}`);row.append(make('span',`${kind}`),select);
    const editor=make('details');editor.append(make('summary',`管理${kind}`));
    const list=make('select');list.setAttribute('aria-label',`编辑${kind}`);
    const name=make('input');name.maxLength=40;name.setAttribute('aria-label',`${kind}名称`);
    const prompt=make('textarea');prompt.rows=4;prompt.setAttribute('aria-label',`${kind}提示词`);
    const note=make('p');note.setAttribute('role','status');
    const toolbar=make('div');toolbar.className='amin-toolbar';
    editor.append(list,make('p','名称（1–40 字）与提示词。仅当前所选风格参与请求；留空提示词不追加要求。'),name,prompt,toolbar,note);
    const activeNote=make('p');activeNote.className='amin-meta';activeNote.setAttribute('aria-label',`${kind}生效状态`);
    const activeRules=make('details'),activeText=make('pre');activeRules.append(make('summary','查看本次内容约束'),activeText);
    activeText.className='amin-content-rules-preview';
    if(managementOnly){row.hidden=true;activeNote.hidden=true;activeRules.hidden=true;editor.open=true;}
    root.append(row,activeNote,activeRules,editor);target.append(root);
    let editing='',armed=null,undo=null,disposed=false;
    const drafts=new Map(),owner={};
    const selectionStamp=()=>JSON.stringify([contentSelection(library,getSelection()),library.hasDraft(getSelection())]);
    let selectionMark=selectionStamp();
    const changedSelection=()=>{const mark=selectionStamp();if(mark!==selectionMark){selectionMark=mark;onChange();}};
    const choose=id=>{setSelection(id);changedSelection();};
    const button=(label,fn)=>{const b=make('button',label);b.type='button';b.addEventListener('click',()=>{try{fn();}catch(e){note.textContent=e.message;}});toolbar.append(b);return b;};
    function disarm(){armed=null;remove.textContent='删除风格';}
    function render(){
        if(disposed)return;
        const selected=contentSelection(library,getSelection()).id;
        const current=contentSelection(library,getSelection());
        const hasRules=!!current.description.trim();
        activeNote.textContent=selected==='none'?'未附加内容约束。':hasRules?`当前内容约束：${current.name} · ${current.description.length} 字；每条候选均须遵守。`:`「${current.name}」的提示词为空，不会添加内容约束。请在管理内容风格中填写并保存；仅选择名称不会生效。`;
        activeRules.hidden=managementOnly||!hasRules;activeText.textContent=current.description;
        if(selected!==getSelection())setSelection(selected);
        select.replaceChildren();
        for(const p of [NONE_STYLE,...library.list()]){const o=make('option',p.name);o.value=p.id;select.append(o);}select.value=selected;
        list.replaceChildren();
        const empty=make('option',`新建${kind}`);empty.value='';list.append(empty);
        for(const p of library.list()){const o=make('option',p.name);o.value=p.id;list.append(o);}
        if(editing&&!library.get(editing)&&!drafts.has(editing))editing='';
        list.value=library.get(editing)?editing:'';
        const value=drafts.get(editing)??library.get(editing)??{name:'',description:''};
        name.value=value.name;prompt.value=value.description;
        remove.disabled=!library.get(editing);copy.disabled=!library.get(editing);restore.disabled=!undo;
    }
    const add=button('新增风格',()=>{editing='';disarm();editor.open=true;render();});
    const save=button('保存风格',()=>{
        const old=editing, p=library.save({name:name.value,description:prompt.value},editing||undefined);
        drafts.delete(old);library.setDraft(owner,old,false);editing=p.id;drafts.set(p.id,{name:p.name,description:p.description});choose(p.id);disarm();render();note.textContent=`${kind}已保存。`;
    });
    const copy=button('复制风格',()=>{
        const original=library.get(editing);if(!original)return;
        let n=1,label;do{label=original.name.slice(0,30)+' · 副本'+n++;}while(library.list().some(p=>p.name===label));
        const p=library.save({name:label,description:prompt.value});editing=p.id;choose(p.id);disarm();render();note.textContent='已复制，可继续修改名称和提示词。';
    });
    const remove=button('删除风格',()=>{
        const p=library.get(editing);if(!p)return;
        const mark=JSON.stringify(p);
        if(armed!==mark){armed=mark;remove.textContent=`确认删除「${p.name}」`;note.textContent='再次点击确认删除；删除后可撤销。';return;}
        const id=editing, draft=drafts.get(id);undo={...library.remove(id),draft};drafts.delete(id);library.setDraft(owner,id,false);editing='';disarm();render();note.textContent=`已删除，当前选择安全回退为不附加${kind}。`;
    });
    const restore=button('恢复已删除风格（撤销）',()=>{
        if(!undo)return;const token=undo;library.restore(token);editing=token.preset.id;
        if(token.draft){drafts.set(editing,token.draft);library.setDraft(owner,editing,JSON.stringify(token.draft)!==JSON.stringify({name:token.preset.name,description:token.preset.description}));}
        undo=null;choose(editing);disarm();render();note.textContent='已恢复风格及未保存的编辑。';
    });
    button('放弃修改',()=>{drafts.delete(editing);library.setDraft(owner,editing,false);disarm();render();changedSelection();note.textContent='已放弃该风格的未保存修改。';});
    select.addEventListener('change',()=>{try{choose(select.value);}catch(error){note.textContent=error.message;}disarm();render();});
    list.addEventListener('change',()=>{editing=list.value;disarm();render();});
    const changed=()=>{const value={name:name.value,description:prompt.value};drafts.set(editing,value);const p=library.get(editing);library.setDraft(owner,editing,!p||p.name!==value.name||p.description!==value.description);disarm();changedSelection();note.textContent='有未保存修改；请保存或放弃后再使用该风格。';};
    name.addEventListener('input',changed);prompt.addEventListener('input',changed);
    const unsubscribe=library.subscribe((error,event)=>{if(event?.draftOwner===owner)return;render();changedSelection();if(error){const p=library.get(editing),d=drafts.get(editing);if(d)library.setDraft(owner,editing,!p||p.name!==d.name||p.description!==d.description);note.textContent=`保存失败：${error.message}。已回滚，编辑内容仍保留。`;}});
    render();selectionMark=selectionStamp();
    return {selection:()=>contentSelection(library,getSelection()),refresh(){render();changedSelection();},assertSaved(){if(library.hasDraft(getSelection()))throw Error(`请先保存或放弃所选${kind}的修改。`);},dispose(){disposed=true;unsubscribe();library.clearDrafts(owner);root.remove();}};
}
