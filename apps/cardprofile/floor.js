// “角色设定建议” row under an AI reply that proposed changes to the living card copy.
// Each item is accepted or ignored right there; nothing changes until the user decides.
import { observeChatFloors } from '../floor-scheduler.js';
import { getSharedCardProfileService } from './service.js';
import { describe } from './proposals.js';

const STATE_TEXT = { accepted: '已采纳', ignored: '已忽略', invalid: '无法应用' };

/** Render the proposals of one reply into `row`. Tests pass fake handlers. */
export function renderProposalRow(row, entries, { document = row.ownerDocument, state = {}, names = {}, onDecide, onOpen } = {}) {
    const make = (tag, text = '', className = '') => { const element = document.createElement(tag); if (text) element.textContent = text; if (className) element.className = className; return element; };
    const button = (label, fn, className = '') => { const element = make('button', label, className); element.type = 'button'; element.disabled = !!state.busy; element.addEventListener('click', fn); return element; };
    row.replaceChildren();
    const items = entries.flatMap(entry => entry.items.map(item => ({ entry, item })));
    const pending = items.filter(({ item }) => item.status === 'pending');
    const details = make('details', '', 'amin-turn-details');
    details.open = state.open ?? pending.length > 0;
    details.addEventListener('toggle', () => { state.open = details.open; });
    const who = [...new Set(entries.map(entry => names[entry.avatar]).filter(Boolean))].join('、');
    details.append(make('summary', `角色设定建议${who ? ` · ${who}` : ''} · ${pending.length ? `${pending.length} 条待定` : '已处理'}`));
    const list = make('ul', '', 'amin-turn-items amin-cardprofile-proposals');
    for (const { entry, item } of items) {
        const text = describe(item), li = make('li', '', 'amin-cardprofile-proposal');
        li.dataset.status = item.status;
        li.append(make('strong', text.title));
        if (text.before) li.append(make('div', `当前：${text.before}`, 'amin-cardprofile-proposal-before'));
        if (text.after) li.append(make('div', `${item.op === 'set' ? '改为' : '内容'}：${text.after}`, 'amin-cardprofile-proposal-after'));
        if (item.reason) li.append(make('div', `依据：${item.reason}`, 'amin-cardprofile-proposal-reason'));
        if (item.status === 'pending') {
            const actions = make('div', '', 'amin-turn-actions');
            actions.append(button('采纳', () => onDecide(entry.id, [item.id], true), 'amin-primary'), button('忽略', () => onDecide(entry.id, [item.id], false)));
            li.append(actions);
        } else li.append(make('div', STATE_TEXT[item.status] + (item.error ? `：${item.error}` : ''), item.status === 'invalid' ? 'amin-turn-error' : 'amin-turn-state'));
        list.append(li);
    }
    details.append(list);
    const actions = make('div', '', 'amin-turn-actions');
    if (pending.length > 1) {
        actions.append(button(`全部采纳（${pending.length}）`, async () => { for (const entry of entries) { const ids = entry.items.filter(item => item.status === 'pending').map(item => item.id); if (ids.length) await onDecide(entry.id, ids, true); } }, 'amin-primary'));
        actions.append(button('全部忽略', async () => { for (const entry of entries) { const ids = entry.items.filter(item => item.status === 'pending').map(item => item.id); if (ids.length) await onDecide(entry.id, ids, false); } }));
    }
    actions.append(button('打开角色卡资料', onOpen));
    if (state.error) { const error = make('p', state.error, 'amin-turn-error'); error.setAttribute('role', 'alert'); actions.append(error); }
    row.append(details, actions);
}

export function installProposalRows({ api = getSharedCardProfileService(), document = globalThis.document, getContext = () => globalThis.SillyTavern?.getContext?.() } = {}) {
    const rows = new Map(), states = new Map(), owned = new Set();
    const surface = globalThis.__TAURITAVERN__?.api?.chatSurface, managed = surface?.isManagedOwnershipRequired?.() === true;
    let disposed = false;
    const stateFor = key => { if (!states.has(key)) states.set(key, {}); return states.get(key); };
    function draw(element) {
        if (disposed || !element?.isConnected) return;
        const ctx = getContext(), index = Number(element.getAttribute('mesid')), message = ctx?.chat?.[index];
        let entries = [];
        if (message && !message.is_user && !message.is_system) try { entries = api.proposalsFor(index); } catch { entries = []; }
        let row = rows.get(element);
        if (!entries.length) { if (row) { row.remove(); rows.delete(element); } return; }
        if (!row || !row.isConnected) {
            row = document.createElement('div');
            row.className = 'amin-floor amin-turn-row amin-cardprofile-row'; row.setAttribute('role', 'region'); row.setAttribute('aria-label', `第 ${index + 1} 楼角色设定建议`);
            (element.querySelector('.mes_block') ?? element).append(row); rows.set(element, row);
        }
        const names = Object.fromEntries((ctx.characters ?? []).map(card => [card.avatar, card.name]));
        const state = stateFor(entries[0].key);
        renderProposalRow(row, entries, { document, state, names,
            onDecide: async (entryId, ids, accept) => {
                if (state.busy) return;
                state.busy = true; state.error = ''; draw(element);
                try { await api[accept ? 'accept' : 'ignore'](entryId, ids); }
                catch (error) { state.error = error?.message ?? String(error); }
                finally { state.busy = false; draw(element); }
            },
            onOpen: () => { try { globalThis.AminOS?.openApp?.('cardprofile'); } catch (error) { state.error = error.message; draw(element); } },
        });
    }
    function refresh(elements) {
        if (disposed) return;
        for (const [element, row] of rows) if (!element.isConnected) { row.remove(); rows.delete(element); }
        for (const element of managed ? owned : elements) draw(element);
    }
    if (managed) surface.registerParticipant({ id: 'amin-os/card-profile-proposals', protocolVersion: surface.protocolVersion, didMount: ({ element }) => {
        if (disposed) return; owned.add(element); draw(element);
        return () => { owned.delete(element); rows.get(element)?.remove(); rows.delete(element); };
    } });
    const scheduler = observeChatFloors(refresh, { document, getContext });
    const unsubscribe = api.subscribe(() => scheduler.refresh());
    return { refresh: () => scheduler.refresh(), dispose() { disposed = true; unsubscribe(); scheduler.dispose(); for (const row of rows.values()) row.remove(); rows.clear(); } };
}
