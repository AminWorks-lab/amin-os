// “本轮变化” row under an AI reply whose <amin_update> was applied automatically.
// Undo goes through the saves restore flow (preview → one confirmation) using the
// pre-change backup taken before the batch.
import { observeChatFloors } from '../floor-scheduler.js';
import { getSharedService } from './service.js';
import { headlineText } from './turns.js';

const loadSaves = () => import('../saves/service.js').then(module => module.getSharedSavesService());
const openSaves = () => {
    try { globalThis.AminOS?.openApp?.('saves'); }
    catch (error) { globalThis.toastr?.error?.(error?.message ?? String(error), '跨应用存档'); }
};

/** Render one turn row into `row`. `actions` supplies undo/open handlers (tests pass fakes). */
export function renderTurnRow(row, turn, { document = row.ownerDocument, state = {}, onUndo, onConfirm, onCancel, onOpenSaves } = {}) {
    const make = (tag, text = '', className = '') => { const element = document.createElement(tag); if (text) element.textContent = text; if (className) element.className = className; return element; };
    const button = (label, fn, className = '') => { const element = make('button', label, className); element.type = 'button'; element.disabled = !!state.busy; element.addEventListener('click', fn); return element; };
    row.replaceChildren();
    const details = make('details', '', 'amin-turn-details'), summary = make('summary', headlineText(turn));
    summary.title = '展开查看本轮逐项变化';
    details.open = !!state.open; details.addEventListener('toggle', () => { state.open = details.open; });
    const list = make('ul', '', 'amin-turn-items');
    for (const item of turn.items ?? []) list.append(make('li', item));
    details.append(summary, list);
    const actions = make('div', '', 'amin-turn-actions');
    if (turn.undone) actions.append(make('span', '已撤回本轮更新', 'amin-turn-state'));
    else if (state.preview) {
        const confirmBox = make('div', '', 'amin-turn-confirm'); confirmBox.setAttribute('role', 'group'); confirmBox.setAttribute('aria-label', '确认撤回本轮');
        confirmBox.append(make('p', state.preview), button('确认撤回', onConfirm, 'amin-primary'), button('取消', onCancel));
        actions.append(confirmBox);
    } else if (turn.undoable) actions.append(button('撤回本轮', onUndo));
    else {
        const open = button(turn.stale ? '已有更新，前往存档恢复' : '前往存档恢复', onOpenSaves);
        open.title = turn.stale ? '这一轮之后资料又有变化；请在跨应用存档里选择要恢复的记录。' : (turn.undoError || '这一轮没有可直接撤回的备份。');
        actions.append(open);
    }
    if (state.error) { const error = make('p', state.error, 'amin-turn-error'); error.setAttribute('role', 'alert'); actions.append(error); }
    row.append(details, actions);
}

function previewText(pending) {
    const summary = pending?.summary ?? {}, names = Array.isArray(summary.moduleNames) ? summary.moduleNames : [];
    const changed = Array.isArray(summary.changes) ? summary.changes.length : 0;
    return `撤回会把${changed ? ` ${changed} 个应用的` : ''}资料恢复到这一轮更新前${names.length && !changed ? `（${names.join('、')}）` : ''}；聊天消息不变，撤回前的资料会另存一份安全备份。`;
}

export function installTurnSummaries({ api = getSharedService(), document = globalThis.document, getContext = () => globalThis.SillyTavern?.getContext?.(), saves = loadSaves, openSavesApp = openSaves } = {}) {
    const rows = new Map(), states = new Map(), owned = new Set();
    const surface = globalThis.__TAURITAVERN__?.api?.chatSurface, managed = surface?.isManagedOwnershipRequired?.() === true;
    let disposed = false;
    function stateFor(id) { if (!states.has(id)) states.set(id, {}); return states.get(id); }
    function draw(element) {
        if (disposed || !element?.isConnected) return;
        const ctx = getContext(), index = Number(element.getAttribute('mesid')), message = ctx?.chat?.[index];
        let turn = null;
        if (message && !message.is_user && !message.is_system) try { turn = api.turnFor(index, message.swipe_id ?? 0); } catch { turn = null; }
        let row = rows.get(element);
        if (!turn) { if (row) { row.remove(); rows.delete(element); } return; }
        if (!row || !row.isConnected) {
            row = document.createElement('div');
            // .amin-floor keeps the shared floor scheduler from rescanning on our own redraws.
            row.className = 'amin-floor amin-turn-row'; row.setAttribute('role', 'region'); row.setAttribute('aria-label', `第 ${index + 1} 楼本轮变化`);
            (element.querySelector('.mes_block') ?? element).append(row); rows.set(element, row);
        }
        const state = stateFor(turn.id);
        renderTurnRow(row, turn, { document, state,
            onUndo: () => run(element, turn, state, async () => {
                const service = await saves(), target = api.undoTarget(turn.id);
                if (service.preview()) throw Error('跨应用存档中有尚未确认的预览，请先在存档页确认或取消。');
                service.stageRestore(target.id ?? target.snapshot);
                state.service = service; state.preview = previewText(service.preview());
            }),
            onConfirm: () => run(element, turn, state, async () => {
                const service = state.service; state.preview = '';
                await service.confirm(); api.markUndone(turn.id);
                globalThis.toastr?.success?.('已撤回本轮更新；撤回前的资料已存为安全备份。', 'Amin OS');
            }),
            onCancel: () => { try { state.service?.discard(); } catch { /* Nothing staged. */ } state.preview = ''; state.error = ''; draw(element); },
            onOpenSaves: () => openSavesApp(),
        });
    }
    async function run(element, turn, state, task) {
        if (state.busy) return;
        state.busy = true; state.error = ''; draw(element);
        try { await task(); }
        catch (error) { state.error = error?.message ?? String(error); state.preview = ''; try { state.service?.discard(); } catch { /* Nothing staged. */ } }
        finally { state.busy = false; draw(element); }
    }
    function refresh(elements) {
        if (disposed) return;
        for (const [element, row] of rows) if (!element.isConnected) { row.remove(); rows.delete(element); }
        for (const element of managed ? owned : elements) draw(element);
    }
    if (managed) surface.registerParticipant({ id: 'amin-os/linkage-turns', protocolVersion: surface.protocolVersion, didMount: ({ element }) => {
        if (disposed) return; owned.add(element); draw(element);
        return () => { owned.delete(element); rows.get(element)?.remove(); rows.delete(element); };
    } });
    const scheduler = observeChatFloors(refresh, { document, getContext });
    const unsubscribe = api.subscribe(() => scheduler.refresh());
    return { refresh: () => scheduler.refresh(), dispose() { disposed = true; unsubscribe(); scheduler.dispose(); for (const row of rows.values()) row.remove(); rows.clear(); } };
}
