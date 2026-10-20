import { getState2Runtime } from '../apps/state2/runtime.js';
import { chatIdentity, chatPath } from '../apps/shared/operations.js';
import { assertChatReady } from '../apps/shared/chat-lifecycle.js';

const context = () => globalThis.SillyTavern?.getContext?.();
const make = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
};

function ensureSameChat(metadata, identity) {
  const current = context();
  if (current?.chatMetadata !== metadata || chatIdentity(current) !== identity) {
    throw Error('聊天已切换；请在当前聊天重新操作剧情存储。');
  }
}

// File recovery must remain available when native variables cannot restore.
// These view-only snapshots never authorize a metadata write or run the normal
// operation preparation, but still reject host loading and changed candidates.
function managementContext() {
  const ctx = context();
  assertChatReady(ctx);
  const id = ctx?.getCurrentChatId?.() ?? ctx?.chatId;
  if (!ctx?.chatMetadata || typeof ctx.chatMetadata !== 'object' || Array.isArray(ctx.chatMetadata)
      || !Array.isArray(ctx.chat) || id == null || id === '') throw Error('请先打开一个聊天。');
  return ctx;
}
function captureManagementContext() {
  const ctx = managementContext();
  return { metadata: ctx.chatMetadata, integrity: ctx.chatMetadata.integrity, identity: chatIdentity(ctx),
    path: JSON.stringify(chatPath(ctx.chat)),
    swipes: ctx.chat.map(message => Array.isArray(message.swipes) ? message.swipes.slice() : null) };
}
function assertManagementContext(token) {
  const ctx = managementContext();
  if (ctx.chatMetadata !== token.metadata || ctx.chatMetadata.integrity !== token.integrity
      || chatIdentity(ctx) !== token.identity || JSON.stringify(chatPath(ctx.chat)) !== token.path
      || ctx.chat.some((message, index) => {
        const before = token.swipes[index], now = Array.isArray(message.swipes) ? message.swipes : null;
        return (before === null) !== (now === null)
          || now && (now.length !== before.length || now.some((text, swipe) => text !== before[swipe]));
      })) throw Error('聊天或消息候选已变化，请在当前聊天重新操作剧情存储。');
  return ctx;
}

