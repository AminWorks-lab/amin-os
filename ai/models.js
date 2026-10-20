import {endpointFor} from './transport.js';
import {resolveHostConnection} from './host-connection.js';
import {waitForSignal} from './signal.js';

export function modelsEndpoint(baseUrl){
    return endpointFor(baseUrl).replace(/\/chat\/completions$/, '/models');
}
export async function fetchModels(config,{signal,fetchImpl=globalThis.fetch,resolveConnection=resolveHostConnection}={}){
    const controller=new AbortController(),abort=()=>controller.abort(Error('已取消拉取模型'));
    if(signal?.aborted)abort();signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>controller.abort(Error('拉取模型列表超时，请重试')),30000);
    try{return await waitForSignal(async()=>{
        // Listing models must work before a model has been selected.
        const connection=await resolveConnection({...config,model:config.model||'model-list'});
        if(controller.signal.aborted)throw controller.signal.reason;
        const headers={Accept:'application/json'};if(connection.apiKey)headers.Authorization=`Bearer ${connection.apiKey}`;
        const response=await fetchImpl(modelsEndpoint(connection.baseUrl),{method:'GET',headers,signal:controller.signal,credentials:'omit',redirect:'error',cache:'no-store'});
        if(!response.ok)throw Error(`拉取模型失败（HTTP ${response.status}），请检查接口地址、密钥及是否支持 /models`);
        let data;try{data=await response.json();}catch{throw Error('模型列表响应不是有效 JSON');}
        const models=[...new Set((Array.isArray(data?.data)?data.data:[]).map(m=>m?.id).filter(id=>typeof id==='string'&&id.trim()))].sort();
        if(!models.length)throw Error('接口未返回可用模型列表，仍可手动填写模型名称');
        return {models,connection};
    },controller.signal);}catch(error){if(controller.signal.aborted)throw controller.signal.reason;if(error instanceof TypeError)throw Error('无法拉取模型，请检查网络、接口地址和跨域支持');throw error;}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
