// Home screen tools above the tiles: first-run guide, global search and quick actions.
// Loaded the first time the Amin window opens; the tiles themselves stay in tile-desktop.js.
import { ONBOARDING_ACTIONS, shouldShowOnboarding, dismissOnboarding, runOnboardingAction } from './onboarding.js';
import { buildSearchIndex, searchIndex } from './search.js';
import { readSearchData } from './sources.js';
import { openSearchResult } from './navigate.js';
import { QUICK_ACTIONS, runQuickAction, appendRoll, rollSummary } from './quick-actions.js';
import { getState2Runtime } from '../state2/runtime.js';

export function mount(host, { openApp, onLayout = () => {}, getContext = () => globalThis.SillyTavern?.getContext?.(), storage = globalThis.localStorage, document = host.ownerDocument ?? globalThis.document } = {}) {
    const make = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
    const button = (parent, label, fn, className = '') => { const node = make('button', label, className); node.type = 'button'; node.addEventListener('click', fn); parent.append(node); return node; };
    const root = make('div', null, 'amin-home-tools amin-ui');
    const guide = make('section', null, 'amin-card amin-stack amin-home-guide'); guide.hidden = true; guide.setAttribute('aria-labelledby', 'amin-home-guide-title');
    const searchBox = make('div', null, 'amin-home-search'), input = make('input');
    input.type = 'search'; input.placeholder = '搜索人物、物品、任务、地点、势力…'; input.setAttribute('aria-label', '搜索当前剧情资料'); input.autocomplete = 'off';
    const results = make('div', null, 'amin-home-results'); results.hidden = true; results.setAttribute('role', 'region'); results.setAttribute('aria-label', '搜索结果'); results.setAttribute('aria-live', 'polite');
    searchBox.append(input, results);
    const quick = make('div', null, 'amin-home-quick amin-toolbar'); quick.setAttribute('role', 'group'); quick.setAttribute('aria-label', '快捷动作');
    const quickResult = make('div', null, 'amin-home-quick-result amin-toolbar'); quickResult.hidden = true; quickResult.setAttribute('role', 'status');
    root.append(guide, searchBox, quick, quickResult); host.append(root);
    let disposed = false, busy = false, searchTicket = 0, timer = null, chatKey = '';
    const layout = () => { if (!disposed) onLayout(); };

    // First-run guide.
    const guideNote = make('p', null, 'amin-meta');
    function drawGuide() {
        let show = false; try { show = shouldShowOnboarding(getContext(), storage); } catch { show = false; }
        if (!show) { guide.hidden = true; guide.replaceChildren(); return; }
        if (!guide.hidden && guide.firstChild) return;
        guide.replaceChildren();
        const heading = make('header', null, 'amin-section-heading'), title = make('h3', '这段聊天还没有剧情资料');
        title.id = 'amin-home-guide-title';
        heading.append(title); button(heading, '稍后', () => { dismissOnboarding(getContext(), storage); drawGuide(); layout(); }, 'amin-home-guide-later');
        guide.append(heading, make('p', '选择一种方式开始。聊天正文照常生成，资料只在你确认后保存。', 'amin-meta'));
        const choices = make('div', null, 'amin-home-guide-choices');
        for (const action of ONBOARDING_ACTIONS) {
            const choice = button(choices, '', () => runGuide(action.id), action.id === 'ai' ? 'amin-primary' : '');
            choice.dataset.onboarding = action.id; choice.append(make('strong', action.label), make('span', action.help, 'amin-meta'));
        }
        guideNote.textContent = ''; guide.append(choices, guideNote); guide.hidden = false;
    }
    async function runGuide(id) {
        if (busy) return; busy = true; for (const node of guide.querySelectorAll('button')) node.disabled = true; guideNote.textContent = '正在处理…';
        try { guideNote.textContent = await runOnboardingAction(id, { runtime: getState2Runtime(), openApp, getContext }); guideNote.dataset.state = ''; }
        catch (error) { guideNote.textContent = error?.message ?? String(error); guideNote.dataset.state = 'error'; }
        finally { busy = false; if (!disposed) { for (const node of guide.querySelectorAll('button')) node.disabled = false; drawGuide(); layout(); } }
    }

    // Global search: reads the apps' current data on each query; results open the app at that entry.
    async function runSearch() {
        const query = input.value.trim(), ticket = ++searchTicket;
        if (!query) { results.hidden = true; results.replaceChildren(); layout(); return; }
        const { data, errors } = await readSearchData(getContext);
        if (disposed || ticket !== searchTicket) return;
        const groups = searchIndex(buildSearchIndex(data), query);
        results.replaceChildren(); results.hidden = false;
        if (!groups.length) results.append(make('p', `没有找到“${query}”。`, 'amin-meta'));
        for (const group of groups) {
            const section = make('section', null, 'amin-home-result-group'); section.dataset.app = group.app;
            section.append(make('h4', `${group.label} · ${group.total}`));
            for (const entry of group.results) {
                const row = button(section, '', () => open(entry), 'amin-home-result');
                row.append(make('strong', entry.label), make('span', [entry.kind, entry.detail].filter(Boolean).join(' · '), 'amin-meta'));
            }
            if (group.total > group.results.length) section.append(make('p', `另有 ${group.total - group.results.length} 项，请输入更具体的词。`, 'amin-meta'));
            results.append(section);
        }
        if (errors.length) results.append(make('p', '部分应用暂时无法搜索：' + errors.join('；'), 'amin-meta'));
        layout();
    }
    async function open(entry) {
        try { await openSearchResult(entry, { openApp, document }); }
        catch (error) { results.prepend(make('p', error?.message ?? String(error), 'amin-notice')); }
    }
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => void runSearch().catch(() => {}), 150); });
    input.addEventListener('keydown', event => {
        if (event.key === 'Escape' && input.value) { event.stopPropagation(); input.value = ''; void runSearch(); }
        if (event.key === 'Enter') { event.preventDefault(); results.querySelector('.amin-home-result')?.click(); }
    });

    // Quick actions.
    for (const action of QUICK_ACTIONS) {
        const node = button(quick, action.label, () => quickAction(action.id, node)); node.dataset.quickAction = action.id;
    }
    async function quickAction(id, node) {
        if (busy) return; busy = true; node.disabled = true;
        try {
            const result = await runQuickAction(id, { openApp });
            if (result.kind === 'roll') showRoll(result.record);
            else showQuick(result.message);
        } catch (error) { showQuick(error?.message ?? String(error), true); }
        finally { busy = false; node.disabled = false; layout(); }
    }
    function showQuick(text, failed = false) { quickResult.replaceChildren(make('span', text)); quickResult.dataset.state = failed ? 'error' : ''; quickResult.hidden = false; }
    function showRoll(record) {
        showQuick(rollSummary(record));
        const append = button(quickResult, '追加到草稿', async () => {
            append.disabled = true;
            try { await appendRoll(record); showQuick(`${rollSummary(record)} · 已追加到聊天草稿`); }
            catch (error) { append.disabled = false; quickResult.append(make('span', error?.message ?? String(error), 'amin-meta')); }
            layout();
        });
    }

    function refresh() {
        if (disposed) return;
        const ctx = getContext(), key = JSON.stringify([ctx?.getCurrentChatId?.() ?? ctx?.chatId ?? null, ctx?.groupId ?? null, ctx?.characterId ?? null]);
        if (key !== chatKey) { chatKey = key; quickResult.hidden = true; quickResult.replaceChildren(); guide.replaceChildren(); guide.hidden = true; }
        drawGuide(); if (input.value.trim()) void runSearch().catch(() => {}); else layout();
    }
    refresh();
    return { element: root, refresh, focusSearch() { input.focus(); }, dispose() { disposed = true; clearTimeout(timer); root.remove(); } };
}
