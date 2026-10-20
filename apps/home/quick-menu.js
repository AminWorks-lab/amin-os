// The floor toolbar's 快捷动作 menu: the same actions as the home screen, opened from 更多.
import { QUICK_ACTIONS, runQuickAction, appendRoll, rollSummary } from './quick-actions.js';
import { openApp } from '../shared/open-app.js';

const menus = new WeakMap();
export function toggleQuickMenu(anchor, { document = anchor.ownerDocument ?? globalThis.document, open = id => openApp(id) } = {}) {
    const existing = menus.get(anchor);
    if (existing) { existing.close(); return null; }
    const make = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
    const menu = make('div', null, 'amin-quick-menu'); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '快捷动作');
    const status = make('p', null, 'amin-quick-menu-status'); status.setAttribute('role', 'status'); status.hidden = true;
    let busy = false;
    const say = (text, failed = false) => { status.textContent = text; status.dataset.state = failed ? 'error' : ''; status.hidden = !text; };
    for (const action of QUICK_ACTIONS) {
        const item = make('button', action.label); item.type = 'button'; item.setAttribute('role', 'menuitem'); item.dataset.quickAction = action.id;
        item.addEventListener('click', async () => {
            if (busy) return; busy = true; say('正在处理…');
            try {
                const result = await runQuickAction(action.id, { openApp: open });
                if (result.kind !== 'roll') { say(result.message); return; }
                say(rollSummary(result.record));
                const append = make('button', '追加到草稿'); append.type = 'button';
                append.addEventListener('click', async () => {
                    append.disabled = true;
                    try { await appendRoll(result.record); say(`${rollSummary(result.record)} · 已追加到聊天草稿`); }
                    catch (error) { append.disabled = false; say(error?.message ?? String(error), true); status.append(append); }
                });
                status.append(' ', append);
            } catch (error) { say(error?.message ?? String(error), true); }
            finally { busy = false; }
        });
        menu.append(item);
    }
    menu.append(status);
    const onKey = event => { if (event.key === 'Escape') { event.stopPropagation(); close(); anchor.focus?.(); } };
    function close() { menu.remove(); menu.removeEventListener('keydown', onKey); menus.delete(anchor); anchor.setAttribute('aria-expanded', 'false'); }
    menu.addEventListener('keydown', onKey);
    anchor.after(menu); anchor.setAttribute('aria-expanded', 'true'); menus.set(anchor, { close });
    menu.querySelector('button')?.focus?.();
    return { element: menu, close };
}
