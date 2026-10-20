// Cross-app links. The shell exposes AminOS.openApp(id); an optional request is
// left for the target app (for example settings → 剧情存储) to take when it opens.
const requests=new Map();
export const APP_LABELS=Object.freeze({characters:'人物卡',inventory:'背包与账本',relationships:'人物关系',saves:'跨应用存档',scene:'场景与时间',journal:'剧情档案',dice:'骰子',tts:'语音朗读',worldbooks:'世界书管理',information:'信息面板',effects:'能力面板',map:'地图',status:'世界状态',organizations:'势力概览',reply:'回复选项',ai:'AI 设置',settings:'设置'});
export function openApp(id,request,{opener=globalThis.AminOS?.openApp}={}){
 if(typeof opener!=='function')throw Error('请在 Amin OS 中打开'+(APP_LABELS[id]??'关联应用')+'。');
 if(request)requests.set(id,request);else requests.delete(id);
 return opener(id);
}
export function takeAppRequest(id){const request=requests.get(id);requests.delete(id);return request;}
// An empty state that points at another app gets a button that opens it directly.
export function linkedEmpty(create,text,id,{label='打开'+(APP_LABELS[id]??'应用'),request,opener,onError}={}){
 const box=create('div','','amin-empty amin-linked-empty'),button=create('button',label,'amin-empty-action');button.type='button';
 const go=async()=>{try{await openApp(id,request,{opener:opener??globalThis.AminOS?.openApp});}catch(error){onError?.(error);}};
 if(typeof button.addEventListener==='function')button.addEventListener('click',go);else button.onclick=go;
 box.append(create('p',text,''),button);return box;
}
