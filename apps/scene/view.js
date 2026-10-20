import { mountGeneration } from '../generation/view.js';
import { getSharedSceneService } from './service.js';
import { formatGameTime, formatPeriods, parsePeriods, createSceneId, validateCalendar, validateState, clockWeekday, characterReferences, absencePreview } from './model.js';
import { contextExpiryPreview } from '../effects/model.js';
import { periodicPreview } from '../effects/settlement.js';
import { mountTravel, appendExpiryPreview } from './travel-view.js';
import {contextLine} from '../shared/context-line.js';
const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
const LABELS = { 'set-time': '设置游戏时间', 'advance-time': '推进游戏时间', activity: '按活动规则推进', 'time-rules': '保存活动耗时', 'save-schedule': '保存人物日程', 'delete-schedule': '删除人物日程', 'confirm-presence': '确认场景人物', 'save-absence-rule': '保存离场规则', 'delete-absence-rule': '删除离场规则', 'settle-absence': '确认离场变化', travel: '旅行', periods: '保存时段划分', 'save-scene': '保存场景资料', 'switch-scene': '进入场景', 'leave-scene': '离开当前场景', settings: '保存读取设置' };
const ACTIVITY_LABELS = { dialogue: '一次对话', shortRest: '短休', longRest: '长休', travel: '无地图路线的旅行' };
const minuteText = value => String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
const parseTime = (value, end = false) => { const parts = /^(\d{1,2}):(\d{2})$/.exec(value); if (!parts || +parts[1] > 23 || +parts[2] > 59) throw Error('时间需填写 HH:MM。'); const minute = +parts[1] * 60 + +parts[2]; return end && !minute ? 1440 : minute; };
const mountedViews = new WeakMap();
export function mount(target, { service = getSharedSceneService(), travelService, expiryPreview = contextExpiryPreview, generationService, ai } = {}) {
    const existing = mountedViews.get(target); if (existing) { existing.open(); return existing; }
    const api = service, instance = 'amin-scene-' + createSceneId();
    const peopleFor = () => api.characterReferences?.() ?? characterReferences(api.context());
    const absenceFor = () => api.absencePreview?.() ?? absencePreview(validateState(api.read()));
    const page = node('div', null, 'amin-page amin-app-page amin-scene'), intro = node('div', null, 'amin-context'), tabs = node('nav', null, 'amin-tabs');
    const notice = node('div', null, 'amin-notice'), review = node('section', null, 'amin-stack'), body = node('section', null, 'amin-stack');
    tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '场景与时间页面');
    notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    body.id = instance + '-body'; body.setAttribute('role', 'tabpanel'); page.append(intro, tabs, notice, review, body); target.append(page);
    const generationView = mountGeneration(page, { modules: ['scene'], getContext: () => api.context(), service: generationService, ai });
    const travelHost = node('div', null, 'amin-stack'), travelView = mountTravel(travelHost, { service: travelService, periods: () => api.read().periods });
    let tab = '时钟', token = null, selected = '', clockDraft = null, sceneDraft = null, periodsDraft = '', settingDraft = null, disposed = false;
    let timeReason = '', sceneReason = '', advanceReason = '', amount = 10, unit = 'minutes', message = '', error = false;
    let scheduleId = '', scheduleDraft = null, characterFilter = '', absenceId = '', absenceDraft = null, timeRulesDraft = null, floorDraft = null;
    let customCalendar = false, calendarLengths = '', calendarNames = '', calendarWeek = '', calendarEpoch = 0;
    const say = (value, failed = false) => { message = value; error = failed; notice.textContent = value; notice.dataset.state = failed ? 'error' : api.busy() ? 'busy' : ''; };
    const action = fn => async () => { try { error = false; await fn(); } catch (e) { say(e.message, true); } };
    const button = (label, fn, primary = false) => { const b = node('button', label, primary ? 'amin-primary' : ''); b.type = 'button'; b.disabled = api.busy(); b.addEventListener('click', action(fn)); return b; };
    function field(label, value, onChange, { type = 'text', multi = false, full = false, min, max, help } = {}) {
        const wrap = node('label', null, 'amin-field' + (full ? ' amin-span-full' : ''));
        const control = node(multi ? 'textarea' : 'input'); control.value = value ?? ''; if (!multi) control.type = type;
        if (min != null) control.min = min; if (max != null) control.max = max;
        control.addEventListener('input', () => onChange(type === 'number' ? (control.value === '' ? NaN : Number(control.value)) : control.value));
        wrap.append(node('span', label), control); if (help) wrap.append(node('small', help)); return wrap;
    }
    function check(label, value, onChange) {
        const wrap = node('label', null, 'amin-check'), input = node('input'); input.type = 'checkbox'; input.checked = !!value;
        input.addEventListener('change', () => onChange(input.checked)); wrap.append(input, node('span', label)); return wrap;
    }
    const card = title => { const out = node('section', null, 'amin-card amin-stack'); if (title) out.append(node('h3', title)); return out; };
    function selectField(label, value, options, change, full = false) {
        const wrap = node('label', null, 'amin-field' + (full ? ' amin-span-full' : '')), select = node('select');
        for (const [key, title] of options) { const option = node('option', title); option.value = key; select.append(option); }
        select.value = value ?? ''; select.addEventListener('change', () => change(select.value)); wrap.append(node('span', label), select); return wrap;
    }
    function loadSchedule(state) { scheduleDraft = structuredClone(state.schedules.find(value => value.id === scheduleId) ?? { characterId: characterFilter, title: '', startMinute: 480, endMinute: 1080, mapId: '', nodeId: '', weekdays: [], enabled: true, notes: '' }); }
    function loadAbsence(state) { absenceDraft = structuredClone(state.absenceRules.find(value => value.id === absenceId) ?? { sceneId: state.activeSceneId ?? '', title: '', intervalMinutes: 60, field: 'notes', value: '', enabled: true }); }
    function loadScene(state) {
        const scene = state.scenes[selected];
        sceneDraft = scene ? structuredClone(scene) : { name: '', participants: '', participantIds: [], weather: '', objects: '', notes: '', mapId: '', nodeId: '' };
        sceneReason = scene ? '更新场景资料' : '建立场景资料';
    }
    function resetDrafts(state, moved) {
        if (moved) { selected = state.activeSceneId ?? ''; message = ''; error = false; advanceReason = ''; amount = 10; unit = 'minutes'; scheduleId = ''; absenceId = ''; characterFilter = ''; floorDraft = api.context()?.chat?.length ?? 0; }
        if (selected && !state.scenes[selected]) selected = '';
        clockDraft = structuredClone(state.clock ?? { year: 1, month: 1, day: 1, hour: 8, minute: 0, calendarLabel: '' });
        periodsDraft = formatPeriods(state.periods); settingDraft = { ...state.settings }; loadScene(state);
        if (!state.schedules.some(value => value.id === scheduleId)) scheduleId = '';
        if (!state.absenceRules.some(value => value.id === absenceId)) absenceId = '';
        loadSchedule(state); loadAbsence(state); timeRulesDraft = { ...state.timeRules };
        customCalendar = !!clockDraft.calendar;
        const calendar = clockDraft.calendar ?? { monthLengths: Array(12).fill(30), monthNames: Array.from({ length: 12 }, (_, i) => `${i + 1}月`), weekDays: ['日', '一', '二', '三', '四', '五', '六'], epochWeekday: 0 };
        calendarLengths = calendar.monthLengths.join(', '); calendarNames = calendar.monthNames.join(', '); calendarWeek = calendar.weekDays.join(', '); calendarEpoch = calendar.epochWeekday;
        timeReason = state.clock ? '校正游戏时间' : '设置故事起始时间';
    }
    function stage(op, data) { api.stage(op, data, token); }
    function renderReview(state) {
        review.replaceChildren(); const draft = api.preview();
        if (!draft) return;
        const panel = card('待确认 · ' + LABELS[draft.op]); panel.classList.add('amin-result');
        panel.append(node('p', '原因：' + draft.reason));
        if (['set-time', 'advance-time', 'activity'].includes(draft.op)) {
            panel.append(node('p', formatGameTime(draft.details.beforeTime, state.periods) + ' → ' + formatGameTime(draft.details.afterTime, draft.state.periods)));
            if (['advance-time', 'activity'].includes(draft.op)) {
                try { appendExpiryPreview(panel, expiryPreview(api.context(), draft.details.afterTime).newlyExpired); }
                catch (e) { panel.append(node('p', '无法检查限时效果：' + e.message, 'amin-notice')); }
                try { const due = periodicPreview(api.context(), draft.details.afterTime).pending; if (due.length) panel.append(node('p', `推进后有 ${due.length} 项持续效果等待周期结算；请在能力面板核对资源变化。`, 'amin-notice')); }
                catch (e) { panel.append(node('p', '无法检查周期效果：' + e.message, 'amin-notice')); }
            }
        }
        if (draft.op === 'periods') panel.append(node('pre', formatPeriods(draft.state.periods)));
        if (draft.op === 'time-rules') for (const [key, label] of Object.entries(ACTIVITY_LABELS)) panel.append(node('p', `${label}：${draft.state.timeRules[key]} 分钟`));
        if (draft.op === 'activity') panel.append(node('p', `${ACTIVITY_LABELS[draft.details.activity]} · ${draft.details.minutes} 分钟`));
        if (draft.details.entry) {
            const entry = draft.details.entry; panel.append(node('strong', entry.title));
            if (entry.characterId) panel.append(node('p', `${peopleFor().find(value => value.id === entry.characterId)?.name ?? entry.characterId} · ${minuteText(entry.startMinute)}–${minuteText(entry.endMinute)} · ${entry.mapId}/${entry.nodeId}${entry.enabled ? '' : ' · 已停用'}`));
            else panel.append(node('p', `${draft.state.scenes[entry.sceneId]?.name ?? entry.sceneId} · 每 ${entry.intervalMinutes} 分钟 · ${entry.value}`));
        }
        if (draft.op === 'settle-absence') for (const change of draft.details.changes) panel.append(node('p', `${change.sceneName} / ${change.title}：${change.before || '空'} → ${change.after || '空'}（已过去 ${change.cycles} 个周期，本次只应用一次）`));
        if (draft.op === 'settings') panel.append(node('p', `应用${draft.state.settings.enabled ? '启用' : '停用'}；正文和工具 AI ${draft.state.settings.includeInContext ? '读取已确认场景' : '不读取场景'}。`));
        if (draft.op === 'leave-scene') panel.append(node('p', '清除当前场景选择，游戏时间与已存场景保留。'));
        if (['save-scene', 'switch-scene', 'confirm-presence'].includes(draft.op)) {
            const candidate = draft.state.scenes[draft.details.sceneId];
            if (candidate) panel.append(sceneSummary(candidate, draft.state.periods));
            if (draft.op === 'switch-scene') panel.append(node('p', '进入后沿用上面已保存的资料；游戏时钟保持 ' + formatGameTime(draft.state.clock, draft.state.periods) + '。', 'amin-meta'));
        }
        const actions = node('div', null, 'amin-toolbar'); actions.append(button('确认应用一次', () => api.confirm(), true), button('取消', () => api.discard())); panel.append(actions); review.append(panel);
    }
    function sceneSummary(scene, periods) {
        const result = node('div', null, 'amin-stack'); result.append(node('strong', scene.name));
        for (const [key, label] of Object.entries({ participants: '在场人物', weather: '天气与环境', objects: '场景物件', notes: '已确认资料' })) if (scene[key]) result.append(node('p', label + '：' + scene[key]));
        if (scene.participantIds?.length) { const people = peopleFor(); result.append(node('p', '已确认人物卡：' + scene.participantIds.map(id => people.find(value => value.id === id)?.name ?? '缺失人物 ' + id).join('、'))); }
        if (scene.mapId) result.append(node('p', `地图 ${scene.mapId}${scene.nodeId ? ' / 地点 ' + scene.nodeId : ''}`, 'amin-meta'));
        result.append(node('p', '资料确认时刻：' + formatGameTime(scene.gameTime, periods), 'amin-meta')); return result;
    }
    function renderClock(state) {
        const current = card('当前游戏时间'); current.append(node('strong', formatGameTime(state.clock, state.periods)), node('p', '游戏时间由你确认推进。重新生成、续写或切换 AI 回复不会自动增加时间。', 'amin-meta')); body.append(current);
        const advance = card('推进与休息'), form = node('div', null, 'amin-form-grid');
        form.append(field('推进量', amount, value => { amount = value; }, { type: 'number', min: 1 }), field('原因', advanceReason, value => { advanceReason = value; }, { help: '例如调查房间、赶路或休息。' }));
        const selectWrap = node('label', null, 'amin-field'), select = node('select'); selectWrap.append(node('span', '单位'), select);
        for (const [value, label] of [['minutes', '分钟'], ['hours', '小时']]) { const option = node('option', label); option.value = value; select.append(option); }
        select.value = unit; select.addEventListener('change', () => { unit = select.value; }); form.prepend(selectWrap); advance.append(form);
        const actions = node('div', null, 'amin-toolbar');
        const previewAdvance = (minutes, reason) => stage('advance-time', { minutes, reason });
        for (const [label, minutes] of [['10 分钟', 10], ['1 小时', 60]]) {
            const b = button(label, () => previewAdvance(minutes, advanceReason.trim() || label)); b.disabled ||= !state.clock; actions.append(b);
        }
        for (const [activity, label] of Object.entries(ACTIVITY_LABELS)) {
            const minutes = state.timeRules[activity], b = button(`${label} · ${minutes} 分钟`, () => stage('activity', { activity, reason: advanceReason.trim() || label })); b.disabled ||= !state.clock || !minutes; actions.append(b);
        }
        const custom = button('预览自定义推进', () => previewAdvance(amount * (unit === 'hours' ? 60 : 1), advanceReason), true); custom.disabled ||= !state.clock; actions.append(custom); advance.append(actions, node('p', '休息按钮只推进游戏时钟；生命、资源与状态效果由对应应用管理。', 'amin-meta')); body.append(advance);
        const editor = card(state.clock ? '校正日期与时间' : '设置故事起始时间'), grid = node('div', null, 'amin-form-grid');
        grid.append(field('历法名称（可选）', clockDraft.calendarLabel, value => { clockDraft.calendarLabel = value; }, { full: true }));
        grid.append(selectField('日期规则', customCalendar ? 'custom' : 'gregorian', [['gregorian', '公历月长与闰年'], ['custom', '自定义固定月长']], value => { customCalendar = value === 'custom'; render(); }, true));
        if (customCalendar) {
            grid.append(field('每月天数', calendarLengths, value => { calendarLengths = value; }, { full: true, help: '用逗号分隔，例如 30, 30, 35。1–24 个月，每月 1–100 天；每年重复，不设闰日。' }),
                field('月份名称', calendarNames, value => { calendarNames = value; }, { full: true, help: '逗号分隔，数量与月份一致；留空使用第几月。' }),
                field('星期名称', calendarWeek, value => { calendarWeek = value; }, { full: true, help: '逗号分隔，支持每周 1–14 天。' }),
                field('元年首日星期序号', calendarEpoch + 1, value => { calendarEpoch = value - 1; }, { type: 'number', min: 1, max: 14, help: '从 1 开始，对应上面星期名称的顺序。' }));
        }
        for (const [key, label, min, max] of [['year', '年', 1, 9999], ['month', '月', 1, customCalendar ? 24 : 12], ['day', '日', 1, customCalendar ? 100 : 31], ['hour', '时', 0, 23], ['minute', '分', 0, 59]]) grid.append(field(label, clockDraft[key], value => { clockDraft[key] = value; }, { type: 'number', min, max }));
        grid.append(field('设置原因', timeReason, value => { timeReason = value; }, { full: true }));
        editor.append(grid, node('p', '历法规则随每个时间记录保存。中途换历法后，旧记录保持原日期；离场周期遇到不同历法时需重新确认基准。', 'amin-meta'), button('预览时间设置', () => {
            const clock = { ...clockDraft }; delete clock.calendar;
            if (customCalendar) { const split = value => value.split(/[,，]/).map(part => part.trim()); clock.calendar = validateCalendar({ monthLengths: split(calendarLengths).map(Number), monthNames: calendarNames.trim() ? split(calendarNames) : undefined, weekDays: split(calendarWeek), epochWeekday: calendarEpoch }); }
            stage('set-time', { clock, reason: timeReason });
        })); body.append(editor);
    }
    function renderScenes(state) {
        const current = card('当前场景'), active = state.scenes[state.activeSceneId];
        if (active) { current.append(sceneSummary(active, state.periods)); current.append(button('预览离开场景', () => stage('leave-scene', { reason: '离开当前场景' }))); }
        else current.append(node('p', '尚未选择当前场景。保存资料后，明确进入场景才会作为当前上下文。', 'amin-empty'));
        body.append(current);
        if (active && absenceFor().some(item => item.sceneId === active.id && item.due)) current.append(node('p', '返场前有离场变化尚待确认，当前资料保持已保存事实。', 'amin-notice'), button('查看离场变化', () => { tab = '离场'; render(); }));
        const editor = card('场景资料'), choose = node('label', null, 'amin-field'), picker = node('select'); choose.append(node('span', '选择已存场景或新建'), picker);
        const blank = node('option', '＋ 新建场景'); blank.value = ''; picker.append(blank);
        for (const scene of Object.values(state.scenes)) { const option = node('option', scene.name + (scene.id === state.activeSceneId ? ' · 当前' : '')); option.value = scene.id; picker.append(option); }
        picker.value = selected; picker.addEventListener('change', () => { selected = picker.value; loadScene(api.read()); render(); }); editor.append(choose);
        if (selected) editor.append(button('预览进入并沿用已存资料', () => stage('switch-scene', { sceneId: selected, reason: '进入场景：' + state.scenes[selected].name }), true));
        const form = node('div', null, 'amin-form-grid');
        form.append(field('场景名称', sceneDraft.name, value => { sceneDraft.name = value; }, { full: true }));
        for (const [key, label] of [['participants', '在场人物'], ['weather', '天气与环境'], ['objects', '场景物件'], ['notes', '其他已确认资料']]) form.append(field(label, sceneDraft[key], value => { sceneDraft[key] = value; }, { multi: true, help: key === 'objects' ? '记录摆设、门窗等场景事实；随身物品由背包管理。' : '留空表示未知。' }));
        const people = peopleFor(), presence = node('div', null, 'amin-stack amin-span-full'); presence.append(node('strong', '已确认在场人物卡'), node('p', '明确在场信息优先于作息预测；不勾选表示没有已确认的在场关联。', 'amin-meta'));
        for (const person of people) presence.append(check(person.name, sceneDraft.participantIds.includes(person.id), value => { sceneDraft.participantIds = value ? [...sceneDraft.participantIds, person.id] : sceneDraft.participantIds.filter(id => id !== person.id); }));
        for (const missing of sceneDraft.participantIds.filter(id => !people.some(value => value.id === id))) presence.append(check('缺失人物 ' + missing, true, value => { if (!value) sceneDraft.participantIds = sceneDraft.participantIds.filter(id => id !== missing); }));
        form.append(presence);
        form.append(field('地图 ID（可选）', sceneDraft.mapId, value => { sceneDraft.mapId = value; }), field('地点 ID（可选）', sceneDraft.nodeId, value => { sceneDraft.nodeId = value; }));
        const references = api.mapReferences(), location = references.find(ref => ref.current);
        const links = node('div', null, 'amin-toolbar amin-span-full');
        const useCurrent = button('引用地图当前位置', () => { if (!location) throw Error('当前地图没有已发现的当前位置。'); sceneDraft.mapId = location.mapId; sceneDraft.nodeId = location.nodeId; render(); }); useCurrent.disabled ||= !location; links.append(useCurrent, button('清除地图引用', () => { sceneDraft.mapId = ''; sceneDraft.nodeId = ''; render(); })); form.append(links);
        if (location) form.append(node('p', '地图当前位置：' + location.mapName + ' / ' + location.nodeName, 'amin-meta amin-span-full'));
        form.append(field('保存原因', sceneReason, value => { sceneReason = value; }, { full: true }));
        editor.append(form, node('p', '切换场景恢复该处保存的资料，并保留全局游戏时间。地图关联仅作引用。', 'amin-meta'));
        const actions = node('div', null, 'amin-toolbar'); actions.append(button('预览保存资料', () => stage('save-scene', { scene: sceneDraft, reason: sceneReason }), true), button('预览保存并进入', () => stage('save-scene', { scene: sceneDraft, reason: sceneReason, activate: true })));
        editor.append(actions); body.append(editor);
    }
    function renderHistory(state) {
        body.append(node('p', '这里只展示属于当前聊天消息与回复候选路径的已确认记录。回到旧分支时，后续记录不会成为当前事实。', 'amin-meta'));
        const floorPanel = card('查看楼层的游戏时间'), floor = Number.isInteger(floorDraft) ? floorDraft : api.context()?.chat?.length ?? 0;
        floorPanel.append(field('消息楼层（0 为聊天开始前）', floor, value => { floorDraft = value; }, { type: 'number', min: 0, max: api.context()?.chat?.length ?? 0 }), button('查看该楼层', () => { api.floorGameTime(floorDraft); render(); }));
        try { const point = api.floorGameTime(floor); floorPanel.append(node('p', formatGameTime(point.clock, state.periods)), node('p', point.sceneName ? '当时场景：' + point.sceneName : '当时没有已确认场景', 'amin-meta')); } catch (e) { floorPanel.append(node('p', e.message, 'amin-notice')); }
        floorPanel.append(node('p', '显示该消息之后已有的时间记录。查看只读取，不补记时间、不结算规则。', 'amin-meta')); body.append(floorPanel);
        const entries = api.history().slice().reverse();
        if (!entries.length) { body.append(node('p', '还没有已确认操作。', 'amin-empty')); return; }
        for (const event of entries.slice(0, 100)) {
            const entry = card(LABELS[event.op] ?? event.op); entry.append(node('p', event.reason), node('p', `${event.floor ? '第 ' + event.floor + ' 条消息之后' : '聊天开始前'} · ${event.at}`, 'amin-meta'));
            if (['set-time', 'advance-time', 'activity', 'travel'].includes(event.op)) entry.append(node('p', formatGameTime(event.details.beforeTime, state.periods) + ' → ' + formatGameTime(event.details.afterTime, state.periods)));
            if (event.details.sceneName) entry.append(node('p', event.details.sceneName)); body.append(entry);
        }
        if (entries.length > 100) body.append(node('p', `显示最近 100 条；当前分支共 ${entries.length} 条记录，早期记录仍用于恢复。`, 'amin-meta'));
    }
    function renderSettings() {
        const settings = card('上下文读取'); settings.append(check('启用场景与时间上下文', settingDraft.enabled, value => { settingDraft.enabled = value; }), check('允许正文与应用 AI 读取当前已确认资料', settingDraft.includeInContext, value => { settingDraft.includeInContext = value; }), node('p', '默认不注入。开启后只读取当前游戏时间与已进入场景的已存字段。草稿、其他场景和历史分支不会注入。', 'amin-meta'), button('预览保存读取设置', () => stage('settings', { ...settingDraft, reason: '调整场景上下文读取设置' })));
        const periods = card('每日时段'); periods.append(field('时段开始时间与名称', periodsDraft, value => { periodsDraft = value; }, { multi: true, help: '每行一项，格式 HH:MM 名称；必须包含 00:00。时段只影响显示，不自动产生天气或人物活动。' }), button('预览保存时段', () => stage('periods', { periods: parsePeriods(periodsDraft), reason: '调整每日时段划分' })));
        const rules = card('活动耗时规则'), form = node('div', null, 'amin-form-grid');
        for (const [key, label] of Object.entries(ACTIVITY_LABELS)) form.append(field(label + '（分钟）', timeRulesDraft[key], value => { timeRulesDraft[key] = value; }, { type: 'number', min: 0, max: 5256000 }));
        rules.append(form, node('p', '零分钟表示不推进。时钟页按规则生成待确认结果；有地图路线的旅行仍使用道路距离、速度或本次填写耗时。读取、重生成和续写不会自动重复计时。', 'amin-meta'), button('预览保存耗时规则', () => stage('time-rules', { rules: timeRulesDraft, reason: '调整活动耗时规则' })));
        body.append(settings, periods, rules);
    }
    function renderSchedules(state) {
        const people = peopleFor(), refs = api.mapReferences();
        body.append(node('p', '日程提供预计位置。已确认在场人物优先；打开页面和推进时间都不会把人物移动到日程地点。', 'amin-meta'),
            selectField('查看人物', characterFilter, [['', '全部人物'], ...people.map(value => [value.id, value.name])], value => { characterFilter = value; scheduleId = ''; loadSchedule(state); render(); }));
        const forecast = api.forecast().filter(value => !characterFilter || value.characterId === characterFilter);
        for (const item of forecast) {
            const entry = card(item.characterName + ' · ' + item.title);
            const weekdays = state.clock ? clockWeekday(state.clock).names : ['日', '一', '二', '三', '四', '五', '六'];
            entry.append(node('p', `${minuteText(item.startMinute)}–${minuteText(item.endMinute)} · ${item.weekdays.length ? item.weekdays.map(index => weekdays[index] ?? '已不存在的星期 ' + index).join('、') : '每日'} · ${item.locationName}`));
            entry.append(node('p', item.confirmed ? `已确认在场：${item.confirmed.sceneName}${item.conflict ? '。日程地点不同，以已确认剧情为准。' : '。'}` : item.missingCharacter || item.missingLocation ? '关联已缺失，保留原 ID，不能作为当前位置建议。' : !item.enabled ? '已停用' : item.overlap ? '当前有多条日程指向不同地点，需核对作息，暂不确定预计位置。' : item.due ? '当前预计在此处，尚未确认为剧情事实。' : state.clock ? '当前不在此日程时段。' : '请先设置游戏时间。', 'amin-meta'));
            const actions = node('div', null, 'amin-toolbar'); actions.append(button('编辑日程', () => { scheduleId = item.id; loadSchedule(state); render(); }), button('预览删除', () => stage('delete-schedule', { id: item.id, reason: '删除日程：' + item.title }))); entry.append(actions); body.append(entry);
        }
        if (!forecast.length) body.append(node('p', '还没有该人物的日程。', 'amin-empty'));
        const editor = card(scheduleId ? '编辑日程' : '新建日程'), form = node('div', null, 'amin-form-grid');
        const knownPeople = [['', '选择人物卡'], ...people.map(value => [value.id, value.name])];
        if (scheduleDraft.characterId && !people.some(value => value.id === scheduleDraft.characterId)) knownPeople.push([scheduleDraft.characterId, '缺失人物 ' + scheduleDraft.characterId]);
        form.append(selectField('人物卡', scheduleDraft.characterId, knownPeople, value => { scheduleDraft.characterId = value; }), field('日程名称', scheduleDraft.title, value => { scheduleDraft.title = value; }),
            field('开始时间', minuteText(scheduleDraft.startMinute), value => { try { scheduleDraft.startMinute = parseTime(value); } catch { scheduleDraft.startMinute = NaN; } }, { help: 'HH:MM，例如 08:00。' }),
            field('结束时间', minuteText(scheduleDraft.endMinute === 1440 ? 0 : scheduleDraft.endMinute), value => { try { scheduleDraft.endMinute = parseTime(value, true); } catch { scheduleDraft.endMinute = NaN; } }, { help: '早于开始时间表示跨夜；00:00 表示当天结束。' }));
        const placeKey = scheduleDraft.mapId && scheduleDraft.nodeId ? JSON.stringify([scheduleDraft.mapId, scheduleDraft.nodeId]) : '', locations = [['', '选择已发现地点'], ...refs.map(ref => [JSON.stringify([ref.mapId, ref.nodeId]), ref.mapName + ' / ' + ref.nodeName])];
        if (placeKey && !locations.some(([key]) => key === placeKey)) locations.push([placeKey, '缺失或未发现 ' + scheduleDraft.mapId + '/' + scheduleDraft.nodeId]);
        form.append(selectField('预计地点', placeKey, locations, value => { [scheduleDraft.mapId, scheduleDraft.nodeId] = value ? JSON.parse(value) : ['', '']; }, true));
        const weekdays = state.clock ? clockWeekday(state.clock).names : ['日', '一', '二', '三', '四', '五', '六'], days = node('div', null, 'amin-stack amin-span-full'); days.append(node('span', '发生星期（全部不选表示每日）'));
        weekdays.forEach((name, index) => days.append(check(name, scheduleDraft.weekdays.includes(index), value => { scheduleDraft.weekdays = value ? [...scheduleDraft.weekdays, index] : scheduleDraft.weekdays.filter(day => day !== index); })));
        form.append(days, check('启用这条日程', scheduleDraft.enabled, value => { scheduleDraft.enabled = value; }), field('备注', scheduleDraft.notes, value => { scheduleDraft.notes = value; }, { multi: true, full: true }));
        const actions = node('div', null, 'amin-toolbar'); actions.append(button('预览保存日程', () => stage('save-schedule', { schedule: scheduleDraft, reason: '保存人物日程：' + scheduleDraft.title }), true), button('新建另一条', () => { scheduleId = ''; loadSchedule(state); render(); }));
        editor.append(form, actions); body.append(editor);
    }
    function renderAbsence(state) {
        body.append(node('p', '离场规则只生成可确认的变化。打开场景、读取上下文和推进时钟不会执行这些变化；规则不会自动移动人物、扣血或扣物品。', 'amin-meta'));
        for (const item of absenceFor()) {
            const entry = card(item.sceneName + ' · ' + item.title);
            entry.append(node('p', item.status + (item.elapsedMinutes === null ? '' : ` · 已过去 ${item.elapsedMinutes} 分钟 / ${item.cycles} 个周期`)), node('p', `${item.before || '空'} → ${item.after || '空'}`));
            const actions = node('div', null, 'amin-toolbar'), settle = button('预览确认此变化', () => stage('settle-absence', { ruleIds: [item.ruleId], reason: '确认离场变化：' + item.title }), true); settle.disabled ||= !item.due;
            actions.append(settle, button('编辑规则', () => { absenceId = item.ruleId; loadAbsence(state); render(); }), button('预览删除', () => stage('delete-absence-rule', { id: item.ruleId, reason: '删除离场规则：' + item.title }))); entry.append(actions); body.append(entry);
        }
        const editor = card(absenceId ? '编辑离场规则' : '新建离场规则'), form = node('div', null, 'amin-form-grid');
        form.append(selectField('场景', absenceDraft.sceneId, [['', '选择场景'], ...Object.values(state.scenes).map(value => [value.id, value.name])], value => { absenceDraft.sceneId = value; }),
            field('规则名称', absenceDraft.title, value => { absenceDraft.title = value; }), field('离场周期（分钟）', absenceDraft.intervalMinutes, value => { absenceDraft.intervalMinutes = value; }, { type: 'number', min: 1, max: 5256000 }),
            selectField('变化字段', absenceDraft.field, [['weather', '天气与环境'], ['objects', '场景物件'], ['notes', '其他已确认资料']], value => { absenceDraft.field = value; }),
            field('到期后建议改为', absenceDraft.value, value => { absenceDraft.value = value; }, { full: true, multi: true, help: '填写完整的新值。预览会展示旧值与新值；多周期也只应用一次。' }), check('启用此规则', absenceDraft.enabled, value => { absenceDraft.enabled = value; }));
        const actions = node('div', null, 'amin-toolbar'); actions.append(button('预览保存规则', () => stage('save-absence-rule', { rule: absenceDraft, reason: '保存离场规则：' + absenceDraft.title }), true), button('新建另一条', () => { absenceId = ''; loadAbsence(state); render(); })); editor.append(form, actions); body.append(editor);
    }
    function render() {
        if (disposed) return;
        let state, currentToken;
        try { currentToken = api.capture(); state = validateState(api.read()); } catch (e) { body.replaceChildren(node('p', e.message, 'amin-empty')); review.replaceChildren(); intro.textContent = contextLine(api.context(), '数据不可读取'); return; }
        const moved = !token || token.identity !== currentToken.identity || token.metadata !== currentToken.metadata || token.path !== currentToken.path;
        if (moved || token.basis !== currentToken.basis || token.references !== currentToken.references) resetDrafts(state, moved);
        token = currentToken;
        intro.textContent = contextLine(api.context(), formatGameTime(state.clock, state.periods), state.scenes[state.activeSceneId]?.name ?? '未进入场景', state.settings.enabled && state.settings.includeInContext ? '已开启 AI 读取' : '仅本地记录');
        tabs.replaceChildren();
        const names = ['时钟', '场景', '日程', '离场', '旅行', '记录', '设置'];
        for (const name of names) {
            const b = button(name, () => { tab = name; render(); }); b.id = instance + '-' + name; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(tab === name)); b.setAttribute('aria-controls', body.id); b.tabIndex = tab === name ? 0 : -1;
            b.addEventListener('keydown', e => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return; e.preventDefault(); tab = e.key === 'Home' ? names[0] : e.key === 'End' ? names.at(-1) : names[(names.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : names.length - 1)) % names.length]; render(); tabs.querySelector('[aria-selected="true"]')?.focus(); });
            tabs.append(b);
        }
        body.setAttribute('aria-labelledby', instance + '-' + tab);
        body.replaceChildren(); renderReview(state);
        if (tab === '时钟') renderClock(state); else if (tab === '场景') renderScenes(state); else if (tab === '日程') renderSchedules(state); else if (tab === '离场') renderAbsence(state); else if (tab === '旅行') { body.append(travelHost); travelView.open(); } else if (tab === '记录') renderHistory(state); else renderSettings();
        say(error ? message : api.status(), error);
        if (api.dirty()) { const retry = card('保存尚未完成'); retry.append(node('p', '已确认操作保留在当前聊天内存中。重试保存会沿用同一条记录。'), button('重试保存', () => api.retrySave(), true)); body.prepend(retry); }
    }
    const selectCharacter = event => { if (event.detail?.app !== 'scene' || typeof event.detail?.characterId !== 'string') return; characterFilter = event.detail.characterId; scheduleId = ''; tab = '日程'; loadSchedule(validateState(api.read())); render(); };
    document.addEventListener?.('amin:select-character', selectCharacter);
    const unsubscribe = api.subscribe(render); render();
    const view = {
        open() { if (disposed) return; api.sync(); render(); },
        dispose() { if (disposed) return; disposed = true; generationView.dispose(); unsubscribe(); document.removeEventListener?.('amin:select-character', selectCharacter); travelView.dispose(); page.remove(); if (mountedViews.get(target) === view) mountedViews.delete(target); },
    };
    mountedViews.set(target, view); return view;
}
