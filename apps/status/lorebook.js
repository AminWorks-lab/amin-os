import { saveChatMetadata } from '../shared/chat-save.js';
// Marks the world status entry that pre-0.18 versions wrote into a bound
// worldbook. The linkage host still recognises it to suppress it during scans.
export const ENTRY_MARKER = 'world-status-hud/variable-update-v1';
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function boundWorldbook(ctx) {
  const character = ctx.characters?.[ctx.characterId];
  if (ctx.groupId || !character) throw Error('请先打开需要写入的单角色聊天。');
  const name = character.data?.extensions?.world || character.extensions?.world;
  if (typeof name !== 'string' || !name.trim()) throw Error('当前角色卡未绑定主世界书。请先在角色卡中绑定世界书，再点击写入。');
  return name;
}

export function prepareUpdateEntry(original, name, createEntry, extraPrompt = '', options = {}) {
  const {ownerField='world_status_hud_owner',marker=ENTRY_MARKER,title,prompt,enabled=true}=options;
  if (typeof title !== 'string' || typeof prompt !== 'string') throw Error('世界书条目缺少标题或内容，未写入。');
  if (!original || !original.entries || typeof original.entries !== 'object' || Array.isArray(original.entries)) throw Error('绑定的世界书格式不兼容，未写入。');
  const book = clone(original);
  const owned = Object.values(book.entries).filter(e => e?.[ownerField] === marker);
  if (owned.length > 1) throw Error('世界书中存在多个本插件的更新条目，请先保留一个后重试。');
  const previous = owned[0] ? clone(owned[0]) : null;
  const entry = owned[0] || createEntry(name, book);
  if (!entry || !Number.isInteger(entry.uid) || book.entries[entry.uid] !== entry) throw Error('无法创建世界书条目，未写入。');
  Object.assign(entry, {
    [ownerField]: marker, comment: title, content: prompt + (extraPrompt ? '\n\n' + extraPrompt : ''),
    constant: true, disable: !enabled, selective: false, vectorized: false, key: [], keysecondary: [],
    position: 1, order: 100, role: 0, probability: 100, useProbability: false,
    excludeRecursion: true, preventRecursion: true, delayUntilRecursion: 0,
    group: '', groupOverride: false, sticky: null, cooldown: null, delay: null,
    triggers: [], characterFilter: { isExclude: false, names: [], tags: [] },
  });
  return { book, entry, previous, changed: !same(book, original) };
}

export async function installUpdateEntry({ context, check, extraPrompt = '', fetcher = fetch, loadModule = () => import('/scripts/world-info.js'), entryOptions = {} }) {
  check();
  const ctx = context(); const name = boundWorldbook(ctx);
  const wi = await loadModule();
  const guard = () => { check(); if (boundWorldbook(context()) !== name) throw Error('角色卡绑定的世界书已改变，已停止写入。'); };
  guard();
  if (typeof ctx.getRequestHeaders !== 'function' || typeof wi.createWorldInfoEntry !== 'function') throw Error('当前酒馆缺少世界书读写接口，请更新酒馆后重试。');
  async function request(route, body) {
    const response = await fetcher('/api/worldinfo/' + route, {
      method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify(body), cache: 'no-store',
    });
    if (!response.ok) throw Error(`世界书${route === 'edit' ? '保存' : '读取'}失败（${response.status}），请检查酒馆连接与权限。`);
    return response;
  }
  const original = await (await request('get', { name })).json(); guard();
  // Do not replace edits that are still in the world's editor/cache.
  const cached = wi.worldInfoCache?.get(name);
  if (cached && !same(cached, original)) throw Error('世界书编辑器中有尚未同步的修改，请保存并关闭编辑器后重试。');
  const prepared = prepareUpdateEntry(original, name, wi.createWorldInfoEntry, extraPrompt, entryOptions);
  if (!prepared.changed) return { name, uid: prepared.entry.uid, action: '已存在，无需重复写入' };
  if (prepared.previous) {
    const backups = ctx.chatMetadata[entryOptions.backupKey || 'world_status_hud_lorebook_backups'] ||= [];
    backups.push({ name, entry: prepared.previous, savedAt: Date.now() });
    if (backups.length > 10) backups.splice(0, backups.length - 10);
    await saveChatMetadata(ctx); guard();
  }
  const latest = await (await request('get', { name })).json(); guard();
  const currentCache = wi.worldInfoCache?.get(name);
  if (!same(latest, original) || (currentCache && !same(currentCache, original))) throw Error('世界书刚被其他操作修改，本次未覆盖，请重试。');
  await request('edit', { name, data: prepared.book });
  // Update the host cache only after the server accepted the write.
  wi.worldInfoCache?.set(name, clone(prepared.book));
  let warning = '';
  try {
    const verified = await (await request('get', { name })).json();
    if (!same(verified, prepared.book)) warning = '保存请求已完成，但读回内容不同，请在世界书中检查条目。';
  } catch { warning = '保存请求已完成，但未能读回校验，请在世界书中检查条目。'; }
  const events = ctx.eventTypes || ctx.event_types || {};
  try { if (events.WORLDINFO_UPDATED) await ctx.eventSource?.emit(events.WORLDINFO_UPDATED, name, clone(prepared.book)); }
  catch { warning += ' 世界书界面刷新失败，请重新打开世界书。'; }
  // Once a request was submitted it may have saved even if the user switched chats.
  return { name, uid: prepared.entry.uid, action: prepared.previous ? '已更新' : '已新增', warning };
}
