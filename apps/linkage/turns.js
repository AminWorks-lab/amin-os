// Plain-language summaries of one applied <amin_update> batch and of rejected batches.
// Kept free of host access so the floor row, the linkage page and tests share them.

const NOUNS = { characters: '人物', inventory: '物品', relationships: '关系', scene: '场景', journal: '档案', effects: '效果', map: '地点', organizations: '势力', information: '资料', status: '状态' };
// Canonical action names (create-*, delete-*, end-effect …) plus legacy spellings.
const CREATE = /^(?:create|add)(?:$|[-_])/u, REMOVE = /^(?:delete|remove|forget|end)(?:$|[-_])/u;
const short = (value, limit = 24) => { const text = String(value ?? '').replace(/\s+/gu, ' ').trim(); return text.length > limit ? text.slice(0, limit - 1) + '…' : text; };
// A status value as plain text: progress fields {当前, 最大} show the part that changed.
function plainValue(raw, part) {
    let value; try { value = JSON.parse(raw); } catch { return String(raw); }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (part === '最大' && Object.hasOwn(value, '最大')) value = value.最大;
        else if (Object.hasOwn(value, '当前')) value = Object.hasOwn(value, '最大') && part !== '当前' && !part ? `${value.当前}/${value.最大}` : value.当前;
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Headline pieces such as “+1 人物”, “生命 76→60”, “时间 +30 分钟”, plus one line per change. */
export function summarizeChanges(changes = [], descriptions = []) {
    const counts = new Map(), pieces = [], items = [];
    const bump = (sign, module) => { const key = sign + (NOUNS[module] ?? module); counts.set(key, (counts.get(key) ?? 0) + 1); };
    changes.forEach((change, index) => {
        const description = String(descriptions[index] ?? change.reason ?? '').trim();
        const match = change.module === 'status' ? /^世界状态 (.+?)：(.+) → (.+)$/u.exec(description) : null;
        if (match) {
            const [path, part] = match[1].split(' · '), name = path.split('.').at(-1).trim() + (part === '最大' ? '上限' : '');
            const before = plainValue(match[2], part), after = plainValue(match[3], part);
            items.push(`世界状态 ${path.trim()}${part === '最大' ? ' 上限' : ''}：${before} → ${after}`);
            pieces.push(`${short(name, 12)} ${short(before, 10)}→${short(after, 10)}`); return;
        }
        items.push(description || `${NOUNS[change.module] ?? change.module} · ${change.action}`);
        if (change.module === 'scene' && ['advance-time', 'log-activity', 'activity'].includes(change.action)) {
            const minutes = change.action === 'advance-time' ? change.data?.minutes : change.before?.timeRules?.[change.data?.activity] * (change.data?.count ?? 1);
            pieces.push(Number.isFinite(minutes) ? `时间 +${minutes >= 60 && minutes % 60 === 0 ? minutes / 60 + ' 小时' : minutes + ' 分钟'}` : '时间推进');
            return;
        }
        if (CREATE.test(change.action)) bump('+', change.module);
        else if (REMOVE.test(change.action)) bump('−', change.module);
        else bump('', change.module);
    });
    const counted = [...counts].map(([key, count]) => /^[+−]/u.test(key) ? `${key[0]}${count} ${key.slice(1)}` : `${key}${count > 1 ? ' ×' + count : ''}`);
    return { headline: [...counted, ...pieces], items };
}
export function headlineText(summary, limit = 4) {
    const parts = summary.headline.slice(0, limit);
    return '本轮更新：' + (parts.join(' · ') || '无可见变化') + (summary.headline.length > limit ? ` 等 ${summary.headline.length} 项` : '');
}

// Rejection reasons fall into four groups shown on the linkage page.
export const REJECTION_CATEGORIES = Object.freeze({ format: '格式', permission: '权限', reference: '引用', validation: '校验' });
export function rejectionCategory(error) {
    if (error?.linkageCategory && Object.hasOwn(REJECTION_CATEGORIES, error.linkageCategory)) return error.linkageCategory;
    const message = String(error?.message ?? error ?? '');
    if (/权限|更新范围|只支持读取|不能整体替换|不能通过剧情更新修改/u.test(message)) return 'permission';
    if (/引用/u.test(message)) return 'reference';
    return 'validation';
}
/** The update payload alone (between the tags when present), capped for display. */
export function rawUpdateText(raw, limit = 20000) {
    let text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2) ?? '';
    const match = /\\?<amin\\?_update\\?>([\s\S]*?)\\?<\/amin\\?_update\\?>/u.exec(text);
    if (match) text = match[1];
    text = text.trim();
    return text.length > limit ? text.slice(0, limit) + '\n…（已截断）' : text;
}
