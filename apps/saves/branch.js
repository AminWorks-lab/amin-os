import { chatIdentity, chatPath, pathBelongs } from '../shared/operations.js';

/** A saved current state is not historical proof unless its complete prefix is recorded. */
export function branchAvailability(ctx, snapshot) {
    if (!snapshot?.source?.path) return { available: false, reason: '旧版存档没有记下完整的聊天楼层，只能恢复资料，不能新开分支。' };
    if (!snapshot.source.floor) return { available: false, reason: '聊天开始前的存档没有可创建分支的楼层。' };
    if (snapshot.source.identity !== chatIdentity(ctx)) return { available: false, reason: '请回到此检查点所属的原聊天创建分支。' };
    if (!pathBelongs(snapshot.source.path, chatPath(ctx?.chat))) return { available: false, reason: '来源消息已编辑、删除或切换候选；请先恢复对应候选。' };
    return { available: true, reason: '' };
}

/** Official SillyTavern bookmarks.js exports branchChat and opens the created branch.
 * Verified against public/scripts/bookmarks.js on the release branch. Hosts without
 * this export stay unsupported; never emulate it by truncating the user's chat. */
export async function loadBranchHost() {
    try {
        const path = '/scripts/bookmarks.js', host = await import(path);
        if (typeof host.branchChat === 'function') return host;
    } catch { /* Present the supported action boundary to the user. */ }
    throw Error('当前酒馆未提供兼容的创建分支接口；仍可将存档应用到当前楼层。');
}

export function assertOpenedBranch(ctx, source, name) {
    const id = ctx?.getCurrentChatId?.() ?? ctx?.chatId;
    const identity = chatIdentity(ctx);
    if (typeof name !== 'string' || !name.trim() || id !== name || identity === source.identity) throw Error('酒馆未切换到预期的新分支，未恢复任何插件数据。');
    let owner, original;
    try { owner = JSON.parse(identity)[0]; original = JSON.parse(source.identity)[0]; } catch { throw Error('分支聊天身份无效。'); }
    const currentPath = chatPath(ctx.chat);
    if (JSON.stringify(owner) !== JSON.stringify(original) || currentPath.length !== source.path?.length || !pathBelongs(source.path, currentPath)) throw Error('新分支的人物、消息或候选与检查点不一致，未恢复任何插件数据。');
    return ctx;
}
