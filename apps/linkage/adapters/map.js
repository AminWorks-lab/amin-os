import { validateDocument } from '../../map/src/core/protocol.js';
import { prepareDocument, DIRECTIONS } from '../../map/src/core/spatial.js';
import { compileMapUpdate } from '../../map/src/integrations/tool-calling.js';
import { legacyModule, isIndependent } from '../../story-state/access.js';
import { renderContract, canonicalChange } from '../contract.js';

const KEY = 'dynamicMapV1', HISTORY = 'dynamicMapPositionHistoryV1';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const visible = node => node?.discovered && node.ai?.includeInContext;
// Models write 东北, north-east or North East; the map stores the 16 compass ids.
const DIRECTION_NAMES = new Map(DIRECTIONS.flatMap(({ id, label }) => [[id, id], [id.replace(/-/g, ''), id], [label, id], [label + '方', id]]).concat([['上', 'up'], ['下', 'down'], ['北边', 'north'], ['南边', 'south'], ['东边', 'east'], ['西边', 'west']]));
export function direction(value) {
    if (typeof value !== 'string') return value;
    return DIRECTION_NAMES.get(value.trim().toLowerCase().replace(/[\s_]+/g, '-')) ?? DIRECTION_NAMES.get(value.trim().toLowerCase().replace(/[\s_-]+/g, '')) ?? value;
}
// A type given by its display name resolves to that type's id on this map.
function typeId(value, types) {
    if (typeof value !== 'string' || types?.some(type => type.id === value)) return value;
    return types?.find(type => type.name === value.trim())?.id ?? value;
}
const fields = {
    'create-node': ['mapId', 'name', 'description', 'type'], 'update-node': ['mapId', 'name', 'description', 'type'],
    'create-edge': ['mapId', 'from', 'to', 'name', 'type', 'direction', 'distance', 'bidirectional'],
    'update-edge': ['mapId', 'name', 'type', 'direction', 'distance', 'bidirectional'], 'move-to': ['mapId'],
};
// The map's own update compiler keeps its tool-call operation names.
const compilerOps = { 'create-node': 'add_node', 'update-node': 'update_node', 'create-edge': 'add_edge', 'update-edge': 'update_edge', 'move-to': 'move' };
function document(ctx) {
    const raw = legacyModule(ctx,'map',KEY);
    if (raw === undefined) return null;
    if (!object(raw) || !Number.isFinite(raw.updatedAt) || !object(raw.document)) throw Error('地图存储格式无效，原始资料未改写。');
    return clone(validateDocument(raw.document));
}
function positionPatch(ctx, doc) {
    if (isIndependent(ctx) || ctx.aminIndependentDraft) return [];
    const raw = ctx?.chatMetadata?.[HISTORY];
    if (raw !== undefined && (!object(raw) || !object(raw.records) || raw.sequence !== undefined && (!Array.isArray(raw.sequence) || raw.sequence.some(value => typeof value !== 'string')))) throw Error('地图位置历史格式无效，未写入。');
    const sequence = (ctx?.chat ?? []).map(message => {
        const id = message.extra?.dynamic_map_message_id;
        if (id !== undefined && (typeof id !== 'string' || !id)) throw Error('地图楼层标识无效。');
        return id ? id + ':' + String(message.swipe_id ?? 0) : null;
    });
    if (sequence.some(value => value === null) || !sequence.length) return [];
    const next = clone(raw ?? { records: {} }); next.sequence = sequence;
    next.records[sequence.at(-1)] = { mapId: doc.activeMap, nodeId: doc.maps[doc.activeMap].currentLocation };
    return [{ path: [HISTORY], value: next }];
}

const spec = {
    notes: 'target=地点/道路ID，限已有地图中可见者。不删除、不建地图，不改地图类型、层级、坐标、锁定方向或通行规则；type 用该地图已有类型。',
    actions: [
        { name: 'create-node', creates: 'node', aliases: ['add_node'], args: 'mapId,name,description?,type?' },
        { name: 'update-node', aliases: ['update_node'], args: 'mapId,name?,description?,type?' },
        { name: 'create-edge', creates: 'edge', aliases: ['add_edge'], args: 'mapId,from,to,name?,type?,direction?|null,distance?:num≥0|null,bidirectional?:bool' },
        { name: 'update-edge', aliases: ['update_edge'], args: 'mapId,name?,type?,direction?,distance?,bidirectional?' },
        { name: 'move-to', aliases: ['move'], args: 'mapId', note: 'target=已到达地点ID' },
    ],
};

