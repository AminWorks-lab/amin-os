import {validateApiSettings} from './transport.js';

// Read host configuration only. Generation always uses our own fetch transport.
async function loadHost() {
    try {
        const settingsPath='/scripts/openai.js', secretsPath='/scripts/secrets.js', mainPath='/script.js';
        const [settings,secrets,main]=await Promise.all([import(settingsPath),import(secretsPath),import(mainPath)]);
        return {settings:settings.oai_settings,mainApi:main.main_api,secrets};
    } catch { throw Error('无法读取酒馆 API 设置，请在 AI 设置中选择“手动配置直连接口”。'); }
}

export async function resolveHostConnection(config,{load=loadHost}={}) {
    if(config.enabled)return validateApiSettings(config);
    const host=await load(), s={...host.settings};
    if(host.mainApi!=='openai')throw Error('当前酒馆连接不是 Chat Completions；请在 AI 设置中手动配置兼容接口。');
    const source=s.chat_completion_source;
    let baseUrl,model,secretName,apiKey='';
    if(source==='custom') {baseUrl=s.custom_url;model=s.custom_model;secretName='CUSTOM';
        if([s.custom_include_body,s.custom_exclude_body,s.custom_include_headers].some(v=>v?.trim()))throw Error('酒馆自定义接口包含额外请求体或请求头，暂不能直接继承；请在 AI 设置中手动配置兼容接口。');
    } else if(source==='openai') {
        baseUrl=s.reverse_proxy?.trim()||'https://api.openai.com/v1';model=s.openai_model;
        if(s.reverse_proxy?.trim())apiKey=s.proxy_password?.trim()||'';
        else secretName='OPENAI';
    } else if(source==='openrouter') {baseUrl='https://openrouter.ai/api/v1';model=s.openrouter_model;secretName='OPENROUTER';}
    else throw Error('当前酒馆服务商暂不支持继承直连；请在 AI 设置中手动配置 Chat Completions 接口。');
    // Validate the destination before asking the host for a provider-specific key.
    const connection=validateApiSettings({...config,enabled:true,baseUrl:baseUrl||'',model:model||'',apiKey:'',rememberKey:false});
    if(secretName) {
        const secrets=host.secrets, name=secrets.SECRET_KEYS?.[secretName];
        if(name && await secrets.canViewSecrets?.())apiKey=await secrets.findSecret?.(name)||'';
        const state=secrets.secret_state?.[name];
        const hasSecret=Array.isArray(state)?state.length>0:!!state;
        if(!apiKey && (source!=='custom'||hasSecret||state===undefined))throw Error('酒馆未允许读取此 API 密钥。请在 AI 设置选择“手动配置直连接口”，填写相同地址、模型和密钥；不会调用酒馆生成。');
    }
    // A manual-mode key must never leak into an inherited endpoint.
    return {...connection,apiKey};
}
