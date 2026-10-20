// First-run guide on the home screen for a loaded chat that has no Amin story state yet.
// “稍后” is remembered per chat in this browser; the chat itself is not written.
import { storyReadiness } from '../shared/story-readiness.js';
import { chatIdentity } from '../shared/operations.js';

export const ONBOARDING_KEY = 'amin-os.onboarding.dismissed.v1';
const LIMIT = 200;
function dismissed(storage) {
    try { const value = JSON.parse(storage?.getItem?.(ONBOARDING_KEY) ?? '[]'); return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []; }
    catch { return []; }
}
export function shouldShowOnboarding(ctx, storage = globalThis.localStorage) {
    if (storyReadiness(ctx).code !== 'no-story') return false;
    return !dismissed(storage).includes(chatIdentity(ctx));
}
export function dismissOnboarding(ctx, storage = globalThis.localStorage) {
    const key = chatIdentity(ctx), list = dismissed(storage).filter(item => item !== key);
    list.push(key);
    try { storage?.setItem?.(ONBOARDING_KEY, JSON.stringify(list.slice(-LIMIT))); return true; } catch { return false; }
}

export const ONBOARDING_ACTIONS = Object.freeze([
    { id: 'blank', label: '开始空白剧情资料', help: '从空白资料开始，之后在各应用中手动添加。' },
    { id: 'ai', label: '用 AI 从角色卡和世界书初始化', help: '先建立空白资料，再打开联合初始化生成草稿，确认后才保存。' },
    { id: 'import', label: '导入旧资料', help: '前往 设置 → 剧情存储，预览导入后再确认。' },
]);
async function startBlank(runtime, ctx) {
    if (storyReadiness(ctx()).code === 'ready') return null;
    if (typeof runtime?.initializeEmpty !== 'function') throw Error('Amin 剧情存储尚未就绪，请在 设置 → 剧情存储 中开始空白资料。');
    return runtime.initializeEmpty();
}
/** Runs one guide choice through the existing storage, linkage and settings entry points. */
export async function runOnboardingAction(id, { runtime, openApp, getContext = () => globalThis.SillyTavern?.getContext?.() }) {
    if (id === 'import') { await openApp('settings', { page: 'story', focus: 'import' }); return '请在剧情存储中选择来源并预览导入，确认后才会写入。'; }
    if (id === 'blank') { const result = await startBlank(runtime, getContext); return result?.message || '已建立空白剧情资料。'; }
    if (id === 'ai') {
        await startBlank(runtime, getContext);
        await openApp('status', { page: 'linkage', section: 'joint' });
        return '已建立空白剧情资料，请在联合初始化中选择来源并生成草稿。';
    }
    throw Error('未知的引导选项。');
}