export const adapter = {
    id: 'map', label: '地图',
    paths: [[KEY], [HISTORY]],
    spec, contract: renderContract(spec), dataFields: action => fields[action],
    read(ctx) {
        const source = document(ctx);
        if (!source) return { version: 1, activeMap: null, maps: {} };
        const doc = prepareDocument(source);
        return { version: 1, activeMap: doc.activeMap, maps: Object.fromEntries(Object.values(doc.maps).map(map => [map.id, {
            id: map.id, name: map.name, type: map.type, parentMap: map.parentMap, parentNode: map.metadata.parentNode ?? null,
            currentLocation: visible(map.nodes[map.currentLocation]) ? map.currentLocation : null,
            nodeTypes: map.metadata.nodeTypes, roadTypes: map.metadata.roadTypes, rules: map.metadata.rules,
            nodes: Object.fromEntries(Object.values(map.nodes).filter(visible).map(({ id, name, type, description }) => [id, { id, name, type, description }])),
            edges: map.edges.filter(edge => edge.discovered && visible(map.nodes[edge.from]) && visible(map.nodes[edge.to])).map(({ id, from, to, name, type, direction, distance, bidirectional, metadata }) => ({ id, from, to, name, type, direction, distance, bidirectional, directionLocked: metadata.directionLocked === true })),
        }])) };
    },
    apply(ctx, input, { operationId, now } = {}) {
        const change = canonicalChange(spec, input);
        if (change?.module !== 'map' || !Object.hasOwn(fields, change.action)) throw Error('不支持的地图联动操作。');
        const extra = object(change.data) ? Object.keys(change.data).filter(key => !fields[change.action].includes(key)) : [];
        if (!object(change.data) || extra.length) throw Error(`地图更新包含未知字段${extra.length ? '：' + extra.join('、') : ''}。`);
        if (typeof change.target !== 'string' || !change.target.trim() || ['__proto__', 'constructor', 'prototype'].includes(change.target)) throw Error('地图目标 ID 无效。');
        if (change.action.startsWith('create-') && !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(change.target)) throw Error('新地点或道路需要安全、唯一的稳定 ID。');
        const before = document(ctx);
        if (!before) throw Error('地图尚未建立，请先在地图应用保存初始地图。');
        const mapId = change.data.mapId;
        if (typeof mapId !== 'string' || !Object.hasOwn(before.maps, mapId)) throw Error('目标地图不存在。');
        if (change.action.startsWith('update-') && Object.keys(change.data).length < 2) throw Error('地图更新没有提供待修改字段。');
        const edge = before.maps[mapId].edges.find(item => item.id === change.target);
        if (change.action === 'update-edge' && edge?.metadata.directionLocked && Object.hasOwn(change.data, 'direction') && direction(change.data.direction) !== edge.direction) throw Error('道路方向已锁定，模型不能修改。');
        const operation = { op: compilerOps[change.action], id: change.target, ...clone(change.data) }, metadata = before.maps[mapId].metadata;
        if (Object.hasOwn(operation, 'direction')) operation.direction = direction(operation.direction);
        if (Object.hasOwn(operation, 'type')) operation.type = typeId(operation.type, change.action.endsWith('node') ? metadata?.nodeTypes : metadata?.roadTypes);
        const next = compileMapUpdate(before, { token: operationId, reason: change.reason, operations: [operation] });
        const timestamp = typeof now === 'number' ? now : Date.parse(now);
        if (!Number.isFinite(timestamp)) throw Error('联动更新时间无效。');
        return { patches: [{ path: [KEY], value: { ...clone(ctx.chatMetadata[KEY]), updatedAt: Math.max(timestamp, ctx.chatMetadata[KEY].updatedAt + 1), document: next } }, ...positionPatch(ctx, next)], summary: `地图 ${before.maps[mapId].name}：${change.action} ${change.target}` };
    },
};
