import { getSharedTravelService } from '../map/travel.js';
import { formatGameTime } from './model.js';
import {linkedEmpty} from '../shared/open-app.js';

const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    return element;
};

const minutesLabel = value => `${value} 分钟${value >= 60 ? `（${Math.floor(value / 60)} 小时${value % 60 ? ` ${value % 60} 分钟` : ''}）` : ''}`;

export function appendExpiryPreview(parent, effects, { empty = true } = {}) {
    const list = Array.isArray(effects) ? effects : [];
    const section = node('section', null, 'amin-card amin-stack');
    section.append(node('h3', '限时效果结算'));
    if (!list.length) {
        if (!empty) return null;
        section.append(node('p', '本次时间变化没有新的限时效果到期。', 'amin-empty'));
    } else {
        for (const effect of list) {
            const label = [effect.name, effect.target, effect.scope].filter(Boolean).join(' · ');
            section.append(node('p', label || '未命名效果', 'amin-result'));
        }
    }
    section.append(node('p', '到期效果从新游戏时间起不再附加剧情提醒；结算只读取游戏时钟，不调用模型。', 'amin-meta'));
    parent.append(section);
    return section;
}

export function mountTravel(target, { service = getSharedTravelService(), periods = () => [] } = {}) {
    const root = node('div', null, 'amin-stack amin-travel');
    const notice = node('div', null, 'amin-notice');
    notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    root.append(notice); target.append(root);
    let selectedEdge = '', selectedNode = '', methodId = '', sceneId = '', manual = false, minutes = '', reason = '';
    let lastScope = null, disposed = false, running = false, message = '', failed = false;

    const card = title => { const element = node('section', null, 'amin-card amin-stack'); if (title) element.append(node('h3', title)); return element; };
    const action = (label, fn, primary = false) => {
        const button = node('button', label, primary ? 'amin-primary' : ''); button.type = 'button';
        button.disabled = running || service.busy();
        button.addEventListener('click', async () => {
            if (running || service.busy()) return;
            running = true; message = ''; failed = false; render();
            try { await fn(); }
            catch (error) { message = error.message; failed = true; }
            finally { running = false; if (!disposed) render(); }
        });
        return button;
    };
    const field = (label, value, onChange, { type = 'text', min, max, help } = {}) => {
        const wrap = node('label', null, 'amin-field'), input = node('input'); input.type = type; input.value = value ?? '';
        input.setAttribute('aria-label', label); if (min != null) input.min = min; if (max != null) input.max = max;
        input.addEventListener('input', () => onChange(input.value)); wrap.append(node('span', label), input); if (help) wrap.append(node('small', help)); return { wrap, input };
    };
    const selectField = (label, options, value, onChange) => {
        const wrap = node('label', null, 'amin-field'), select = node('select'); select.setAttribute('aria-label', label);
        for (const [id, text] of options) { const option = node('option', text); option.value = id; select.append(option); }
        select.value = value; select.addEventListener('change', () => onChange(select.value)); wrap.append(node('span', label), select); return { wrap, select };
    };
    const check = (label, value, onChange) => {
        const wrap = node('label', null, 'amin-check'), input = node('input'); input.type = 'checkbox'; input.checked = value;
        input.addEventListener('change', () => onChange(input.checked)); wrap.append(input, node('span', label)); return wrap;
    };
    function resetForScope(token) {
        const scope = { identity: token.identity, metadata: token.metadata, path: token.path };
        if (lastScope && lastScope.identity === scope.identity && lastScope.metadata === scope.metadata && lastScope.path === scope.path) return;
        lastScope = scope; selectedEdge = ''; selectedNode = ''; methodId = ''; sceneId = ''; manual = false; minutes = ''; reason = '';
    }
    function routeFor(options) { return options.routes.find(route => route.edgeId === selectedEdge && route.nodeId === selectedNode); }
    function selectRoute(route, options) {
        selectedEdge = route.edgeId; selectedNode = route.nodeId; sceneId = route.scenes.length === 1 ? route.scenes[0].id : '';
        manual = route.minutes == null; minutes = route.minutes == null ? '' : String(route.minutes); reason = `从${options.fromName}前往${route.name}`; render();
    }
    function previewCard(preview) {
        const summary = preview.summary ?? {}, panel = card(preview.label || '待确认旅行'); panel.classList.add('amin-result');
        panel.append(node('p', `${summary.from ?? '当前位置'} → ${summary.to ?? '目的地'}`));
        if (summary.routeName || summary.methodName) panel.append(node('p', [summary.routeName, summary.methodName].filter(Boolean).join(' · '), 'amin-meta'));
        panel.append(node('p', `耗时：${minutesLabel(summary.minutes ?? 0)} · ${summary.timeSource ?? '已确认'}`));
        panel.append(node('p', `${formatGameTime(summary.beforeTime, periods())} → ${formatGameTime(summary.afterTime, periods())}`));
        panel.append(node('p', `${summary.sceneAction ? summary.sceneAction + '：' : '抵达后进入场景：'}${summary.sceneName ?? '目的地场景'}`));
        appendExpiryPreview(panel, summary.dueEffects);
        const actions = node('div', null, 'amin-savebar');
        actions.append(action('确认旅行一次', () => service.confirm(), true), action('取消预览', () => service.discard())); panel.append(actions); return panel;
    }
    function render() {
        if (disposed) return;
        root.replaceChildren(notice); notice.textContent = ''; notice.dataset.state = '';
        root.setAttribute('aria-busy', String(running || service.busy()));
        let token, options;
        try {
            token = service.capture(); resetForScope(token);
            options = service.destinations(methodId || undefined);
            if (!methodId && options.methodId) methodId = options.methodId;
        } catch (error) {
            root.append(node('p', error.message, 'amin-empty')); return;
        }
        notice.textContent = message || service.status(); notice.dataset.state = failed ? 'error' : service.busy() || running ? 'busy' : '';
        if (service.dirty()) {
            const retry = card('保存尚未完成');
            retry.append(node('p', '旅行已应用到当前聊天。这里只重试保存，不会再次移动、推进时间或切换场景。'), action('重试保存', () => service.retrySave(), true)); root.append(retry);
        }
        const pending = service.preview(); if (pending) root.append(previewCard(pending));

        const context = card('当前位置');
        context.append(node('strong', options.fromName ? `${options.mapName} / ${options.fromName}` : options.mapName));
        context.append(node('p', options.clock ? `出发时间：${formatGameTime(options.clock, periods())}` : '尚未设置游戏时间；请先到“时钟”页设置。', 'amin-meta'));
        root.append(context);

        const reachable = options.routes.filter(route => route.accessible);
        const destinations = card('选择相邻目的地');
        if (!options.fromNodeId) destinations.append(linkedEmpty(node, '当前地图没有已保存的位置。请先在地图中设置当前位置。', 'map'));
        else if (!reachable.length) destinations.append(node('p', '当前地点没有已发现且可从此方向通行的相邻道路。', 'amin-empty'));
        for (const route of reachable) {
            const selected = route.edgeId === selectedEdge && route.nodeId === selectedNode, item = node('section', null, 'amin-card amin-stack');
            item.append(node('strong', route.name), node('p', `经由：${route.routeName}`, 'amin-meta'));
            if (route.description) item.append(node('p', route.description));
            const currentMethod = route.methods.find(method => method.id === methodId);
            item.append(node('p', currentMethod?.minutes == null ? '地图资料未给出可计算的耗时，选择后需手动填写。' : `预计耗时：${minutesLabel(currentMethod.minutes)}`, 'amin-meta'));
            const choose = action(selected ? '已选择' : '选择目的地', () => selectRoute(route, options), selected); choose.setAttribute('aria-pressed', String(selected)); item.append(choose); destinations.append(item);
        }
        const blocked = options.routes.filter(route => !route.accessible);
        if (blocked.length) {
            const detail = node('details'), summary = node('summary', `不可从当前方向到达 · ${blocked.length} 项`); detail.append(summary);
            for (const route of blocked) detail.append(node('p', `${route.name}：${route.reason || '当前不可通行'}`, 'amin-meta')); destinations.append(detail);
        }
        root.append(destinations);

        const route = routeFor(options);
        if (route) {
            const formCard = card('旅行参数'), form = node('div', null, 'amin-form-grid');
            const methodOptions = options.methods.length ? options.methods.map(method => [method.id, `${method.name} · 速度 ${method.speed} 地图距离单位/小时`]) : [['', '手动指定耗时']];
            form.append(selectField('通行方式与速度', methodOptions, methodId, value => {
                methodId = value; const next = service.destinations(methodId || undefined), nextRoute = routeFor(next);
                if (!nextRoute) { selectedEdge = ''; selectedNode = ''; return render(); }
                manual = nextRoute.minutes == null; minutes = nextRoute.minutes == null ? '' : String(nextRoute.minutes); render();
            }).wrap);
            if (route.minutes != null) form.append(check('手动覆盖地图估算耗时', manual, value => { manual = value; if (!manual) minutes = String(route.minutes); render(); }));
            if (route.minutes == null || manual) {
                const duration = field('本次旅行耗时（分钟）', minutes, value => { minutes = value; }, { type: 'number', min: 0, max: 5256000, help: route.minutes == null ? '地图距离或速度不足，必须明确填写整数分钟。' : `地图估算为 ${route.minutes} 分钟；当前将使用你填写的值。` });
                form.append(duration.wrap);
            } else form.append(node('p', `将使用地图距离与速度估算：${minutesLabel(route.minutes)}。`, 'amin-meta amin-span-full'));
            if (route.scenes.length > 1) {
                form.append(selectField('抵达后进入场景', [['', '请选择一个已关联场景'], ...route.scenes.map(scene => [scene.id, scene.name])], sceneId, value => { sceneId = value; }).wrap);
            } else form.append(node('p', route.scenes.length === 1 ? `抵达后进入已关联场景：${route.scenes[0].name}` : `抵达后新建并进入场景：${route.name}`, 'amin-meta amin-span-full'));
            form.append(field('旅行确认原因', reason, value => { reason = value; }, { help: '记录为什么在当前剧情进行这次旅行。' }).wrap);
            formCard.append(form);
            const stage = action('预览旅行', () => {
                if (route.scenes.length > 1 && !sceneId) throw Error('请选择抵达后进入的场景。');
                const explicit = route.minutes == null || manual;
                return service.stage({ nodeId: route.nodeId, edgeId: route.edgeId, methodId: methodId || undefined, minutes: explicit ? minutes : undefined, reason, sceneId: sceneId || undefined }, token);
            }, true);
            stage.disabled ||= !options.clock || service.dirty() || !!pending;
            const savebar = node('div', null, 'amin-savebar'); savebar.append(stage); formCard.append(savebar); root.append(formCard);
        }
    }
    const unsubscribe = service.subscribe(render); render();
    const view = { open() { render(); }, dispose() { if (disposed) return; disposed = true; unsubscribe(); root.remove(); } };
    return view;
}
