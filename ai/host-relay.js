// TauriTavern relay for the independent API.
//
// On Android/iOS the WebView is suspended in the background and a fetch it owns
// is cut off. TauriTavern (2.3.0+) sends its own chat completions from the Rust
// process instead: /api/backends/chat-completions/generate is answered in-page by
// TT's fetch router, the upstream request runs in Rust under a foreground service
// (Android) / background task (iOS), and the result is handed back once the page
// runs again. Routing our request there, as a "custom" OpenAI-compatible source,
// lets it keep going while the app is in the background.
export const HOST_ROUTE='/api/backends/chat-completions/generate';
const ERROR_CHUNK='tauritavern-error';

/** TauriTavern installs window.__TAURITAVERN__ and routes /api/* fetches to its Rust backend. */
export function tauriHost(scope=globalThis){
 const host=scope?.__TAURITAVERN__;
 return !!(host&&typeof host==='object'&&typeof host.invoke?.safeInvoke==='function');
}
/** Relay only with our own key: TT would otherwise send its own saved custom key to this address. */
export const canRelay=(config,scope)=>!!(config.enabled&&config.hostRelay&&config.apiKey&&tauriHost(scope));

/**
 * The host payload for a body built by buildRequestBody. TT forwards a fixed set of
 * OpenAI fields; custom_include_body re-applies every other field verbatim after that,
 * and custom_include_headers replaces TT's saved custom key with ours.
 */
export function relayPayload(config,body,endpoint){
 const {messages,model,stream,...rest}=body;
 const payload={chat_completion_source:'custom',custom_api_format:'openai_compat',custom_url:endpoint.replace(/\/chat\/completions$/,''),
  custom_include_headers:{Authorization:`Bearer ${config.apiKey}`},type:'quiet',model,messages,stream:!!stream};
 for(const key of ['max_tokens','max_completion_tokens','temperature','top_p','response_format'])if(Object.hasOwn(rest,key))payload[key]=rest[key];
 if(Object.keys(rest).length)payload.custom_include_body=rest;
 return payload;
}
/** TT answers a failed quiet request with 502 { error: { message } }. */
export async function relayError(response){
 let text='';try{text=await response.text();}catch{}
 let message='';try{message=JSON.parse(text)?.error?.message??'';}catch{}
 return {text,message:typeof message==='string'?message.trim():''};
}
/** iOS builds can forbid custom endpoints; the direct request is then the only way. */
export const relayForbidden=detail=>/endpoint_overrides/i.test(detail.text);
/** A stream failure after it started arrives as one chunk whose id marks it as TT's error text. */
export function relayStreamError(value){
 if(typeof value?.id!=='string'||!value.id.startsWith(ERROR_CHUNK))return null;
 const text=value.choices?.[0]?.delta?.content;const clean=typeof text==='string'?text.trim().replace(/^\[[^\]\n]{1,40}\]\s*/,'').trim():'';return clean||'TT 后台通道返回错误';
}
