import { MODULES, readLinkageState, modulePolicy } from './policy.js';
import { getSharedService } from './service.js';
import { openLinkage } from './open.js';

export const LINKAGE_MODE_LABELS = Object.freeze({ auto: '自动', review: '审核', readonly: '只读', off: '关闭' });
/** One module's effective linkage mode in the current chat: auto, review, readonly or off. */
export function linkageMode(ctx, id) {
    try {
        const state = readLinkageState(ctx);
        if (!state.enabled) return 'off';
        const policy = modulePolicy(ctx, id, state);
        if (!policy.enabled) return 'off';
        if (!policy.write || id === 'dice') return 'readonly';
        return state.mode === 'auto' ? 'auto' : 'review';
    } catch { return 'off'; }
}

// All badges refresh together; weak references let closed windows go away.
const badges = new Set(), owners = new WeakMap();
let listening = false;
const hold = badge => typeof WeakRef === 'function' ? new WeakRef(badge) : { deref: () => badge };
function paint(badge) {
    const owner = owners.get(badge); if (!owner) return;
    let ctx = null; try { ctx = owner.getContext(); } catch { /* Painted as off. */ }
    const mode = linkageMode(ctx, owner.id), label = '联动：' + LINKAGE_MODE_LABELS[mode];
    if (badge.textContent !== label) badge.textContent = label;
    badge.dataset.mode = mode;
    badge.title = `${MODULES[owner.id][0]} · ${label}。点击打开联动设置`;
    badge.setAttribute('aria-label', `${label}，打开联动设置`);
}
export function refreshLinkageBadges() {
    for (const ref of [...badges]) { const badge = ref.deref(); if (badge) paint(badge); else badges.delete(ref); }
}
function listen(getContext) {
    if (listening) return; listening = true;
    try { getSharedService().subscribe(refreshLinkageBadges); } catch { /* The badge still refreshes with its bar. */ }
    try {
        const ctx = getContext(), events = ctx?.eventTypes ?? ctx?.event_types ?? {};
        if (events.CHAT_CHANGED) ctx.eventSource?.on?.(events.CHAT_CHANGED, () => queueMicrotask(refreshLinkageBadges));
    } catch { /* Without host events the badge refreshes with its app. */ }
}
/**
 * Keep a “联动：…” badge at the end of an app's context bar. Apps rebuild their
 * bars differently (textContent, replaceChildren, a new element per render), so
 * the badge re-appends itself whenever the bar's children change.
 */
export function attachLinkageBadge(container, id, options = {}) {
    try {
        if (!container?.append || !Object.hasOwn(MODULES, id)) return null;
        const doc = options.document ?? container.ownerDocument ?? globalThis.document;
        const getContext = options.getContext ?? (() => globalThis.SillyTavern?.getContext?.());
        const badge = doc.createElement('button');
        badge.type = 'button'; badge.className = 'amin-linkage-badge'; badge.dataset.linkageModule = id;
        badge.addEventListener('click', event => {
            event?.preventDefault?.(); event?.stopPropagation?.();
            openLinkage().catch(error => globalThis.toastr?.error?.(error?.message ?? String(error), '联动更新'));
        });
        owners.set(badge, { id, getContext }); paint(badge); container.append(badge);
        const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
        if (typeof Observer === 'function') new Observer(() => { if (container.lastChild !== badge) { container.append(badge); paint(badge); } }).observe(container, { childList: true });
        badges.add(hold(badge)); listen(getContext);
        return badge;
    } catch { return null; }
}
