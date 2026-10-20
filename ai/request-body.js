export function parseRequestBody(value=''){
 let result;try{result=typeof value==='string'?JSON.parse(value.trim()||'{}'):structuredClone(value);}catch{throw Error('自定义请求参数不是有效 JSON，请检查双引号、逗号和括号');}
 if(!result||typeof result!=='object'||Array.isArray(result))throw Error('自定义请求参数必须是 JSON 对象，例如 {"temperature": 0.8}');
 const inspect=value=>{if(value&&typeof value==='object')for(const [key,child]of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(key))throw Error('自定义请求参数包含不允许的字段：'+key);inspect(child);}};inspect(result);return result;
}
export function buildRequestBody(config,request){
 const body={model:config.model,messages:request.messages??[{role:'system',content:request.systemPrompt},{role:'user',content:request.prompt}],max_tokens:config.maxTokens,stream:config.stream};
 for(const [key,value]of Object.entries(parseRequestBody(config.requestBody))){if(value===null)delete body[key];else body[key]=value;}
 if(typeof body.model!=='string'||!body.model.trim())throw Error('最终请求体需要有效的 model');
 if(!Array.isArray(body.messages)||!body.messages.length)throw Error('最终请求体需要非空 messages 数组');
 if(body.stream!==undefined&&typeof body.stream!=='boolean')throw Error('自定义 stream 必须是 true 或 false');
 return body;
}
