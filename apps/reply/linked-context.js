import { ROOTS } from '../story-state/legacy-roots.js';
import { timingStatus } from '../effects/timing.js';
import { sameMessageRevision, messageRevision } from '../shared/message-revision.js';
import { isIndependent, readModule } from '../story-state/access.js';

export const LINKED_SOURCES = Object.freeze([
    { id: 'characters', label: '人物卡与外观' },
    { id: 'relationships', label: '人物关系' },
    { id: 'inventory', label: '背包与资源' },
    { id: 'scene', label: '当前场景与日程' },
    { id: 'journal', label: '主体记忆' },
    { id: 'effects', label: '持续效果' },
    { id: 'status', label: '世界状态' },
]);
export const DEFAULT_LINKED_SOURCES = Object.freeze(['characters', 'relationships', 'inventory', 'scene', 'journal']);

const MAX_ROOT_CHARS = 2_000_000;
const MAX_RECORDS = 32;
const MAX_SELECTED_CHARS = 7000;
const MAX_RECORD_CHARS = 900;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const str = (value, limit = 300) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const safeList = value => Array.isArray(value) ? value : [];
const same = (a, b) => String(a ?? '').trim().toLocaleLowerCase() === String(b ?? '').trim().toLocaleLowerCase();
const labelOf = (module, id) => `${module}:${String(id)}`;

function digest(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    return (hash >>> 0).toString(36);
}

function readRoot(ctx, module, warnings) {
    const root = module === 'status' ? '状态栏' : ROOTS[module];
    const snapshot = isIndependent(ctx) ? readModule(ctx, module) : undefined;
    const raw = isIndependent(ctx) ? snapshot == null ? undefined : JSON.stringify(snapshot) : ctx?.chatMetadata?.variables?.[root];
    if (raw == null || raw === '') return null;
    if (typeof raw !== 'string' || raw.length > MAX_ROOT_CHARS) {
        warnings.push(`${root} 格式或长度不适合回复选项读取，已跳过。`);
        return null;
    }
    try {
        const value = JSON.parse(raw);
        if (!plain(value) || (module === 'status' ? !plain(value.项目) : value.version !== 1)) throw Error('格式无效');
        return value;
    } catch {
        warnings.push(`${root} 不是兼容的当前变量快照，已跳过。`);
        return null;
    }
}

function currentSubject(ctx, settings, characters) {
    const requested = str(settings?.subjectName || (settings?.perspective === 'third' ? settings?.thirdPersonName : '') || ctx?.name1, 100);
    const matches = safeList(characters?.characters).filter(value => value?.name && same(value.name, requested));
    return { name: requested, id: matches.length === 1 ? matches[0].id : null,
        ambiguous: matches.length > 1, player: same(requested, ctx?.name1) };
}

function currentScene(sceneState) {
    const scenes = sceneState?.scenes;
    return plain(scenes) && typeof sceneState?.activeSceneId === 'string' ? scenes[sceneState.activeSceneId] ?? null : null;
}

function relationshipEvidenceMatches(evidence, chat) {
    if (evidence == null) return true;
    if (!Array.isArray(evidence.sources) || !Array.isArray(chat)) return false;
    return evidence.sources.every(source => {
        const message = chat[source?.index];
        return message && sameMessageRevision(source.revision, messageRevision(message));
    });
}

