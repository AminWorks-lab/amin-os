// Global search on the Amin home screen. Pure functions: the caller reads each app's
// current data (see sources.js) and opens results; nothing here touches the host.
export const SEARCH_APPS = Object.freeze([
    { id: 'characters', label: '人物卡' },
    { id: 'inventory', label: '背包与账本' },
    { id: 'journal', label: '剧情档案' },
    { id: 'map', label: '地图' },
    { id: 'organizations', label: '势力概览' },
    { id: 'information', label: '信息面板' },
    { id: 'effects', label: '能力面板' },
]);
const JOURNAL_KINDS = { task: '任务', clue: '线索', fact: '事实', hook: '伏笔', chronicle: '编年史', knowledge: '人物记忆', prior: '前作参考' };
const JOURNAL_TABS = { task: 'task', clue: 'clue', hook: 'hook', chronicle: 'chronicle', fact: 'memory', knowledge: 'memory', prior: 'prior' };
const ORGANIZATION_GROUPS = { organizations: '组织', alliances: '联盟', regions: '地区' };
const INFORMATION_KINDS = { person: '人物', thing: '事物', world: '世界' };
const text = value => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
const list = value => Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
export const normalizeQuery = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();

/** Flattens app data into searchable entries. Each entry carries the request its app takes on open. */
export function buildSearchIndex(data = {}) {
    const entries = [];
    const add = (app, id, label, { kind = '', detail = '', extra = [], request } = {}) => {
        const name = text(label).trim();
        if (id == null || id === '' || !name) return;
        entries.push({ app, id: String(id), label: name, kind, detail: text(detail).trim().slice(0, 120),
            haystack: normalizeQuery([name, kind, detail, ...extra.map(text)].join(' ')), request: request ?? { focus: String(id) } });
    };
    for (const person of list(data.characters)) add('characters', person?.id, person?.name, { kind: person?.kind === 'npc' ? 'NPC' : '人物', detail: person?.notes, extra: [person?.title, ...(person?.aliases ?? [])] });
    for (const item of list(data.inventory?.items)) add('inventory', item?.id, item?.name, { kind: '物品', detail: item?.notes, extra: [item?.unit], request: { focus: String(item?.id), tab: 'items', query: text(item?.name) } });
    for (const balance of list(data.inventory?.balances)) add('inventory', balance?.id, balance?.name, { kind: '资源', detail: balance?.notes, extra: [balance?.unit], request: { focus: String(balance?.id), tab: 'balances', query: text(balance?.name) } });
    for (const entry of list(data.journal)) {
        if (entry?.current === false || !Object.hasOwn(JOURNAL_KINDS, entry?.kind)) continue;
        add('journal', entry.id, entry.title, { kind: JOURNAL_KINDS[entry.kind], detail: entry.body ?? entry.content, extra: list(entry.actors), request: { focus: String(entry.id), tab: JOURNAL_TABS[entry.kind], query: text(entry.title) } });
    }
    for (const [mapId, map] of Object.entries(data.map?.maps ?? {})) {
        for (const [nodeId, node] of Object.entries(map?.nodes ?? {})) {
            if (node?.discovered === false) continue;
            const id = node?.id ?? nodeId;
            add('map', `${map?.id ?? mapId}/${id}`, node?.name ?? node?.label, { kind: '地点', detail: [map?.name, node?.description].filter(Boolean).join(' · '), request: { focus: { mapId: String(map?.id ?? mapId), nodeId: String(id) } } });
        }
    }
    const doc = data.organizations?.doc ?? data.organizations ?? {};
    for (const [group, label] of Object.entries(ORGANIZATION_GROUPS)) for (const [id, value] of Object.entries(doc?.[group] ?? {})) {
        add('organizations', id, value?.name, { kind: label, detail: value?.summary, extra: [value?.type], request: { focus: id, group } });
    }
    for (const record of list(data.information)) {
        const fields = list(record?.fields);
        add('information', record?.id, record?.name ?? record?.title, { kind: INFORMATION_KINDS[record?.kind] ?? '资料', detail: fields.slice(0, 3).map(field => `${text(field?.label)}：${text(field?.value)}`).join('；'),
            extra: fields.flatMap(field => [field?.label, field?.value, field?.category]) });
    }
    for (const skill of list(data.effects?.skills)) {
        if (skill?.ui?.hidden) continue;
        add('effects', skill?.id, skill?.name, { kind: '能力', detail: skill?.book ? `${skill.book}` : '', extra: [skill?.original, skill?.reminder], request: { focus: String(skill?.id), tab: '能力管理' } });
    }
    for (const effect of list(data.effects?.active)) add('effects', effect?.id, effect?.name ?? effect?.title, { kind: '生效中', detail: effect?.summary ?? effect?.notes, request: { focus: String(effect?.id), tab: '生效中' } });
    return entries;
}

// Lower is better: exact name, name prefix, name contains, then any other field.
function score(entry, terms, query) {
    const label = normalizeQuery(entry.label);
    if (!terms.every(term => entry.haystack.includes(term))) return null;
    if (label === query) return 0;
    if (label.startsWith(query)) return 1;
    if (label.includes(query)) return 2;
    if (terms.every(term => label.includes(term))) return 3;
    return 4;
}

/** Groups matching entries by app in SEARCH_APPS order; `limit` caps each group. */
export function searchIndex(entries, query, { limit = 5 } = {}) {
    const normalized = normalizeQuery(query), terms = normalized.split(' ').filter(Boolean);
    if (!terms.length) return [];
    const groups = new Map();
    for (const entry of entries) {
        const rank = score(entry, terms, normalized);
        if (rank === null) continue;
        if (!groups.has(entry.app)) groups.set(entry.app, []);
        groups.get(entry.app).push({ entry, rank });
    }
    return SEARCH_APPS.filter(app => groups.has(app.id)).map(app => {
        const matches = groups.get(app.id).sort((a, b) => a.rank - b.rank || a.entry.label.length - b.entry.label.length || a.entry.label.localeCompare(b.entry.label, 'zh-CN'));
        return { app: app.id, label: app.label, total: matches.length, results: matches.slice(0, limit).map(match => match.entry) };
    });
}
