// A suite window: one row of tabs over the member apps' own panes. Each tab loads and
// mounts its app the first time it is shown, through the same loader as a standalone
// window; the member keeps its context line, linkage badge and requests. Only the
// visible member pane scrolls, so the window has a single main scroll area.
export function mount(target, { suite, members, openMember, openApp, onSelect = () => {} } = {}) {
    if (!suite || !members?.length) throw Error('分组应用尚未就绪，请重新打开。');
    const doc = target.ownerDocument ?? globalThis.document;
    const make = (tag, className, text) => { const e = doc.createElement(tag); if (className) e.className = className; if (text) e.textContent = text; return e; };
    target.classList.add('amin-suite'); target.dataset.suite = suite.id;
    const tabs = make('nav', 'amin-tabs amin-suite-tabs'), body = make('div', 'amin-suite-body');
    tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', suite.name + '分组');
    const buttons = new Map();
    for (const member of members) {
        const button = make('button', 'amin-suite-tab', member.name); button.type = 'button'; button.id = `amin-suite-tab-${member.id}`;
        button.dataset.suiteTab = member.id; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', member.pane.id ||= `amin-suite-pane-${member.id}`);
        member.pane.setAttribute('role', 'tabpanel'); member.pane.setAttribute('aria-labelledby', button.id); member.pane.hidden = true;
        // Tab clicks go through the shell so load errors and retries use the window notice.
        button.addEventListener('click', () => { if (current !== member.id || member.pane.hidden) void openApp(member.id); });
        buttons.set(member.id, button); tabs.append(button); body.append(member.pane);
    }
    tabs.addEventListener('keydown', event => {
        const order = members.map(m => m.id), index = order.indexOf(current);
        const next = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: order.length - 1 }[event.key];
        if (next === undefined) return;
        event.preventDefault(); const id = order[(next + order.length) % order.length];
        void openApp(id); buttons.get(id)?.focus();
    });
    target.replaceChildren(tabs, body);
    let current = members[0].id;
    function select(id) {
        current = id;
        for (const member of members) {
            const selected = member.id === id, button = buttons.get(member.id);
            member.pane.hidden = !selected; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
        }
        onSelect(id);
    }
    select(current);
    return {
        // `request.tab` names the member to show; without one the window reopens on its last tab.
        async open(request) {
            const id = members.some(m => m.id === request?.tab) ? request.tab : current;
            select(id);
            await openMember(id, request?.section);
        },
        current: () => current,
        dispose() { tabs.remove(); for (const member of members) member.pane.remove(); target.classList.remove('amin-suite'); },
    };
}
