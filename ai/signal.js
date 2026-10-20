/** Stop waiting immediately on cancellation, even if a host promise never settles. */
export function waitForSignal(task,signal){
    if(signal?.aborted)return Promise.reject(abortReason(signal));
    if(!signal)return Promise.resolve().then(task);
    return new Promise((resolve,reject)=>{
        const abort=()=>{signal.removeEventListener('abort',abort);reject(abortReason(signal));};signal.addEventListener('abort',abort,{once:true});
        Promise.resolve().then(()=>{if(signal.aborted)throw abortReason(signal);return task();})
            .then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    });
}
export function abortReason(signal){return signal.reason instanceof Error&&signal.reason.name==='Error'?signal.reason:new Error('已取消生成，未应用结果');}
