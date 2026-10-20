import { uuid } from '../../uuid.js';
import { AFFINITY_FIELD_RULES } from './state-tools.js';
// Field-structure rules (separate number/stage fields, stage sync) are appended
// once by compileRules from AFFINITY_FIELD_RULES; the sample keeps only its table.
export const AFFINITY_RULE = `好感度:

- 0 对应“中性”，不代表已经认识或建立关系。例如：好感度为75，好感阶段为“感情加深”；好感度为-25，好感阶段为“明确的厌恶感”。

- 数值范围: 正向 1~120, 负向 -1~-120
- 每 10 点对应一个阶段
- 每次判定的好感度变化：1D3
- 不认识 {{user}} 的 NPC 初始好感度基本为 0
- 初始好感度的变化：(1. 受 {{user}} 的名声影响, 2. 受初次见面情境影响)

正向:
1. 初次见面 (1 ~ 10)
2. 友好关系 (11 ~ 20)
3. 要好关系 (21 ~ 30)
4. 挚友 (31 ~ 40)
5. 重要的存在 (41 ~ 50)
6. 特别的存在 (51 ~ 60)
7. 情感萌芽 (61 ~ 70)
8. 感情加深 (71 ~ 80)
9. 深度牵绊 (81 ~ 90)
10. 稳定亲密关系 (91 ~ 100)
11. 无可替代的存在 (101 ~ 120)

负向:
1. 微微不快 (-1 ~ -10)
2. 略微抗拒/有些不擅长应对 (-11 ~ -20)
3. 明确的厌恶感 (-21 ~ -30)
4. 强烈不快 (-31 ~ -40)
5. 厌恶加深 (-41 ~ -50)
6. 萌生憎恨 (-51 ~ -60)
7. 敌意增强 (-61 ~ -70)
8. 激烈的憎恶 (-71 ~ -80)
9. 甚至感到杀意 (-81 ~ -90)
10. 憎恶的巅峰 (-91 ~ -100)
11. 怨恨的极致 (-101 ~ -110)
12. 疯狂的憎恶 (-111 ~ -120)`;

export function ruleCardKey(ctx) {
  const avatar = ctx.characters?.[ctx.characterId]?.avatar;
  if (ctx.groupId || typeof avatar !== 'string' || !avatar) throw Error('请打开单角色聊天后编辑状态规则。');
  return avatar;
}
export function readRules(ctx, settingsKey) {
  const key = ruleCardKey(ctx), all = ctx.extensionSettings[settingsKey]?.rulesByCharacter || {};
  return JSON.parse(JSON.stringify(Object.prototype.hasOwnProperty.call(all, key) && Array.isArray(all[key]) ? all[key] : []));
}
export function readGlobalRules(ctx, settingsKey) {
  const rules = ctx.extensionSettings[settingsKey]?.globalRules;
  return JSON.parse(JSON.stringify(Array.isArray(rules) ? rules : []));
}
export function compileRules(ctx, settingsKey, scope, expandNames = true) {
  const applicable = rules => rules.filter(r => r.enabled && (r.scope === 'both' || r.scope === scope) && r.content?.trim());
  const global = applicable(readGlobalRules(ctx, settingsKey)), character = applicable(readRules(ctx, settingsKey));
  if (!global.length && !character.length) return '';
  const section = (label, rules) => rules.length ? label + '\n' + rules.map((r, i) => `${i + 1}. ${r.title || '未命名规则'}\n${r.content}`).join('\n\n') : '';
  let text = '【用户设置的状态规则】\n这些规则仅规范状态栏字段的设计、初值和数值变化，不要求在剧情正文中逐条复述。遵守任务的输出格式和变量类型约束。规则给出的明确初值可作为初始化依据；更新时不重置已有值。\n'
    + '全体规则与当前角色规则共同生效；对同一事项发生冲突时，以当前角色规则为准。\n'
    + [section('【全体规则】', global), section('【当前角色规则】', character)].filter(Boolean).join('\n\n');
  if (expandNames) text = text.replace(/\{\{user\}\}/gi, () => ctx.name1 || '用户').replace(/\{\{char\}\}/gi, () => ctx.characters?.[ctx.characterId]?.name || ctx.name2 || '角色');
  if (text.includes('好感')) text += '\n' + AFFINITY_FIELD_RULES;
  if (text.length > 30000) throw Error('启用的状态规则超过 30000 字符，请精简或关闭部分条目。');
  return text;
}