function downloadStory(bundle) {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = make('a');
  anchor.href = url;
  anchor.download = `amin-os-story-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.append(anchor);
  try { anchor.click(); }
  finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Independent current state management. The service owns import validation. */
function mountIndependentStoryStorage(target, report, getRuntime) {
  let disposed = false, busy = false, revision = 0, preview = null, backupList = null, importToken = null;
  const box = make('section', null, 'amin-card amin-stack');
  box.append(make('h3', 'Amin 剧情存储', 'amin-section-heading'));
  const mode = make('p', '正在读取当前剧情资料…', 'amin-meta');
  const notice = make('p', null, 'amin-notice'); notice.hidden = true;
  const toolbar = make('div', null, 'amin-toolbar');
  const importToolbar = make('div', null, 'amin-toolbar');
  const previewView = make('section', null, 'amin-card amin-stack'); previewView.hidden = true;
  const backupView = make('section', null, 'amin-stack'); backupView.hidden = true;
  const buttons = [];
  function button(label, action, target = toolbar) {
    const node = make('button', label); node.type = 'button'; node.onclick = action;
    buttons.push(node); target.append(node); return node;
  }
  function capture() {
    const ctx = managementContext();
    return { metadata: ctx.chatMetadata, integrity: ctx.chatMetadata.integrity, identity: chatIdentity(ctx) };
  }
  function check(token) {
    const ctx = managementContext();
    if (disposed || ctx.chatMetadata !== token.metadata || ctx.chatMetadata.integrity !== token.integrity
        || chatIdentity(ctx) !== token.identity) throw Error('聊天已切换，请在当前聊天重新操作剧情资料。');
    return ctx;
  }
  function clearPreview() { preview = null; previewView.textContent = ''; previewView.hidden = true; previewView.append(applyPreview); }
  function clearBackups() { backupList = null; backupView.textContent = ''; backupView.hidden = true; }
  function showPreview(value, token) {
    preview = { value, token }; previewView.textContent = ''; previewView.hidden = false;
    previewView.append(make('h4', '剧情资料预览', 'amin-section-heading'));
    if (value.summary) previewView.append(make('p', value.summary, 'amin-meta'));
    for (const module of value.modules ?? []) {
      const card = make('div', null, 'amin-card');
      const count = typeof module.count === 'string' ? module.count : `${module.count ?? 0} 项`;
      card.append(make('p', `${module.label || module.key}：${count}`, 'amin-meta'));
      if (module.error) card.append(make('p', String(module.error), 'amin-notice'));
      if (module.unmatchedReferences?.length) card.append(make('p', `未匹配引用：${module.unmatchedReferences.join('、')}`, 'amin-notice'));
      previewView.append(card);
    }
    for (const error of value.errors ?? []) previewView.append(make('p', error.message || String(error), 'amin-notice'));
    for (const warning of value.warnings ?? []) previewView.append(make('p', warning.message || String(warning), 'amin-meta'));
    previewView.append(make('p', '确认前不会写入资料。导入不会更改聊天正文、世界书、API 设置或全局能力库。', 'amin-meta'), applyPreview);
  }
  const source = make('select'); source.setAttribute?.('aria-label', '选择旧资料来源');
  for (const [value, label] of [['app', '当前应用中的旧资料'], ['native', '小白变量 2.0 中的旧资料']]) {
    const option = make('option', label); option.value = value; source.append(option);
  }
  source.value = 'app'; importToolbar.append(source);
  const legacy = button('预览导入旧资料', () => void run(async (runtime, token) => {
    const value = await runtime.previewLegacy({ source: source.value }); check(token);
    showPreview(value, token); report(value.valid === false ? '旧资料存在错误，请先核对预览。' : '旧资料已读取，请核对预览后确认导入。');
  }), importToolbar);
  const blank = button('开始空白剧情资料', () => void run(async (runtime, token) => {
    const result = await runtime.initializeEmpty(); check(token); clearPreview(); clearBackups();
    report(result?.message || '已建立空白剧情资料；聊天正文和旧变量保留。');
  }));
  const reset = button('备份并清空当前资料', () => void run(async (runtime, token) => {
    const status = runtime.status?.();
    const backupAvailable = (status?.backupAvailable ?? status?.available) !== false;
    const result = await runtime.reset(); check(token); clearPreview(); clearBackups();
    report((result?.message || (backupAvailable ? '已备份并清空当前剧情资料，可以重新生成。' : '当前剧情资料已清空，可以重新生成。'))
      + (backupAvailable ? '' : ' 外部备份不可用，本次未新增最近备份。'));
  }));
  const exportButton = button('导出当前剧情备份', () => void run(async (runtime, token) => {
    const bundle = await runtime.exportState(); check(token); downloadStory(bundle); report('当前剧情备份已下载。');
  }));
  if (typeof getRuntime()?.exportLegacySource === 'function') button('导出旧资料原件', () => void run(async (runtime, token) => {
    const bundle = await runtime.exportLegacySource(); check(token);
    downloadStory(bundle); report('旧资料原件已下载，当前剧情资料未改变。');
  }));
  const input = make('input'); input.type = 'file'; input.accept = '.json,application/json'; input.hidden = true;
  const importButton = button('预览导入剧情备份', () => {
    if (busy || disposed) return;
    try { importToken = capture(); input.value = ''; input.click(); }
    catch (error) { importToken = null; report(error.message, 'error'); }
  });
  input.onchange = () => {
    const file = input.files?.[0], token = importToken; importToken = null;
    if (!file || !token || disposed) return;
    void run(async runtime => {
      const raw = await file.text(); check(token);
      const value = await runtime.previewImport(raw); check(token); showPreview(value, token);
      report(value.valid === false ? '备份存在错误，请核对预览。' : '备份已读取，请核对预览后确认导入。');
    }, token);
  };
  const backups = button('查看最近备份', () => void run(async (runtime, token) => {
    const value = await runtime.listBackups(); check(token);
    backupList = { token, entries: Array.isArray(value) ? value : value.backups ?? [] }; renderBackups();
    report(backupList.entries.length ? `已读取 ${backupList.entries.length} 份最近备份。` : '当前没有备份。');
  }));
  const backupSelect = make('select'); backupSelect.setAttribute?.('aria-label', '选择最近剧情备份');
  const previewBackup = button('预览所选备份', () => void run(async runtime => {
    if (!backupList) throw Error('请先查看最近备份。');
    const token = backupList.token; check(token);
    const entry = backupList.entries.find(value => String(value.id) === backupSelect.value);
    if (!entry) throw Error('请选择一份备份。');
    const value = await runtime.previewBackup(entry.id); check(token); showPreview(value, token);
    report('所选备份已读取，请核对预览后确认应用。');
  }), backupView);
  const applyPreview = button('确认应用预览', () => void run(async runtime => {
    if (!preview) throw Error('请先预览需要导入的资料。');
    const selected = preview; check(selected.token);
    if (selected.value.valid === false) throw Error('预览中存在资料错误，未写入。');
    clearPreview();
    const result = await runtime.applyPreview(selected.value.plan); check(selected.token);
    clearBackups(); report(result?.message || '已应用预览中的剧情资料。');
  }), previewView);
  const refresh = button('刷新剧情存储状态', () => void loadStatus());
  box.append(mode, notice,
    make('p', '聊天内只保存当前剧情资料；最近备份与楼层检查点共用一个外部滚动区（默认 10 份，可在剧情存档中调整），不按楼层或回复候选回退。', 'amin-meta'),
    importToolbar, toolbar, input, previewView, backupView,
    make('p', '旧聊天请先选择来源、预览导入，或直接开始空白资料。导入会替换当前应用中的资料展示；如需保留完整原件，请先从酒馆导出聊天。聊天正文、旧变量和旧存档文件保留。重新生成前可使用「备份并清空当前资料」。', 'amin-meta'));
  target.append(box);
  function renderBackups() {
    backupView.textContent = ''; backupSelect.textContent = ''; backupView.hidden = false;
    for (const entry of backupList?.entries ?? []) {
      const date = Number.isFinite(Number(entry.at)) ? new Date(Number(entry.at)) : new Date(entry.at);
      const when = Number.isNaN(date.valueOf()) ? String(entry.at ?? '') : date.toLocaleString();
      const option = make('option', `${entry.label || '剧情备份'} · ${when}`); option.value = String(entry.id); backupSelect.append(option);
    }
    backupSelect.value = String(backupList?.entries[0]?.id ?? '');
    backupView.append(make('h4', '最近剧情备份', 'amin-section-heading'));
    if (!backupList?.entries.length) backupView.append(make('p', '当前没有备份。', 'amin-meta'));
    else backupView.append(backupSelect, previewBackup);
  }
  async function loadStatus() {
    const ticket = ++revision;
    try {
      const token = capture(), runtime = getRuntime(), status = await runtime?.status?.();
      if (disposed || ticket !== revision) return; check(token);
      for (const item of [preview, backupList]) {
        if (!item) continue;
        try { check(item.token); } catch { clearPreview(); clearBackups(); }
      }
      const enabled = status?.enabled ?? runtime?.ready?.() ?? false;
      // Current state is saved in chat metadata; only the rolling backup files
      // depend on Tauri's extension store being present.
      const available = !!runtime;
      const externalAvailable = (status?.backupAvailable ?? status?.available) !== false;
      reset.textContent = externalAvailable ? '备份并清空当前资料' : '清空当前资料重新生成';
      mode.textContent = enabled ? `当前聊天：Amin 剧情资料已启用 · 最近备份 ${status?.backupCount ?? 0} / ${status?.backupLimit ?? 10}。` : '当前聊天：尚未建立独立的 Amin 剧情资料。';
      notice.textContent = status?.error ? status.message || String(status.error) : status?.message || ''; notice.hidden = !notice.textContent;
      if (!externalAvailable) {
        notice.textContent += (notice.textContent ? ' ' : '') + '外部备份存储不可用；清空前可先导出当前剧情 JSON 备份。当前资料仍可在聊天内保存。';
        notice.hidden = false;
      }
      for (const node of buttons) node.disabled = busy || !available;
      reset.disabled ||= !enabled; exportButton.disabled ||= !enabled; backups.disabled ||= !enabled || !externalAvailable;
      applyPreview.disabled ||= !preview || preview.value.valid === false;
      previewBackup.disabled ||= !backupList?.entries.length || !externalAvailable;
      source.disabled = backupSelect.disabled = busy;
      refresh.disabled = busy;
    } catch (error) {
      if (disposed || ticket !== revision) return;
      clearPreview(); clearBackups(); mode.textContent = '剧情资料状态读取失败。'; notice.textContent = error.message; notice.hidden = false;
      for (const node of buttons) node.disabled = true; refresh.disabled = false;
      report(error.message, 'error');
    }
  }
  async function run(work, token) {
    if (busy || disposed) return;
    busy = true; for (const node of buttons) node.disabled = true; source.disabled = backupSelect.disabled = true;
    try {
      const runtime = getRuntime(); if (!runtime) throw Error('Amin 剧情存储尚未初始化，请刷新酒馆。');
      await work(runtime, token ?? capture());
    } catch (error) { if (!disposed) report(error.message, 'error'); }
    finally { busy = false; if (!disposed) await loadStatus(); }
  }
  clearPreview(); void loadStatus();
  return { dispose() { disposed = true; revision++; importToken = null; clearPreview(); clearBackups(); } };
}

/** Story storage is always the independent snapshot; legacy data is only an import source. */
export function mountStoryStorage(target, report, getRuntime = getState2Runtime) {
  return mountIndependentStoryStorage(target, report, getRuntime);
}
