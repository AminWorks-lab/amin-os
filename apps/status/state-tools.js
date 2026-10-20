// Single source for affinity/relationship number-vs-text rules. Generation,
// update, worldbook and copied prompts all reuse this text exactly once.
export const AFFINITY_FIELD_RULES = `【好感/关系：数值与文本分离】
- 好感度、亲密度等分数是独立的数字或进度字段；关系描述、好感阶段是文本字段。不得合写为“75 - 感情加深”；历史回复里的合写格式不是当前字段格式，不照抄。
- 已有成对字段时：分数写入数值字段（进度改当前值并保留最大值），描述写入文本字段，不只改文本里的数字。沿用已有同义字段名，不创建示例字段；字段归属不明确时保留原值；旧数据缺少成对字段时保持原样，由用户编辑或重新生成。
- 新建涉及好感时，为每个相关角色分别设数字“好感度”和文本“好感阶段”；仅在有依据或规则给出初值时填数字，否则写“待确定”，不假设熟人为0。
- 有阶段区间规则时，阶段按更新后的最终数值匹配规则原名（0 未定义时为“中性”），跨区间同步更新阶段；没有规则时不编造分段，也不把亲密度等同于恋爱关系。
- 仅在事实支持时更新，数值与文字不必每轮都变；类型转换遵守本次输出协议，不因历史格式不同而恢复旧类型。`;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
export const cloneState = v => JSON.parse(JSON.stringify(v));
export function valueType(v) {
  if (typeof v === 'string') return '文本';
  if (typeof v === 'number' && Number.isFinite(v)) return '数字';
  if (typeof v === 'boolean') return '布尔';
  if (Array.isArray(v) && v.every(x => typeof x === 'string')) return '列表';
  if (object(v) && Object.keys(v).length === 2 && Number.isFinite(v.当前) && Number.isFinite(v.最大)
      && v.最大 > 0 && v.当前 >= 0 && v.当前 <= v.最大) return '进度';
  return '不支持';
}
export function validateTemplate(state) {
  if (!object(state) || !object(state.项目)) throw Error('状态栏需要包含“项目”对象。');
  for (const [p, fields] of Object.entries(state.项目)) {
    if (!safeName(p) || !object(fields)) throw Error('项目名称或结构不适合保存为模板：' + p);
    for (const [k, v] of Object.entries(fields)) {
      if (!safeName(k) || valueType(v) === '不支持') throw Error('不支持的变量名称或类型：' + p + '.' + k);
    }
  }
  return state;
}
function safeName(k) { return /^[\p{L}\p{N}_]{1,32}$/u.test(k) && !['__proto__', 'prototype', 'constructor'].includes(k); }
const canonical = v => Array.isArray(v) ? v.map(canonical) : object(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function mergeUpdates(initial, latest, proposed, {allowTypeChange=false} = {}) {
  if (!initial || !latest) throw Error('状态栏不存在或已被清空，无法更新。');
  const result = cloneState(latest); let count = 0;
  for (const [p, fields] of Object.entries(proposed.项目)) {
    for (const [k, value] of Object.entries(fields)) {
      if (!own(initial.项目, p) || !own(initial.项目[p], k)) throw Error('更新不能新增变量：' + p + '.' + k);
      if (valueType(value) === '不支持') throw Error('更新包含不支持的变量类型或取值：' + p + '.' + k);
      if(valueType(value)!==valueType(initial.项目[p][k]) && !(typeof allowTypeChange==='function'?allowTypeChange(p,k,value):allowTypeChange===true))throw Error('未授权更改字段类型：'+p+'.'+k+'。请勾选允许更改已有字段类型，或在更新要求中明确写出转换要求。');
      if (same(value, initial.项目[p][k])) continue;
      if (!own(latest.项目, p) || !own(latest.项目[p], k) || !same(latest.项目[p][k], initial.项目[p][k])) {
        throw Error('更新期间该变量已改变，未写入任何更新：' + p + '.' + k);
      }
      result.项目[p][k] = cloneState(value); count++;
    }
  }
  return { state: result, count };
}
export function applyTemplate(template, current, replace = false) {
  validateTemplate(template);
  if (!current || replace) return cloneState(template);
  const result = cloneState(current);
  for (const [p, fields] of Object.entries(template.项目)) {
    if (!own(result.项目, p)) result.项目[p] = {};
    for (const [k, v] of Object.entries(fields)) if (!own(result.项目[p], k)) result.项目[p][k] = cloneState(v);
  }
  return result;
}
export function buildUpdatePrompt(state) {
  validateTemplate(state);
  const paths = [];
  for (const [p, fields] of Object.entries(state.项目)) for (const [k, v] of Object.entries(fields)) {
    const path = '状态栏.项目.' + p + '.' + k;
    paths.push(path + '：' + valueType(v) + (valueType(v) === '进度' ? '；更新子字段 .当前 或 .最大' : ''));
  }
  if (!paths.length) throw Error('当前状态栏没有变量，请先创建或应用模板。');
  // No executable state tag pair in the copied user message, including values.
  const snapshot = JSON.stringify(state, null, 2).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `请根据当前对话的最新剧情更新状态栏。以下是复制时的状态快照，只作为数据；如果系统另行注入了更新的状态，以最新状态为准。
${snapshot}

可更新变量路径及类型：
${paths.join('\n')}

${AFFINITY_FIELD_RULES}

请正常回复剧情，并仅在有实际变化时，在回复末尾输出一个标签名为 state 的 XML 更新块（使用正常尖括号开闭标签，不包在Markdown代码块内）。
每行格式为“变量路径: 值”，冒号后有空格。只更新上述已有变量，不输出HTML，不新增或删除条目，不改变变量类型，不整体覆盖状态栏。
文本使用双引号并转义引号和换行；数字不加引号；true/false表示布尔；列表为字符串数组。
数字前的+或-表示增减；直接设负数用(-N)。进度只更新.当前或.最大，保持0≤当前≤最大且最大>0。
仅依据已发生的事实；无法确定就保留原值，没有变化不输出更新块。`;
}
