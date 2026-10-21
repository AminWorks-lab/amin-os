import { LIMITS } from '../characters/model.js';

// Models summarising a rich worldbook often emit character attributes the
// adapter does not store (年龄、性格、身份…), echo the record id, or put
// appearance keys at the wrong level. The adapter stays strict; generation
// drafts fold those values into notes/features so one stray field does not
// discard the whole draft. Every folded or dropped key is reported.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const CHARACTER = ['name', 'kind', 'notes', 'stats', 'appearance'];
const APPEARANCE = ['description', 'hairstyle', 'features'];
const STAT = ['id', 'label', 'binding', 'component', 'check'];
const IDENTITY = ['id', 'target', 'characterId'];
const blank = value => value == null || value === '' || (Array.isArray(value) && !value.length) || (object(value) && !Object.keys(value).length);
const show = value => typeof value === 'string' ? value.trim() : Array.isArray(value) && value.every(item => typeof item !== 'object' || item === null) ? value.join('、') : JSON.stringify(value);

function append(text, entries, limit) {
    const lines = entries.map(([key, value]) => `${key}：${show(value)}`), kept = [];
    let next = typeof text === 'string' ? text.trim() : '';
    for (const line of lines) {
        const joined = next ? `${next}\n${line}` : line;
        if (joined.length > limit) break;
        next = joined; kept.push(line);
    }
    return { text: next, folded: kept.length };
}

export function normalizeCharacterChange(change, { previous, mode } = {}) {
    if (change?.module !== 'characters' || !object(change.data)) return { change, notes: [] };
    const data = { ...change.data }, notes = [], folded = [], dropped = [];
    for (const key of IDENTITY) if (Object.hasOwn(data, key) && (data[key] === change.target || blank(data[key]))) delete data[key];
    if (change.action === 'update-appearance') {
        if (object(data.appearance)) { const nested = data.appearance; delete data.appearance; for (const [key, value] of Object.entries(nested)) data[key] ??= value; }
        const extra = Object.entries(data).filter(([key]) => !APPEARANCE.includes(key));
        for (const [key] of extra) delete data[key];
        const usable = extra.filter(([, value]) => !blank(value));
        if (usable.length) {
            const base = data.features ?? previous?.appearance?.features ?? '';
            const result = append(base, usable, 2000);
            if (result.folded) data.features = result.text;
            folded.push(...usable.slice(0, result.folded).map(([key]) => key)); dropped.push(...usable.slice(result.folded).map(([key]) => key));
        }
    } else if (['create-character', 'update-character'].includes(change.action)) {
        const loose = Object.entries(data).filter(([key]) => APPEARANCE.includes(key));
        if (loose.length) { data.appearance = object(data.appearance) ? { ...data.appearance } : {}; for (const [key, value] of loose) { data.appearance[key] ??= value; delete data[key]; } }
        if (object(data.appearance)) {
            const extra = Object.entries(data.appearance).filter(([key]) => !APPEARANCE.includes(key));
            if (extra.length) { data.appearance = Object.fromEntries(Object.entries(data.appearance).filter(([key]) => APPEARANCE.includes(key))); for (const [key, value] of extra) data[`外观·${key}`] = value; }
        }
        if (Array.isArray(data.stats)) data.stats = data.stats.map(stat => {
            if (!object(stat)) return stat;
            const clean = Object.fromEntries(Object.entries(stat).filter(([key]) => STAT.includes(key)));
            // Numbers belong to World Status; a stat only names its binding.
            const removed = Object.keys(stat).filter(key => !STAT.includes(key));
            if (removed.length) dropped.push(...removed.map(key => `stats.${key}`));
            if (clean.check === undefined) clean.check = 'none';
            return clean;
        });
        const extra = Object.entries(data).filter(([key]) => !CHARACTER.includes(key));
        for (const [key] of extra) delete data[key];
        const usable = extra.filter(([, value]) => !blank(value));
        if (usable.length) {
            // Supplement mode only fills blanks, so existing notes are never rewritten.
            const existing = previous?.notes?.trim() ?? '';
            if (mode === 'supplement' && existing) dropped.push(...usable.map(([key]) => key));
            else {
                const result = append(data.notes ?? existing, usable, LIMITS.text);
                if (result.folded) data.notes = result.text;
                folded.push(...usable.slice(0, result.folded).map(([key]) => key)); dropped.push(...usable.slice(result.folded).map(([key]) => key));
            }
        }
    }
    const name = data.name ?? previous?.name ?? change.target;
    if (folded.length) notes.push(`人物「${name}」的 ${folded.join('、')} 不是人物卡字段，已并入${change.action === 'update-appearance' ? '外貌特征' : '备注'}。`);
    if (dropped.length) notes.push(`人物「${name}」的 ${[...new Set(dropped)].join('、')} 无法保存，已忽略。`);
    return { change: { ...change, data }, notes };
}