export function createRulesPage({ context, settingsKey, node, check, syncWorldbook, isUnified = () => false }) {
  const page = node('section', undefined, 'wsh-generation-page wsh-rules-page');
  const cardKey = ruleCardKey(context());
  let collection = 'character';
  let rules = readRules(context(), settingsKey);
  const initialNotice = () => isUnified() ? '修改自动保存；允许模型更新世界状态时，统一条目动态读取启用的更新规则。' : '修改自动保存；生成和更新会合并全体规则与当前角色规则。';
  const savedNotice = () => isUnified() ? '已保存。生成和更新立即使用；统一联动会动态读取启用的更新规则，可到“联动更新”查看条目预览。' : '已保存。生成和更新立即使用；日常聊天需点击“同步到世界书”更新已写入的规则。';
  let lastInitialNotice=initialNotice(),lastSavedNotice=savedNotice();
  const status = node('p', lastInitialNotice, 'wsh-quick-status'); status.setAttribute('role', 'status');
  const collectionLabel = node('label', '规则分类'), collectionPicker = node('select', undefined, 'text_pole');
  for (const [value, label] of [['global', '全体规则 · 所有角色共用'], ['character', '角色规则 · 仅当前角色']]) { const option = node('option', label); option.value = value; collectionPicker.append(option); }
  collectionPicker.value = collection; collectionLabel.append(collectionPicker);
  const actions = node('div', undefined, 'wsh-actions'), list = node('div');
  function save() {
    check(); const ctx = context(); if (ruleCardKey(ctx) !== cardKey) throw Error('角色已切换，请重新打开规则页。');
    const settings = ctx.extensionSettings[settingsKey] ||= {};
    if (collection === 'global') settings.globalRules = JSON.parse(JSON.stringify(rules));
    else settings.rulesByCharacter = { ...settings.rulesByCharacter, [cardKey]: JSON.parse(JSON.stringify(rules)) };
    ctx.saveSettingsDebounced();
    status.textContent = savedNotice();
  }
  function protect(fn) { return () => { try { check(); fn(); } catch (e) { status.textContent = e.message; } }; }
  collectionPicker.onchange = protect(() => {
    collection = collectionPicker.value;
    rules = collection === 'global' ? readGlobalRules(context(), settingsKey) : readRules(context(), settingsKey);
    render();
    status.textContent = collection === 'global' ? '正在编辑全体规则，修改适用于所有角色。' : '正在编辑当前角色规则，旧版本规则保留在这里。';
  });
  function action(label, fn) { const b = node('button', label, 'menu_button'); b.type = 'button'; b.onclick = protect(fn); actions.append(b); return b; }
  function add(sample = false) {
    const id = uuid();
    rules.push({ id, title: sample ? '好感度规则示例' : '新规则', content: sample ? AFFINITY_RULE : '', scope: 'both', enabled: true }); save(); render(id);
  }
  action('＋ 新建规则', () => add()); action('添加好感度示例', () => add(true));
  const sync = action('同步到世界书', () => {});
  sync.onclick = async () => { sync.disabled = true; try { check(); save(); status.textContent = await syncWorldbook(); } catch (e) { status.textContent = e.message; } finally { sync.disabled = false; } };
  function render(openId) {
    list.replaceChildren();
    if (!rules.length) list.append(node('p', '暂无规则。新建自己的规则，或添加示例后修改。', 'wsh-note'));
    for (const rule of rules) {
      const card = node('details', undefined, 'wsh-rule-card'); card.open = rule.id === openId;
      const summary = node('summary', undefined, 'wsh-rule-summary');
      const summaryTitle = node('span', undefined, 'wsh-rule-title'), summaryMeta = node('span', undefined, 'wsh-rule-meta');
      function refreshSummary() {
        summaryTitle.textContent = rule.title || '未命名规则';
        summaryMeta.textContent = (rule.enabled ? '已启用' : '已停用') + ' · ' + ({ both: '生成与更新', generate: '仅生成', update: '仅更新' }[rule.scope] || '未选择范围');
      }
      refreshSummary(); summary.append(summaryTitle, summaryMeta); card.append(summary);
      const titleLabel = node('label', '条目名称'), title = node('input', undefined, 'text_pole'); title.value = rule.title; title.maxLength = 100;
      const enabledLabel = node('label', '启用'), enabled = node('input'); enabled.type = 'checkbox'; enabled.checked = !!rule.enabled; enabledLabel.append(enabled);
      const scopeLabel = node('label', '适用范围'), scope = node('select', undefined, 'text_pole');
      for (const [value, label] of [['both', '生成与更新'], ['generate', '仅生成／补充'], ['update', '仅更新数值']]) { const o = node('option', label); o.value = value; scope.append(o); }
      scope.value = rule.scope;
      const contentLabel = node('label', '规则内容'), content = node('textarea', undefined, 'text_pole'); content.value = rule.content; content.rows = 10; content.maxLength = 20000;
      titleLabel.append(title); scopeLabel.append(scope); contentLabel.append(content);
      title.oninput = protect(() => { rule.title = title.value; save(); refreshSummary(); });
      content.oninput = protect(() => { rule.content = content.value; save(); });
      scope.onchange = protect(() => { rule.scope = scope.value; save(); refreshSummary(); });
      enabled.onchange = protect(() => { rule.enabled = enabled.checked; save(); refreshSummary(); });
      const remove = node('button', '删除规则', 'menu_button'); remove.type = 'button'; remove.onclick = protect(() => { if (confirm('删除规则“' + rule.title + '”？')) { rules = rules.filter(r => r.id !== rule.id); save(); render(); } });
      card.append(titleLabel, enabledLabel, scopeLabel, contentLabel, remove); list.append(card);
    }
  }
  const introduction=node('p','','wsh-note'),scopeNotice=node('p','','wsh-note');
  page.refreshLinkageMode=()=>{
    introduction.textContent='全体规则与当前角色规则共同参与按设定生成、补充和更新；冲突时提示模型优先遵守角色规则。支持 {{user}} 和 {{char}}。'+(isUnified()?'日常聊天由联动更新统一管理；允许更新世界状态时动态读取本页启用的更新规则。':'日常聊天需同步到各角色绑定的世界书。');
    scopeNotice.textContent='规则是模型提示，不是代码强制约束。1D3 不代表插件实际掷骰。示例按原文保留：正向最后一档为 101～120。'+(isUnified()?'统一条目按当前聊天和角色展开；全体规则仍适用于所有角色。':'多个角色共用同一本世界书时，最近同步的更新规则也会被其他绑定角色使用。');
    const previous=status.textContent;
    if(previous===lastInitialNotice)status.textContent=initialNotice();else if(previous===lastSavedNotice)status.textContent=savedNotice();
    lastInitialNotice=initialNotice();lastSavedNotice=savedNotice();
  };
  page.append(node('h3', '状态规则库'), introduction, collectionLabel, actions, status,scopeNotice, list);
  page.refreshLinkageMode();
  render(); return page;
}
