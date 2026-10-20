import { isChatReady } from '../shared/chat-lifecycle.js';
import { isIndependent, STATE_KEY } from '../story-state/access.js';
// Retired per-floor records (0.17 and earlier) stay readable in chat metadata.
// Observing a chat never assigns message IDs, records floors or saves.
export const HISTORY_KEY = 'world_status_hud_history_v1';
const copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
export function createHistory({ context, read, changed = () => {}, historyKey = HISTORY_KEY, messageKey = 'wsh_message_id', allowGroups = false, externalRead = null }) {
  let metadata, chatId, observed = [], revision;
  const listeners = new Set();
  const emit = () => { changed(); for (const fn of listeners) fn(); };
  const usable = c => isChatReady(c) && !!c.chatMetadata && c.getCurrentChatId() != null && (!c.groupId || allowGroups);
  const revisionOf = c => isIndependent(c) ? JSON.stringify(c.chatMetadata[STATE_KEY]?.revision) : JSON.stringify(Object.keys(records(c)).length);
  function records(c) {
    const store = c?.chatMetadata?.[historyKey];
    return plain(store) && plain(store.records) ? store.records : {};
  }
  function observe(c) {
    const switched = metadata !== c.chatMetadata || chatId !== c.getCurrentChatId();
    const now = (c.chat || []).map(m => ({ message: m, variant: String(m.swipe_id ?? 0), name: m.name, content: m.mes, id: m.extra?.[messageKey] ?? null }));
    const next = revisionOf(c);
    const dirty = switched || next !== revision || now.length !== observed.length || now.some((m, i) =>
      m.message !== observed[i]?.message || m.variant !== observed[i]?.variant || m.content !== observed[i]?.content ||
      m.name !== observed[i]?.name || m.id !== observed[i]?.id);
    metadata = c.chatMetadata; chatId = c.getCurrentChatId(); observed = now; revision = next;
    return dirty;
  }
  function sync() {
    const c = context();
    if (usable(c) && observe(c)) emit();
  }
  function list() {
    const c = context();
    if (metadata !== c.chatMetadata || chatId !== c.getCurrentChatId()) return [];
    if (isIndependent(c)) return (c.chat || []).map((m, index) => ({
      index, name: m.name || (m.is_user ? '用户' : '角色'), available: index === c.chat.length - 1, external: true,
    }));
    const saved = records(c);
    return (c.chat || []).map((m, index) => {
      const id = m.extra?.[messageKey];
      const record = id ? saved[id + ':' + String(m.swipe_id ?? 0)] : undefined;
      return { index, name: m.name || (m.is_user ? '用户' : '角色'), available: !!record, state: copy(record?.state), savedAt: record?.savedAt };
    });
  }
  async function readFloor(index) {
    const c = context();
    if (!Number.isInteger(index) || index < 0 || index >= (c?.chat?.length ?? 0)) throw Error('楼层不存在。');
    if (!isIndependent(c)) {
      const row = list().find(row => row.index === index);
      if (!row?.available) throw Error('此楼层尚无记录。');
      return row;
    }
    if (index !== c.chat.length - 1) throw Error('独立剧情存储只保留当前资料，旧楼层没有单独状态快照。');
    const metadataAtStart = c.chatMetadata, message = c.chat[index], variant = String(message.swipe_id ?? 0), content = message.mes, indexId = revisionOf(c);
    const state = typeof externalRead === 'function' ? await externalRead(index, c) : read();
    const current = context();
    if (current?.chatMetadata !== metadataAtStart || current.chat?.[index] !== message || String(message.swipe_id ?? 0) !== variant
        || message.mes !== content || revisionOf(current) !== indexId)
      throw Error('聊天或楼层已变化，请重新打开记录。');
    return { index, name: message.name || (message.is_user ? '用户' : '角色'), available: true, external: true, state: copy(state), variant, content, indexId };
  }
  /** A shared operation already saved the state; only refresh observers. */
  function adoptExternal() {
    const c = context();
    if (!usable(c)) return false;
    observe(c); emit();
    return true;
  }
  return { sync, adoptExternal, list, readFloor, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, dispose() { listeners.clear(); } };
}
