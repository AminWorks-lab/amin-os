// One context line per app: "当前聊天名 · 数据范围/状态". The window title already names the app.
export const currentChatName=ctx=>{const id=ctx?.getCurrentChatId?.()??ctx?.chatId;return id==null||id===''?'尚未打开聊天':String(id);};
export const contextLine=(ctx,...parts)=>[currentChatName(ctx),...parts.filter(part=>part!=null&&part!=='')].join(' · ');
// Settings that every chat shares use the same shape with a fixed scope label.
export const globalContextLine=(...parts)=>['全部聊天共用',...parts.filter(Boolean)].join(' · ');
