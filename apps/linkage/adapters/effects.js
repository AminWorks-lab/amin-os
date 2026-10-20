import { KEY, activeEffects, change as changeEffect, readStore, timedEffects } from '../../effects/model.js';
import { readCurrentScene } from '../../scene/model.js';
import { SETTLEMENT_PATHS, buildSettlement, metadataEffects, validatePeriodicReferences } from '../../effects/settlement.js';
import { mayRead } from '../policy.js';
import { renderContract, canonicalChange } from '../contract.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const dataKeys = {
    'create-effect': ['skillId', 'holder', 'target', 'targetMode', 'scope', 'command', 'condition', 'durationMinutes', 'stacking', 'periodic'],
    'update-effect': ['holder', 'command', 'condition', 'durationMinutes', 'stacking', 'periodic'],
    'pause-effect': ['paused'], 'end-effect': [], 'settle-effect': [],
};
const spec = {
    notes: 'target=效果ID。stacking={mode:independent|refresh|stack,key:英文状态键,maxStacks:1..100,stacks:1..maxStacks}。推进时间不自动扣值。',
    advancedNotes: 'periodic={intervalMinutes:int>0,scaleWithStacks:bool,operations:[{kind:"stat",characterId,statId,delta:num≠0}|{kind:"item",itemId,quantity:int>0}|{kind:"balance",balanceId,delta:num≠0}]}，周期结算用 settle-effect。',
    actions: [
        { name: 'create-effect', creates: 'effect', aliases: ['create'], args: 'skillId,holder,target?,targetMode:targeted|direct,scope,command?,condition,durationMinutes?:int>0|null,stacking?', advancedArgs: ',periodic?' },
        { name: 'update-effect', aliases: ['update'], args: 'holder?,command?,condition?,durationMinutes?,stacking?', advancedArgs: ',periodic?', note: '叠层/刷新前先 settle-effect' },
        { name: 'pause-effect', aliases: ['pause'], args: 'paused:bool' },
        { name: 'end-effect', aliases: ['end'] },
        { name: 'settle-effect', aliases: ['settle'], note: '只结算已到期周期，同批更新绑定状态与背包' },
    ],
};

export const adapter = {
    id: 'effects', label: '能力与持续效果', paths: SETTLEMENT_PATHS,
    spec, contract: renderContract(spec),
    read(ctx) {
        const store = readStore(ctx), clock = readCurrentScene(ctx).clock;
        return { enabled: store.enabled, clock, skills: store.skills.map(skill => ({ id: skill.id, name: skill.name, reminder: skill.reminder })),
            effects: timedEffects(store, ctx?.chat, clock) };
    },
    readForPrompt(ctx) {
        const store = readStore(ctx), includeClock = mayRead(ctx, 'scene'), clock = includeClock ? readCurrentScene(ctx).clock : null;
        return { enabled: store.enabled, ...(includeClock ? { clock } : {}),
            skills: store.skills.map(skill => ({ id: skill.id, name: skill.name, reminder: skill.reminder })),
            effects: includeClock ? timedEffects(store, ctx?.chat, clock) : activeEffects(store, ctx?.chat) };
    },
    apply(ctx, change, { operationId, now } = {}) {
        const input = canonicalChange(spec, change);
        if (input.module !== 'effects' || !dataKeys[input.action]) throw Error('持续效果不支持此联动操作。');
        if (typeof operationId !== 'string' || !/^[A-Za-z0-9:_-]{1,80}$/.test(operationId) || typeof now !== 'string' || !Number.isFinite(Date.parse(now))) throw Error('持续效果操作编号或记录时间无效。');
        const data = input.data;
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !dataKeys[input.action].includes(key))) throw Error('持续效果联动参数含不支持的字段。');
        if (!safeId(input.target)) throw Error('持续效果编号无效。');
        if (typeof input.reason !== 'string' || !input.reason.trim()) throw Error('持续效果变更需要剧情依据。');
        // The effects model keeps its own operation names (create/update/pause/end).
        const op = input.action.replace(/-effect$/, '');
        if (op === 'settle') return buildSettlement(ctx, { effectIds: [input.target], operationId, now });
        const store = readStore(ctx), current = activeEffects(store, ctx?.chat).find(effect => effect.id === input.target);
        if (op === 'create' && current) throw Error('效果编号已存在。');
        if (op !== 'create' && !current) throw Error('效果不在当前剧情分支。');
        if (data.periodic) validatePeriodicReferences(ctx, data.periodic);
        const values = op === 'update' ? { holder: current.holder, command: current.command, condition: current.condition, ...data, id: input.target } : { ...data, id: input.target, reason: input.reason };
        const next = changeEffect(store, ctx?.chat, op, values, { clock: readCurrentScene(ctx).clock, createId: () => input.target, at: now });
        const event = next.events.at(-1); event.operationId = operationId; event.reason = input.reason;
        return { patches: [{ path: [KEY], value: metadataEffects(next, ctx) }], summary: `${{ create: '建立', update: '调整', pause: data.paused ? '暂停' : '恢复', end: '解除' }[op]}持续效果：${current?.skill.name ?? store.skills.find(skill => skill.id === data.skillId)?.name}` };
    },
};
