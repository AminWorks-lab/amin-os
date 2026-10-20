import { isChatReady } from './chat-lifecycle.js';
import { STATE_KEY } from '../story-state/access.js';
import { linkedEmpty } from './open-app.js';
// Apps whose data lives in the current chat's Amin story state (amin_os_state_v1).
export const STORY_APPS = Object.freeze(['characters', 'inventory', 'relationships', 'saves', 'scene', 'journal', 'organizations', 'effects', 'information', 'map', 'status']);
export const STORY_MISSING_TEXT = '当前聊天还没有剧情资料。可在 存档与历史 → 剧情存储 导入旧资料或开始空白资料；聊天正文照常生成。';
// Why story data cannot be used yet. A chat that is still loading keeps the loading
// message; a loaded chat without amin_os_state_v1 needs setup instead of waiting.
export function storyReadiness(ctx) {
    const id = ctx?.getCurrentChatId?.() ?? ctx?.chatId;
    if (id == null || id === '') return { code: 'no-chat', message: '请先打开一个聊天。' };
    if (!isChatReady(ctx)) return { code: 'loading', message: '聊天正在加载或切换，请等待加载完成后再操作。' };
    if (!Object.hasOwn(ctx?.chatMetadata ?? {}, STATE_KEY)) return { code: 'no-story', message: STORY_MISSING_TEXT };
    return { code: 'ready', message: '' };
}
// Fills `host` with the setup prompt while the chat has no story state; returns whether it is shown.
export function renderStoryGate(host, ctx, document = globalThis.document) {
    const state = storyReadiness(ctx), missing = state.code === 'no-story';
    host.hidden = !missing;
    if (!missing) { if (host.firstChild) host.replaceChildren(); delete host.dataset.storyGate; return false; }
    if (host.dataset.storyGate === 'shown' && host.firstChild) return true;
    const create = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
    host.replaceChildren(linkedEmpty(create, state.message, 'story', { label: '前往 存档与历史 → 剧情存储' }));
    host.dataset.storyGate = 'shown';
    return true;
}
