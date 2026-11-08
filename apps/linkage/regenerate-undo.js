// Regenerating a reply: offer to undo what the reply being replaced already changed (its
// linkage turn and the character-card-profile changes accepted under it) before the new
// generation reads the data. Runs on GENERATION_AFTER_COMMANDS, which the host awaits.
import { headlineText } from './turns.js';

const kinds = new Set(['regenerate', 'swipe']);

/** What the last reply changed: {index, turn, profile: [{entryId, itemId}]} or null. */
export function changesToUndo(ctx, { linkage, cardprofile }) {
    const chat = ctx?.chat ?? [], index = chat.length - 1, reply = chat[index];
    if (!reply || reply.is_user || reply.is_system) return null;
    let turn = null;
    try {
        turn = linkage?.turns?.().find(item => item.index === index && item.swipe === (reply.swipe_id ?? 0) && item.undoable) ?? null;
    } catch { turn = null; }
    const profile = [];
    try {
        for (const entry of cardprofile?.proposalsFor?.(index) ?? []) for (const item of entry.items) if (item.status === 'accepted') profile.push({ entryId: entry.id, itemId: item.id });
    } catch { /* No copies in this chat. */ }
    return turn || profile.length ? { index, turn, profile } : null;
}

export function question(found) {
    const parts = [];
    if (found.turn) parts.push(headlineText({ headline: found.turn.headline ?? [] }).replace(/^本轮更新：/, '联动更新：'));
    if (found.profile.length) parts.push(`角色卡资料：${found.profile.length} 项改动`);
    return `重新生成前，要先撤回上一版回复已经生效的改动吗？\n${parts.join('\n')}\n\n确定：撤回后再生成；取消：保留这些改动直接生成。`;
}

export function installRegenerateUndo({ getContext = () => globalThis.SillyTavern?.getContext?.(), linkage, cardprofile = () => null, saves, confirm = text => globalThis.confirm?.(text) ?? false, notice = (text, ok) => globalThis.toastr?.[ok ? 'success' : 'warning']?.(text, 'Amin OS') } = {}) {
    const ctx = getContext(), source = ctx?.eventSource, event = (ctx?.eventTypes ?? ctx?.event_types ?? {}).GENERATION_AFTER_COMMANDS;
    if (!source?.on || !event) return () => {};
    const handler = async (type, _options, dryRun) => {
        if (dryRun || !kinds.has(type)) return;
        try {
            const current = getContext(), profile = await cardprofile();
            const found = changesToUndo(current, { linkage, cardprofile: profile });
            if (!found || !confirm(question(found))) return;
            const done = [], failed = [];
            if (found.turn) {
                try {
                    const service = await saves();
                    if (service.preview()) throw Error('跨应用存档里有未确认的预览');
                    const target = linkage.undoTarget(found.turn.id);
                    service.stageRestore(target.id ?? target.snapshot);
                    await service.confirm(); linkage.markUndone(found.turn.id); done.push('联动更新');
                } catch (error) { failed.push(`联动更新（${error.message}）`); }
            }
            let undone = 0;
            for (const item of [...found.profile].reverse()) { try { await profile.undo(item.entryId, item.itemId); undone++; } catch (error) { failed.push(`角色卡资料一项（${error.message}）`); } }
            if (undone) done.push(`角色卡资料 ${undone} 项`);
            if (done.length) notice(`已撤回上一版回复的${done.join('、')}。`, true);
            if (failed.length) notice(`有改动没能撤回：${failed.join('；')}。可以在旧回复下面或跨应用存档里手动处理。`, false);
        } catch (error) { notice(`撤回上一版改动失败：${error.message}`, false); }
    };
    source.on(event, handler);
    return () => source.removeListener?.(event, handler) ?? source.off?.(event, handler);
}