function buildCandidates(ctx, snapshots, subject, warnings) {
    const output = [];
    const characters = safeList(snapshots.characters?.characters);
    const names = new Map(characters.filter(item => item?.id && item?.name).map(item => [item.id, item.name]));
    const scene = currentScene(snapshots.scene);
    const participantIds = new Set(safeList(scene?.participantIds));
    const recent = safeList(ctx?.chat).slice(-5).map(message => str(message?.mes, 1800)).join('\n');
    const relevant = character => character?.id === subject.id || participantIds.has(character?.id)
        || (character?.name && recent.includes(character.name));
    const add = (module, id, title, parts, score = 0) => {
        const text = parts.filter(Boolean).join('；');
        if (!text) return;
        output.push({ id: labelOf(module, id), module, label: str(title, 150), text: text.slice(0, MAX_RECORD_CHARS), score });
    };

    for (const person of characters) {
        if (!person?.id || !person?.name || !relevant(person)) continue;
        const subjectCard = person.id === subject.id;
        add('characters', person.id, `人物 · ${person.name}`, [
            `姓名：${str(person.name, 120)}`,
            person.kind === 'pc' ? '身份：PC' : person.kind === 'npc' ? '身份：NPC' : '',
            person.appearance?.description ? `外观：${str(person.appearance.description, 380)}` : '',
            person.appearance?.hairstyle ? `发型：${str(person.appearance.hairstyle, 120)}` : '',
            person.appearance?.features ? `特征：${str(person.appearance.features, 250)}` : '',
            subjectCard && person.notes ? `角色卡备注（背景，不代表已知）：${str(person.notes, 320)}` : '',
        ], subjectCard ? 100 : participantIds.has(person.id) ? 75 : 45);
    }

    for (const relation of safeList(snapshots.relationships?.relationships)) {
        if (!relation?.id || !relation.fromId || !relation.toId) continue;
        if (!relationshipEvidenceMatches(relation.evidence, ctx?.chat)) continue;
        const involved = subject.id && (relation.fromId === subject.id || relation.toId === subject.id);
        const bothPresent = participantIds.has(relation.fromId) && participantIds.has(relation.toId);
        if (!involved && !bothPresent) continue;
        const from = names.get(relation.fromId) ?? relation.fromId, to = names.get(relation.toId) ?? relation.toId;
        add('relationships', relation.id, `关系 · ${from} → ${to}`, [
            `${str(from, 80)} → ${str(to, 80)}：${str(relation.type, 60)}`,
            relation.label ? `名称：${str(relation.label, 100)}` : '',
            Number.isFinite(relation.strength) ? `记录强度：${relation.strength}（不推断量表）` : '',
            relation.notes ? `关系备注（不代表角色知情）：${str(relation.notes, 380)}` : '',
        ], involved ? 88 : 60);
    }

    if (subject.id) {
        for (const item of safeList(snapshots.inventory?.items)) {
            if (item?.ownerId !== subject.id || !item.id || !item.name || !(item.quantity > 0)) continue;
            add('inventory', item.id, `物品 · ${item.name}`, [
                `${str(item.name, 120)} × ${item.quantity}`,
                item.equipped ? '已装备' : '',
                item.condition?.notes ? `状态：${str(item.condition.notes, 150)}` : '',
                item.notes ? `备注：${str(item.notes, 300)}` : '',
            ], item.equipped ? 80 : 50);
        }
        for (const balance of safeList(snapshots.inventory?.balances)) {
            if (balance?.ownerId !== subject.id || !balance.id || !balance.name) continue;
            add('inventory', `balance:${balance.id}`, `资源 · ${balance.name}`, [
                `${str(balance.name, 120)}：${Number.isFinite(balance.amount) ? balance.amount : '?'} ${str(balance.unit, 40)}`,
            ], 42);
        }
    }

    if (scene) {
        add('scene', scene.id ?? snapshots.scene.activeSceneId, `当前场景 · ${scene.name ?? '未命名'}`, [
            `地点：${str(scene.name, 120)}`,
            scene.participants ? `在场描述：${str(scene.participants, 220)}` : '',
            participantIds.size ? `已确认在场：${[...participantIds].slice(0, 16).map(id => names.get(id) ?? id).join('、')}` : '',
            scene.weather ? `环境：${str(scene.weather, 200)}` : '',
            scene.objects ? `场景物件：${str(scene.objects, 230)}` : '',
            scene.notes ? `场景备注：${str(scene.notes, 220)}` : '',
        ], 96);
    }
    const clock = snapshots.scene?.clock;
    if (plain(clock) && Number.isInteger(clock.year) && Number.isInteger(clock.month) && Number.isInteger(clock.day)) {
        add('scene', 'clock', '剧情时间', [`剧情时间：${clock.year}-${clock.month}-${clock.day} ${String(clock.hour ?? 0).padStart(2, '0')}:${String(clock.minute ?? 0).padStart(2, '0')}`], 92);
    }
    if (subject.id) for (const schedule of safeList(snapshots.scene?.schedules)) {
        if (schedule?.characterId !== subject.id || schedule.enabled === false || !schedule.id) continue;
        add('scene', `schedule:${schedule.id}`, `日程计划 · ${schedule.title ?? ''}`, [
            `计划：${str(schedule.title, 120)}（不代表已到场）`,
            Number.isInteger(schedule.startMinute) ? `时间：${Math.floor(schedule.startMinute / 60)}:${String(schedule.startMinute % 60).padStart(2, '0')}` : '',
            schedule.notes ? `备注：${str(schedule.notes, 220)}` : '',
        ], 30);
    }

    const journal = safeList(snapshots.journal?.entries);
    if (!subject.id && journal.some(record => record?.kind === 'knowledge' && record.enabled)) {
        warnings.push('未找到回复主体对应的人物卡，人物记忆未加入参考资料。');
    }
    const facts = new Map(journal.filter(record => record?.kind === 'fact' && record.enabled === true).map(record => [record.id, record]));
    for (const memory of journal) {
        if (memory?.kind !== 'knowledge' || memory.enabled !== true || memory.confirmed !== true || memory.characterId !== subject.id || memory.state === 'forgotten') continue;
        if (!sourceMatches(memory.sources, ctx?.chat)) continue;
        const fact = facts.get(memory.factId);
        if (fact && (fact.confirmed !== true || !sourceMatches(fact.sources, ctx?.chat))) continue;
        add('journal', memory.id, `记忆 · ${memory.title ?? '未命名'}`, [
            `人物认知：${str(memory.title, 120)}`,
            memory.state === 'rumor' ? '状态：传闻，不能当作确定事实' : '状态：知情',
            memory.belief ? `人物理解：${str(memory.belief, 480)}` : fact?.body ? `所知内容：${str(fact.body, 480)}` : '',
        ], 72);
    }
    if (journal.some(record => ['fact', 'hook', 'chronicle', 'prior'].includes(record?.kind) && record.enabled)) {
        warnings.push('剧情档案中没有角色知情标记的全局条目未自动加入；可在对话或人物记忆中提供角色已知内容。');
    }

    for (const effect of safeList(snapshots.effects?.effects)) {
        if (!effect?.id || effect.paused === true || !effect.skill?.name) continue;
        try {
            if (!['active', 'untimed'].includes(timingStatus(effect, snapshots.scene?.clock).state)) continue;
        } catch { continue; }
        const holder = str(effect.holder, 100), target = str(effect.target, 100);
        if (!subject.id || ![subject.id, subject.name].some(value => value && (same(holder, value) || same(target, value)))) continue;
        add('effects', effect.id, `持续效果 · ${effect.skill.name}`, [
            `效果：${str(effect.skill.name, 120)}`,
            holder ? `持有者：${holder}` : '', target ? `目标：${target}` : '',
            effect.scope ? `作用层面：${str(effect.scope, 160)}` : '',
            effect.condition ? `条件：${str(effect.condition, 160)}` : '',
            effect.skill.reminder ? `规则：${str(effect.skill.reminder, 300)}` : '',
        ], 65);
    }

    const status = snapshots.status?.项目;
    if (!subject.ambiguous && plain(status)) for (const [name, fields] of Object.entries(status)) {
        if (!plain(fields) || ![subject.name, ...(subject.player ? ['玩家'] : [])].some(value => value && same(name, value))) continue;
        const fieldList = Object.entries(fields).slice(0, 24).map(([key, value]) => `${str(key, 45)}=${JSON.stringify(value).slice(0, 150)}`);
        add('status', name, `世界状态 · ${name}`, [`当前状态：${fieldList.join('；')}`], 75);
    }
    return output;
}

