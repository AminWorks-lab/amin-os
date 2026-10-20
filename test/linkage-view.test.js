import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from '../apps/linkage/view.js';

class Node {
    constructor(tag, document) { this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.parent = null; this.attributes = {}; this.dataset = {}; this.listeners = new Map(); this._text = ''; this.value = ''; this.hidden = false; this.disabled = false; this.checked = false; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
    replaceChildren(...nodes) { for (const child of this.children) child.parent = null; this.children = []; this._text = ''; this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    async dispatch(type) { for (const fn of this.listeners.get(type) ?? []) await fn({ target: this }); }
    querySelectorAll(selector) { return walk(this).slice(1).filter(node => selector === '[data-linkage-lock]' ? node.dataset.linkageLock : selector === '[data-linkage-invalid]' ? node.dataset.linkageInvalid : node.tagName === selector.toUpperCase()); }
    focus() { this.ownerDocument.activeElement = this; }
    select() { this.selected = true; }
}
const walk = root => [root, ...root.children.flatMap(walk)];
const find = (root, label, tag = 'button') => walk(root).find(node => node.tagName === tag.toUpperCase() && (node.textContent === label || node.getAttribute('aria-label') === label));
async function click(root, label) { const node = find(root, label); assert.ok(node, 'missing button: ' + label); assert.equal(node.disabled, false, 'disabled button: ' + label); await node.dispatch('click'); return node; }
async function toggle(root, label, checked) { const node = find(root, label, 'input'); assert.ok(node, 'missing checkbox: ' + label); assert.equal(node.disabled, false, 'disabled checkbox: ' + label); node.checked = checked; await node.dispatch('change'); return node; }
async function input(root, label, value, tag = 'textarea') { const node = find(root, label, tag); assert.ok(node, 'missing field: ' + label); node.value = value; await node.dispatch(tag === 'select' ? 'change' : 'input'); return node; }
const notice = root => walk(root).find(node => node.className === 'amin-notice')?.textContent;

test('session update records render text safely and clear without triggering execution', async () => {
    const f = fixture();
    let records = [{ index: 4, swipe: 1, source: 'generation', receivedState: true, outcome: 'native-error', errors: ['字段不存在'], warnings: [], changes: [{ path: '状态栏.hp', before: '10', after: '<script>7</script>' }] }];
    f.api.updateDiagnostics = () => records;
    f.api.clearUpdateDiagnostics = () => { records = []; };
    try {
        f.nativeStatus({ ready: true });
        assert.match(f.root.textContent, /第 5 楼 · Swipe 2 · 小白报告更新错误/);
        assert.match(f.root.textContent, /更新前：10/); assert.match(f.root.textContent, /更新后：<script>7<\/script>/);
        assert.equal(walk(f.root).some(node => node.tagName === 'SCRIPT'), false);
        await click(f.root, '清空更新记录');
        assert.match(f.root.textContent, /尚无本次运行的更新记录/);
        assert.equal(f.calls.includes('confirm'), false);
    } finally { f.view.dispose(); }
});

test('stale story references require inspection and explicit confirmation before rebinding', async () => {
    const f = fixture({ nativeMigrated: true });
    const plan = { repairs: [{ index: 10, stateId: 'original-state' }], token: 'preview-token' };
    let repairs = 0;
    f.api.inspectStoryReferences = async () => plan;
    f.api.repairStoryReferences = async value => { assert.equal(value, plan); repairs++; return { message: '引用已恢复' }; };
    try {
        f.nativeStatus({ ready: false, restoreError: '校验不一致' });
        assert.equal(find(f.root, '确认采用这些楼层的原有存档'), undefined);
        await click(f.root, '检查剧情存档引用');
        assert.equal(repairs, 0);
        assert.match(f.root.textContent, /校验不一致的楼层：11/);
        await click(f.root, '确认采用这些楼层的原有存档');
        assert.equal(repairs, 1);
        assert.equal(find(f.root, '确认采用这些楼层的原有存档'), undefined);
    } finally { f.view.dispose(); }
});

test('prompt and update shortcuts scroll only the owned panel and never pan the host document', () => {
    const f = fixture({ enabled:true });
    try {
        const outer = new Node('div',f.document); outer.scrollTop=145;outer.append(f.root);
        f.root.scrollTop=70;f.root.clientTop=2;f.root.getBoundingClientRect=()=>({top:200});
        for(const node of walk(f.root)) node.scrollIntoView=()=>{throw Error('Must not scroll host ancestors');};
        const summary=find(f.root,'统一世界书条目与预览','summary'), prompt=summary.parent;
        prompt.getBoundingClientRect=()=>({top:900});
        let focusOptions;summary.focus=options=>{focusOptions=options;f.document.activeElement=summary;};
        f.view.open('prompt');assert.equal(prompt.open,true);assert.equal(f.root.scrollTop,768);
        assert.equal(outer.scrollTop,145);assert.deepEqual(focusOptions,{preventScroll:true});assert.equal(f.document.activeElement,summary);
        const native=find(f.root,'剧情变量 · 小白变量 2.0','h3').parent;native.getBoundingClientRect=()=>({top:450});
        f.view.open('updates');assert.equal(f.root.scrollTop,1016);assert.equal(outer.scrollTop,145);
    } finally { f.view.dispose(); }
});

function fixture({ enabled = false, dataPreview = true, nativeAvailable = true, nativeMigrated = false, templates = false } = {}) {
    let template = null;
    const listeners = new Set(), calls = [], availability = { status: true, inventory: true, scene: false, dice: true };
    const labels = { status: '世界状态', inventory: '背包与账本', scene: '场景与时间', dice: '固定骰点（只读）' };
    let settings = { version: 1, enabled, mode: 'review', dataSource: 'amin', modules: { status: { enabled: true, read: true, write: true }, inventory: { enabled: true, read: true, write: true }, scene: { enabled: false, read: false, write: false }, dice: { enabled: true, read: true, write: false } }, extraRules: '' };
    let pending = null, dirty = false, failSave = false, failCheck = false, count = 0, suggestions = [], status = '';
    let native = { available: nativeAvailable, migrated: nativeMigrated, message: nativeAvailable ? nativeMigrated ? '剧情变量已迁移。' : '可以迁移剧情变量。' : '未检测到小白变量 2.0。' };
    const emit = () => { for (const listener of listeners) listener(); };
    const proposal = { label: '跨应用剧情更新', summary: ['已饮用药剂', '恢复生命'], changes: [
        { module: 'inventory', action: 'consume', target: '药剂', reason: '已饮用', before: { count: 2 }, after: { count: 1 } },
        { module: 'status', action: 'set', target: '生命', reason: '<script>text only</script>', before: { hp: 7 }, after: { hp: 10 } },
    ], warnings: [] };
    const api = {
        ...(templates ? { scopeTemplate: () => structuredClone(template), async saveScopeTemplate() { template = { enabled: settings.enabled, modules: structuredClone(settings.modules) }; calls.push('template'); } } : {}),
        settings: () => structuredClone(settings), modules: () => Object.keys(labels).map(id => ({ id, label: labels[id], available: availability[id], ...settings.modules[id] })),
        async saveSettings(value) { calls.push('settings'); settings = structuredClone(value); emit(); },
        async saveLinks(links) { calls.push('links'); settings = { ...settings, links: structuredClone(links) }; emit(); },
        prompt: () => settings.enabled ? '统一条目\n' + settings.extraRules + '\n' + JSON.stringify(settings.modules) : '',
        ...(dataPreview ? { dataPrompt: () => settings.dataSource !== 'external' && settings.enabled && settings.modules.inventory.enabled && settings.modules.inventory.read ? '当前资料：红色围巾，数量 1，持有人艾琳' : '' } : {}),
        nativeState2Status: () => structuredClone(native),
        async migrateState2() { calls.push('migrate'); native = { available: true, migrated: true, message: '剧情变量已迁移。' }; emit(); return { changed: true, message: native.message }; },
        busy: () => false, dirty: () => dirty, status: () => status, preview: () => pending && structuredClone(pending),
        stage(raw) { calls.push('stage'); if (raw === 'invalid') throw Error('格式无效'); pending = structuredClone(proposal); emit(); return pending; },
        stageSuggestion(id) { calls.push('suggestion:' + id); pending = structuredClone(proposal); emit(); return pending; },
        async confirm() { calls.push('confirm'); count++; pending = null; if (failSave) { dirty = true; emit(); throw Error('保存失败'); } emit(); },
        discard() { calls.push('discard'); pending = null; emit(); },
        async retrySave() { calls.push('retry'); dirty = false; emit(); },
        suggestions: () => structuredClone(suggestions),
        references: () => ({ entities: [{ id: 'characters:p1', module: 'characters', label: '艾琳' },{ id:'inventory:i1',module:'inventory',label:'红色围巾' }], links: [{ from: 'inventory:i1', to: 'characters:p1', label: '持有者' },...(settings.links??[])], unresolved: [{ from: 'scene:plan1', to: 'characters:missing', label: '日程人物不存在' }] }),
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    };
    const document = { createElement: tag => new Node(tag, document) }, root = new Node('main', document);
    const view = mount(root, { api, document, createId:()=> 'manual-link-1', check() { if (failCheck) throw Error('聊天已切换'); }, getContext: () => ({}), clipboard: { writeText: async value => { calls.push(['copy', value]); } }, worldbook: {
        inspect: async () => { calls.push('inspect'); return { name: '当前世界', exists: true, valid: true, message: '条目已就绪', content:'用户前文\n{{amin_os_linkage}}\n用户后文' }; },
        install: async () => { calls.push('install'); return { name: '当前世界', uid: 7, action: '已新增', message: '已保存模板' }; },
    } });
    return { root, view, api, calls, document, settings: () => settings, count: () => count, listenerCount: () => listeners.size,
        failSave(value) { failSave = value; }, failCheck(value) { failCheck = value; }, emit, reportHost(value) {status=value;emit();},
        available(id, value) { availability[id] = value; emit(); },
        nativeStatus(value) { native = { ...native, ...value }; emit(); },
        suggest() { suggestions = [{ id: 's1', source: { index: 3, swipe: 0, identity: 'internal', path: ['internal'], text: 'all-message' }, text: '<amin_update>test</amin_update>' }]; emit(); },
    };
}

test('linkage settings remain draft until saved, and write permission requires read without changing inactive modules', async () => {
    const f = fixture(); try {
        assert.equal(f.settings().enabled, false); assert.equal(find(f.root, '安装／更新统一条目').disabled, true);
        assert.equal(find(f.root, '场景与时间 · 启用此模块', 'input').disabled, false);
        assert.equal(find(f.root, '固定骰点（只读） · 允许模型更新', 'input').disabled, true);
        await toggle(f.root, '启用统一联动更新', true);
        await toggle(f.root, '世界状态 · 提供资料给模型', false);
        assert.equal(find(f.root, '世界状态 · 允许模型更新', 'input').checked, false);
        assert.equal(f.settings().modules.status.write, true);
        await toggle(f.root, '世界状态 · 允许模型更新', true);
        assert.equal(find(f.root, '世界状态 · 提供资料给模型', 'input').checked, true);
        await input(f.root, '额外联动规则', '仅按正文明确变化更新'); await click(f.root, '保存联动设置');
        assert.equal(f.settings().enabled, true); assert.equal(f.settings().extraRules, '仅按正文明确变化更新');
        assert.deepEqual(f.settings().modules.scene, { enabled: false, read: false, write: false });
        assert.equal(find(f.root, '安装／更新统一条目').disabled, false);
        assert.match(find(f.root, '统一条目预览内容', 'textarea').value, /仅按正文明确变化更新/);
        await input(f.root, '额外联动规则', '尚未保存的新规则'); assert.equal(find(f.root, '安装／更新统一条目').disabled, true);
        assert.doesNotMatch(find(f.root, '统一条目预览内容', 'textarea').value, /尚未保存的新规则/);
        await click(f.root, '放弃未保存修改'); assert.equal(find(f.root, '额外联动规则', 'textarea').value, '仅按正文明确变化更新');
    } finally { f.view.dispose(); }
});

test('disabling a module preserves its read/write preferences and a module becoming available refreshes controls', async () => {
    const f = fixture({ enabled: true }); try {
        await toggle(f.root, '背包与账本 · 启用此模块', false);
        assert.equal(find(f.root, '背包与账本 · 允许模型更新', 'input').disabled, true);
        await click(f.root, '保存联动设置'); assert.deepEqual(f.settings().modules.inventory, { enabled: false, read: true, write: true });
        f.available('scene', true); assert.equal(find(f.root, '场景与时间 · 启用此模块', 'input').disabled, false);
        await toggle(f.root, '场景与时间 · 启用此模块', true); await click(f.root, '保存联动设置');
        assert.equal(f.settings().modules.scene.enabled, true);
    } finally { f.view.dispose(); }
});

test('modules without current-chat records can be explicitly enabled and granted update access', async () => {
    const f=fixture();try {
        assert.match(f.root.textContent,/尚无资料，可先启用/);await toggle(f.root,'场景与时间 · 启用此模块',true);await toggle(f.root,'场景与时间 · 允许模型更新',true);await click(f.root,'保存联动设置');
        assert.deepEqual(f.settings().modules.scene,{enabled:true,read:true,write:true});
    }finally{f.view.dispose();}
});

test('a multi-app suggestion renders safe before/after values and waits for one explicit confirmation', async () => {
    const f = fixture({ enabled: true }); try {
        f.suggest(); assert.match(f.root.textContent, /第 4 楼/); assert.doesNotMatch(f.root.textContent, /internal/);
        await click(f.root, '校验并预览这组更新');
        assert.equal(f.count(), 0); assert.equal(find(f.root, '启用统一联动更新', 'input').disabled, true);
        assert.match(f.root.textContent, /更新前/); assert.match(f.root.textContent, /更新后/); assert.match(f.root.textContent, /"hp": 10/);
        assert.equal(walk(f.root).some(node => node.tagName === 'SCRIPT'), false); assert.match(f.root.textContent, /<script>text only<\/script>/);
        await click(f.root, '确认整组更新一次'); assert.equal(f.count(), 1); assert.equal(find(f.root, '确认整组更新一次'), undefined);
    } finally { f.view.dispose(); }
});

test('a failed save exposes retry instead of executing the changes a second time', async () => {
    const f = fixture({ enabled: true }); try {
        await input(f.root, '待校验的统一更新内容', '{}'); await click(f.root, '校验并预览粘贴内容');
        f.failSave(true); await click(f.root, '确认整组更新一次'); assert.equal(f.count(), 1); assert.match(notice(f.root), /保存失败/);
        assert.equal(find(f.root, '启用统一联动更新', 'input').disabled, true); assert.ok(find(f.root, '重试保存整组更新'));
        f.failSave(false); await click(f.root, '重试保存整组更新'); assert.equal(f.count(), 1); assert.equal(f.calls.filter(call => call === 'retry').length, 1);
        assert.equal(find(f.root, '启用统一联动更新', 'input').disabled, false);
    } finally { f.view.dispose(); }
});

test('malformed and stale imports surface errors, retain pasted text and do not call confirm', async () => {
    const f = fixture({ enabled: true }); try {
        await input(f.root, '待校验的统一更新内容', 'invalid'); await click(f.root, '校验并预览粘贴内容');
        assert.match(notice(f.root), /格式无效/); assert.equal(find(f.root, '待校验的统一更新内容', 'textarea').value, 'invalid');
        f.failCheck(true); await click(f.root, '校验并预览粘贴内容');
        assert.match(notice(f.root), /聊天已切换/); assert.equal(f.calls.filter(call => call === 'stage').length, 1); assert.equal(f.count(), 0);
    } finally { f.view.dispose(); }
});

test('worldbook controls use saved settings and keep complete prompt available for copying', async () => {
    const f = fixture({ enabled: true }); try {
        await click(f.root, '检查绑定世界书'); assert.match(f.root.textContent, /世界书「当前世界」：条目已就绪/);
        await click(f.root, '安装／更新统一条目'); assert.match(f.root.textContent, /世界书「当前世界」：已保存模板/);
        await click(f.root, '复制条目预览'); assert.deepEqual(f.calls.find(call => Array.isArray(call)), ['copy', '用户前文\n'+f.api.prompt()+'\n用户后文']);
        assert.match(f.root.textContent, /日程人物不存在/); assert.match(f.root.textContent, /characters:missing/);
    } finally { f.view.dispose(); }
});

test('mount is idempotent and disposal removes live updates', () => {
    const f = fixture(); assert.equal(mount(f.root, { api: f.api, document: f.document }), f.view); assert.equal(f.listenerCount(), 1);
    f.view.dispose(); f.view.dispose(); assert.equal(f.listenerCount(), 0); assert.equal(f.root.children.length, 0); f.emit(); assert.equal(f.root.children.length, 0);
});

test('manual links require explicit existing endpoints and deletion leaves derived links and entities intact', async () => {
    const f=fixture({enabled:true});try {
        await click(f.root,'保存新关联');assert.match(notice(f.root),/请选择仍然存在/);assert.equal(f.settings().links,undefined);
        await input(f.root,'关联来源条目','characters:p1','select');await input(f.root,'关联目标条目','inventory:i1','select');await input(f.root,'关联说明','赠送的纪念品','input');
        assert.equal(f.settings().links,undefined);await click(f.root,'保存新关联');assert.deepEqual(f.settings().links,[{id:'manual-link-1',from:'characters:p1',to:'inventory:i1',label:'赠送的纪念品'}]);
        assert.equal(walk(f.root).filter(node=>node.tagName==='BUTTON'&&node.textContent==='解除手动关联').length,1);
        await click(f.root,'解除手动关联：赠送的纪念品');assert.deepEqual(f.settings().links,[]);assert.equal(f.api.references().entities.length,2);assert.equal(f.api.references().links.length,1);assert.match(f.root.textContent,/持有者/);
    }finally{f.view.dispose();}
});

test('unsaved linkage configuration blocks manual-link changes until the configuration is resolved', async () => {
    const f=fixture({enabled:true});try {
        await input(f.root,'额外联动规则','新规则');assert.equal(find(f.root,'保存新关联').disabled,true);
        assert.equal(find(f.root,'关联来源条目','select').disabled,true);
        await click(f.root,'放弃未保存修改');assert.equal(find(f.root,'保存新关联').disabled,false);
    }finally{f.view.dispose();}
});

test('later host availability reports replace an earlier local success notice', async () => {
    const f=fixture();try {
        await toggle(f.root,'启用统一联动更新',true);await click(f.root,'保存联动设置');assert.match(notice(f.root),/设置已保存/);
        f.reportHost('当前宿主尚未提供统一条目读取接口。');assert.equal(notice(f.root),'当前宿主尚未提供统一条目读取接口。');
    }finally{f.view.dispose();}
});


test('worldbook rules and injected application data have independent previews and copying', async () => {
    const f=fixture({enabled:true});try {
        const data=find(f.root,'消息内资料预览内容','textarea');
        assert.equal(data.readOnly,true);assert.match(data.value,/红色围巾/);
        assert.ok(find(f.root,'消息内资料预览','summary'));assert.equal(f.calls.includes('inspect'),false);
        assert.doesNotMatch(find(f.root,'统一条目预览内容','textarea').value,/红色围巾/);
        await click(f.root,'检查绑定世界书');await click(f.root,'复制条目预览');
        const copied=f.calls.find(call=>Array.isArray(call))[1];assert.match(copied,/用户前文/);assert.doesNotMatch(copied,/红色围巾/);
        assert.doesNotMatch(data.value,/用户前文/);assert.match(f.root.textContent,/不会出现在聊天正文中/);
        await toggle(f.root,'背包与账本 · 提供资料给模型',false);
        assert.match(data.value,/红色围巾/);await click(f.root,'保存联动设置');assert.equal(data.value,'');
        await click(f.root,'刷新消息内资料预览');assert.match(notice(f.root),/已刷新消息内资料预览/);
    }finally{f.view.dispose();}
});

test('older preview adapters without dataPrompt keep rules preview usable', () => {
    const f=fixture({enabled:true,dataPreview:false});try {
        assert.equal(find(f.root,'消息内资料预览内容','textarea').value,'');
        assert.match(find(f.root,'统一条目预览内容','textarea').value,/统一条目/);
        assert.doesNotMatch(notice(f.root)||'',/dataPrompt/);
    }finally{f.view.dispose();}
});

test('live update controls show LittleWhiteBox variables 2.0 instead of legacy review and auto modes', async () => {
    const f=fixture({enabled:true});try {
        assert.match(f.root.textContent,/小白变量 2\.0/);
        assert.match(f.root.textContent,/<state>/);
        assert.equal(find(f.root,'更新处理方式','select'),undefined);
        assert.doesNotMatch(f.root.textContent,/校验通过后自动应用|预览后确认/);
        assert.ok(find(f.root,'初始化／迁移剧情变量'));
        assert.match(f.root.textContent,/保留备份和旧记录/);
        await click(f.root,'初始化／迁移剧情变量');
        assert.deepEqual(f.calls.filter(call=>call==='migrate'),['migrate']);
        assert.match(f.root.textContent,/剧情变量已迁移/);
        assert.equal(f.settings().mode,'review');
    }finally{f.view.dispose();}
});

test('native variable availability is explicit and migration waits for saved settings', async () => {
    const f=fixture({enabled:true,nativeAvailable:false});try {
        assert.match(f.root.textContent,/在小白盒子中启用变量 2\.0/);
        assert.equal(find(f.root,'初始化／迁移剧情变量'),undefined);
        f.nativeStatus({available:true,message:'可以迁移剧情变量。'});
        assert.ok(find(f.root,'初始化／迁移剧情变量'));
        await input(f.root,'额外联动规则','新规则');
        assert.equal(find(f.root,'初始化／迁移剧情变量').disabled,true);
        await click(f.root,'放弃未保存修改');
        assert.equal(find(f.root,'初始化／迁移剧情变量').disabled,false);
    }finally{f.view.dispose();}
});

test('legacy suggestions remain explicitly historical and are hidden when empty', () => {
    const f=fixture({enabled:true});try {
        const panel=find(f.root,'历史 Amin 更新建议','h3').parent;
        assert.equal(panel.hidden,true);
        f.suggest();
        assert.equal(panel.hidden,false);
        assert.match(panel.textContent,/升级前收到的 <amin_update>/);
        assert.ok(find(panel,'校验并预览这组更新'));
    }finally{f.view.dispose();}
});

test('Amin sends storyline data by default and an external source can disable duplicate injection', async () => {
    const f=fixture({enabled:true});try {
        const select=find(f.root,'资料发送来源','select'), data=find(f.root,'消息内资料预览内容','textarea');
        assert.equal(select.value,'amin');assert.match(data.value,/红色围巾/);
        const rules=find(f.root,'统一条目预览内容','textarea').value;
        await input(f.root,'资料发送来源','external','select');
        assert.equal(f.settings().dataSource,'amin');assert.match(data.value,/红色围巾/);
        await click(f.root,'保存联动设置');
        assert.equal(f.settings().dataSource,'external');assert.equal(data.value,'');
        assert.match(f.root.textContent,/Amin 不再插入重复资料/);
        assert.match(f.root.textContent,/宏提供所有选中模块/);
        assert.equal(find(f.root,'统一条目预览内容','textarea').value,rules);
        await input(f.root,'资料发送来源','amin','select');await click(f.root,'保存联动设置');
        assert.equal(f.settings().dataSource,'amin');assert.match(data.value,/红色围巾/);
    }finally{f.view.dispose();}
});

test('scope template saves only saved permissions and loads into a draft before applying', async () => {
    const f = fixture({ enabled: true, templates: true });
    try {
        await input(f.root, '额外联动规则', '本聊天规则');
        assert.equal(find(f.root, '将已保存范围设为通用模板').disabled, true);
        await click(f.root, '保存联动设置');
        await click(f.root, '将已保存范围设为通用模板');
        assert.deepEqual(Object.keys(f.api.scopeTemplate()).sort(), ['enabled', 'modules']);
        await toggle(f.root, '背包与账本 · 启用此模块', false);
        await click(f.root, '保存联动设置');
        await click(f.root, '将通用模板载入当前草稿');
        assert.equal(f.settings().modules.inventory.enabled, false);
        assert.equal(find(f.root, '背包与账本 · 启用此模块', 'input').checked, true);
        assert.equal(find(f.root, '额外联动规则', 'textarea').value, '本聊天规则');
        await click(f.root, '保存联动设置');
        assert.equal(f.settings().modules.inventory.enabled, true);
    } finally { f.view.dispose(); }
});

test('recent rejected updates list time, floor, failing item, category and the raw JSON', async () => {
    const f = fixture();
    let records = [{ id: 'r1', at: '2026-10-20T08:30:00.000Z', index: 4, swipe: 1, manual: false, raw: '{"version":1}', category: 'permission', reason: '背包与账本 未在本次操作的更新范围内。',
        item: { index: 1, module: 'inventory', label: '背包与账本', action: 'create-item', target: '@new:potion' } }];
    f.api.rejections = () => structuredClone(records);
    f.api.clearRejections = () => { records = []; };
    try {
        f.view.open();
        assert.match(f.root.textContent, /最近被拒绝的更新（1）/);
        assert.match(f.root.textContent, /第 5 楼 · 第 2 个候选 · 权限问题/);
        assert.match(f.root.textContent, /失败位置：第 2 项 · 背包与账本 · create-item · @new:potion/);
        assert.match(f.root.textContent, /原因：背包与账本 未在本次操作的更新范围内。/);
        assert.match(f.root.textContent, /查看原始 JSON\{"version":1\}/);
        await click(f.root, '清空列表');
        assert.match(f.root.textContent, /暂无被拒绝的更新/);
    } finally { f.view.dispose(); }
});
