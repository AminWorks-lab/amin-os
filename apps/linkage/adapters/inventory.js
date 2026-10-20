import { KEY, readStore, readInventory, change as applyInventory } from '../../inventory/model.js';
import { KEY as CHARACTERS_KEY, readCharacters, validId } from '../../characters/model.js';
import { renderContract, canonicalChange } from '../contract.js';

const fields = {
    'create-item': ['name', 'ownerId', 'quantity', 'equipped', 'notes', 'wear', 'condition'],
    'update-item': ['name', 'quantity', 'equipped', 'notes', 'wear', 'condition'],
    'delete-item': [], 'consume-item': ['quantity'], 'transfer-item': ['quantity', 'toOwnerId', 'newId'],
    'equip-item': ['equipped'], 'set-condition': ['condition'],
    'create-balance': ['name', 'ownerId', 'amount', 'unit', 'notes'],
    'update-balance': ['name', 'amount', 'unit', 'notes'], 'delete-balance': [],
    'adjust-balance': ['delta'], 'transfer-balance': ['amount', 'toOwnerId', 'newId'],
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const spec = {
    notes: 'target=物品或余额ID。wear={slot:""|head|face|neck|torso|hands|waist|legs|feet|back|accessory,layer:base|middle|outer,description?}；condition={wetness?,dirt?,damage?:0..100 int,notes?}；金额≤10亿、≤6位小数。有部位的衣物逐件登记(quantity≤1)；同人同部位同层仅一件装备，换装先卸后穿。',
    actions: [
        { name: 'create-item', creates: 'item', args: 'name,ownerId,quantity:int≥0,equipped?:bool,notes?,wear?,condition?' },
        { name: 'update-item', aliases: ['save-item'], args: 'name?,quantity?,equipped?,notes?,wear?,condition?' },
        { name: 'consume-item', args: 'quantity:int>0' },
        { name: 'transfer-item', args: 'quantity:int>0,toOwnerId,newId?', note: '普通物品需 newId；衣物保留原ID不给 newId' },
        { name: 'equip-item', args: 'equipped:bool' },
        { name: 'set-condition', args: 'condition' },
        { name: 'delete-item', note: '仅数量为0', advanced: true },
        { name: 'create-balance', creates: 'balance', args: 'name,ownerId,amount:num≥0,unit?,notes?' },
        { name: 'update-balance', aliases: ['save-balance'], args: 'name?,amount?,unit?,notes?', advanced: true },
        { name: 'adjust-balance', args: 'delta:num≠0' },
        { name: 'transfer-balance', args: 'amount:num>0,toOwnerId,newId?', note: '对方无该资源账户时需 newId' },
        { name: 'delete-balance', note: '仅余额为0', advanced: true },
    ],
};

export const adapter = {
    id: 'inventory', label: '背包、穿戴与账本', paths: [[KEY], [CHARACTERS_KEY]],
    spec, contract: renderContract(spec),
    read: ctx => readInventory(ctx),
    apply(ctx, input, { operationId, now }) {
        const change = canonicalChange(spec, input), allowed = fields[change.action], data = change.data;
        if (!allowed || !object(data) || Object.keys(data).some(key => !allowed.includes(key))) throw Error('背包联动操作或参数无效。');
        if (typeof change.reason !== 'string' || !change.reason.trim()) throw Error('背包更新需要剧情原因。');
        const state = readInventory(ctx), creating = change.action.startsWith('create-');
        const isItem = change.action.includes('item') || change.action === 'set-condition';
        const records = isItem ? state.items : state.balances, existing = records.find(record => record.id === change.target);
        if (creating && (!validId(change.target) || state.items.some(record => record.id === change.target) || state.balances.some(record => record.id === change.target))) throw Error('新增物品或资源编号无效或已存在。');
        if (!creating && !existing) throw Error('物品或资源已不存在于当前剧情分支。');
        if (data.newId !== undefined && (!validId(data.newId) || state.items.some(record => record.id === data.newId) || state.balances.some(record => record.id === data.newId))) throw Error('转交目标记录编号无效或已存在。');
        if (change.action === 'transfer-item' && existing.wear?.slot && data.newId !== undefined) throw Error('逐件衣物转交保留原编号，无需提供 newId。');
        if (change.action === 'set-condition' && !object(data.condition)) throw Error('请提供物品状态字段。');
        // The inventory model saves (creates or edits) through one save-* operation.
        const op = change.action.replace(/^(create|update)-/, 'save-');
        const values = { ...(change.action.startsWith('update-') ? existing : {}), ...data, ...(creating ? { newId: change.target } : { id: change.target }), reason: change.reason };
        if (creating) { values.equipped ??= false; values.notes ??= ''; if (!isItem) values.unit ??= ''; }
        const result = applyInventory(readStore(ctx), ctx.chat, op, values, {
            ownerIds: readCharacters(ctx).characters.map(person => person.id), id: operationId, at: now,
            createId: () => { throw Error('新增转交记录需要显式 newId。'); },
        });
        return { patches: [{ path: [KEY], value: result.store }], summary: result.summary };
    },
};