function sourceMatches(source, chat) {
    if (!plain(source) || !Array.isArray(source.messages) || !Array.isArray(chat)) return false;
    if (!Number.isInteger(source.start) || !Number.isInteger(source.end) || source.start < 0 || source.end >= chat.length || source.messages.length !== source.end - source.start + 1) return false;
    return source.messages.every((saved, offset) => {
        const message = chat[source.start + offset];
        return message && saved?.index === source.start + offset && saved.text === message.mes
            && sameMessageRevision(saved.revision, messageRevision(message));
    });
}

/** Read-only candidate context from the current Amin state, with legacy snapshot support. */
export function collectLinkedContext(ctx, settings = {}) {
    const warnings = [];
    const empty = () => ({ records: [], selected: [], warnings, stamp: '' });
    if (Number.isInteger(ctx?.replyFloorIndex) && Number.isInteger(ctx?.replyLiveChatLength)
        && ctx.replyFloorIndex < ctx.replyLiveChatLength - 1) {
        warnings.push('旧楼层不会读取当前末尾的变量，避免把未来剧情资料带入旧楼层。');
        return empty();
    }
    if (ctx?.replyState2Ready !== true) {
        warnings.push(isIndependent(ctx) ? '当前 Amin 剧情资料尚未就绪，关联资料暂不读取。' : '当前分支的变量尚未恢复完成，关联资料暂不读取。');
        return empty();
    }
    if (!isIndependent(ctx)) {
        warnings.push('当前聊天尚未导入或开始 Amin 剧情资料，关联资料暂不读取。');
        return empty();
    }
    const known = new Set(LINKED_SOURCES.map(source => source.id));
    const requested = Array.isArray(settings?.linkedSources) ? settings.linkedSources : DEFAULT_LINKED_SOURCES;
    const sources = [...new Set(requested.filter(id => known.has(id)))];
    const excluded = new Set(safeList(settings?.excludedLinkedRecords).filter(id => typeof id === 'string'));
    if (!sources.length) return { records: [], selected: [], warnings, stamp: JSON.stringify([ctx.getCurrentChatId?.() ?? ctx.chatId ?? '', []]) };
    const snapshots = {}, signatures = [];
    // Character names are needed to resolve the configured subject even when that source is hidden.
    const loaded = new Set(sources.includes('characters') ? sources : ['characters', ...sources]);
    for (const module of loaded) {
        const root = module === 'status' ? '状态栏' : ROOTS[module];
        if (!root) continue;
        const current = isIndependent(ctx) ? readModule(ctx, module) : undefined;
        const raw = isIndependent(ctx) ? current == null ? undefined : JSON.stringify(current) : ctx.chatMetadata.variables?.[root];
        signatures.push([module, typeof raw === 'string' ? raw.length <= MAX_ROOT_CHARS ? `${raw.length}:${digest(raw)}` : `oversize:${raw.length}` : 'absent']);
        snapshots[module] = readRoot(ctx, module, warnings);
    }
    const subject = currentSubject(ctx, settings, snapshots.characters);
    if (subject.ambiguous) warnings.push('回复主体名称对应多张人物卡；人物记忆与持有物已跳过，请先消除重名。');
    const candidates = buildCandidates(ctx, snapshots, subject, warnings)
        .filter(record => sources.includes(record.module))
        .sort((a, b) => b.score - a.score || a.module.localeCompare(b.module) || a.label.localeCompare(b.label));
    const records = [], selected = [];
    let budget = MAX_SELECTED_CHARS;
    for (const candidate of candidates.slice(0, MAX_RECORDS)) {
        const { score, ...record } = candidate;
        const eligible = !excluded.has(record.id);
        const fits = record.text.length <= budget;
        record.selected = eligible && fits;
        if (eligible && !fits) record.reason = '本次参考资料已达到长度上限';
        records.push(record);
        if (record.selected) { selected.push(record); budget -= record.text.length; }
    }
    if (candidates.length > MAX_RECORDS) warnings.push(`关联资料较多，仅预览最相关的 ${MAX_RECORDS} 项。`);
    if (records.some(record => record.reason)) warnings.push('部分资料因长度上限未加入本次生成。');
    const stamp = JSON.stringify([
        ctx.getCurrentChatId?.() ?? ctx.chatId ?? '', ctx.replyFloorIndex ?? ctx.chat?.length ?? 0,
        subject.name, sources, [...excluded].sort(), signatures,
    ]);
    return { records, selected, warnings, stamp };
}
