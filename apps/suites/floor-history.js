// 楼层记录 as its own window view (存档与历史 → 楼层记录). It reads the world-status
// records already kept by the status background service; nothing here writes.
import { contextLine } from '../shared/context-line.js';
import { attachLinkageBadge } from '../linkage/badge.js';

export function mount(target, { getContext = () => globalThis.SillyTavern?.getContext?.(), loadHistory = () => import('../status/index.js').then(m => m.mountFloorHistory()), openApp = (id, section) => globalThis.AminOS?.openApp?.(id, section) } = {}) {
    const doc = target.ownerDocument ?? globalThis.document;
    const make = (tag, className, text) => { const e = doc.createElement(tag); if (className) e.className = className; if (text) e.textContent = text; return e; };
    target.classList.add('amin-app-page', 'amin-floor-history');
    const heading = make('header', 'amin-context'), line = make('p'), body = make('div', 'amin-floor-history-body');
    heading.append(line); attachLinkageBadge(heading, 'status', { getContext });
    const toolbar = make('div', 'amin-toolbar'), workbench = make('button', '', '在世界状态中编辑'); workbench.type = 'button';
    workbench.onclick = () => openApp('status');
    toolbar.append(workbench); target.replaceChildren(heading, body, toolbar);
    let view = null, loading = null;
    async function load() {
        line.textContent = contextLine(getContext(), '世界状态楼层记录', '只读');
        if (view || loading) return loading;
        loading = loadHistory().then(result => { view = result; body.replaceChildren(result.element); }).finally(() => { loading = null; });
        return loading;
    }
    return {
        async open() { await load(); },
        dispose() { view?.dispose?.(); view = null; target.replaceChildren(); },
    };
}
