import { assertChatReady } from '../shared/chat-lifecycle.js';
import { chatIdentity } from '../shared/operations.js';
import { MODULE_LABELS, materialize, validateModules, describeModule } from '../saves/adapters.js';
import { validateJSON, validateSnapshot } from '../saves/model.js';
import { ROOTS, validateCurrentStoryRecord, CURRENT_STORY_FORMAT } from './legacy-roots.js';
import { emptyState as emptyRelationships } from '../relationships/model.js';
import { emptyState as emptyScene } from '../scene/model.js';
import { KEY, STATE_FORMAT, MAX_STATE_BYTES, normalizeModules, validateState, canonicalJSON, emptyModules } from './schema.js';

const APP_KEYS = ['amin_os_characters_v1', 'amin_os_inventory_v1', 'amin_os_relationships_v1', 'amin_os_scene_v1',
    'amin_os_journal_v1', 'amin_os_effects_v1', 'dynamicMapV1', 'amin_os_information_v1', 'amin_os_dice_v1', 'amin_os_organizations_v1'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const fail = (code, message) => { throw Object.assign(Error(message), { code }); };

function parsed(value, label) {
    if (typeof value !== 'string') return clone(value);
    try { return JSON.parse(value); } catch { fail('AMIN_MIGRATION_INVALID', `${label}不是有效 JSON，不能迁移。`); }
}
function legacyContext(ctx) {
    const metadata = { ...ctx.chatMetadata }; delete metadata[KEY];
    // These are configuration sources, not canonical story modules.
    delete metadata.amin_os_information_library_v1; delete metadata.amin_os_linkage_v1;
    return { ...ctx, chatMetadata: metadata };
}
function nativeModules(ctx, warnings) {
    const modules = emptyModules(), variables = ctx.chatMetadata.variables ?? {};
    if (!plain(variables)) fail('AMIN_MIGRATION_INVALID', '当前原生变量格式无效，不能迁移。');
    const defaults = {
        relationships: emptyRelationships(), scene: emptyScene(),
        journal: { version: 1, limit: 40000, entries: [], drafts: [] },
        effects: { version: 1, enabled: true, limit: 30000, effects: [], consumedActionIds: [] },
        information: { version: 1, enabled: true, limit: 40000, records: [] },
    };
    for (const [name, root] of Object.entries(ROOTS)) {
        if (!Object.hasOwn(variables, root) || variables[root] === '') continue;
        const value = parsed(variables[root], root);
        if (value === null && name !== 'map') fail('AMIN_MIGRATION_INVALID', `${root}不能是 null，不能迁移。`);
        if (defaults[name]) {
            if (!plain(value)) fail('AMIN_MIGRATION_INVALID', `${root}不是有效对象，不能迁移。`);
            const missing = Object.keys(defaults[name]).filter(key => !Object.hasOwn(value, key));
            modules[name] = { ...defaults[name], ...value };
            if (missing.length) warnings.push(`${MODULE_LABELS[name]}旧变量缺少 ${missing.join('、')}，预览使用模块默认值。`);
        } else modules[name] = value;
    }
    if (Object.hasOwn(variables, '状态栏')) modules.status = parsed(variables.状态栏, '状态栏');
    if (Object.hasOwn(variables, '势力资料')) {
        const extra = ctx.chatMetadata.amin_os_organizations_v1 ?? {};
        if (!plain(extra)) fail('AMIN_MIGRATION_INVALID', '势力配置格式无效，不能迁移。');
        modules.organizations = { version: 1, doc: parsed(variables.势力资料, '势力资料'),
            locks: clone(extra.locks ?? []), assessment: clone(extra.assessment ?? null) };
    }
    return modules;
}
function basis(ctx, source) {
    const metadata = ctx.chatMetadata;
    const selected = { canonical: metadata[KEY] ?? null };
    if (source === 'app') for (const key of APP_KEYS) if (Object.hasOwn(metadata, key)) selected[key] = metadata[key];
    if (source === 'native') selected.organizations = metadata.amin_os_organizations_v1 ?? null;
    if (source === 'native' || source === 'app') {
        const roots = source === 'native' ? [...Object.values(ROOTS), '状态栏', '势力资料'] : ['状态栏', '势力资料'];
        selected.variables = Object.fromEntries(roots.filter(root => Object.hasOwn(metadata.variables ?? {}, root))
            .map(root => [root, metadata.variables[root]]));
    }
    return canonicalJSON(selected);
}
function importModules(bundle, ctx, warnings) {
    if (bundle?.format === STATE_FORMAT && bundle.version === 1) return validateState(bundle.state).modules;
    if (bundle?.format === 'amin-os-save') {
        const saved = validateSnapshot(bundle);
        warnings.push('旧存档中的信息资料库和联动配置不会迁入剧情根，现有配置保留。');
        return { ...saved.modules, informationLibrary: null, linkage: null };
    }
    if (bundle?.format === CURRENT_STORY_FORMAT && bundle.version === 1) {
        const record = validateCurrentStoryRecord(bundle.record);
        if (record.chat !== chatIdentity(ctx)) fail('AMIN_MIGRATION_CHAT_MISMATCH', '旧当前状态备份属于另一条聊天，不能作为本聊天迁移来源。');
        const encoded = record.current.state, variables = clone(encoded.variables);
        for (const root of encoded.jsonStringRoots) variables[root] = JSON.stringify(variables[root]);
        warnings.push('只迁入旧文件已校验的当前快照；旧规则、旧备份和旧文件保留，不运行原生恢复。');
        return nativeModules({ ...ctx, chatMetadata: { ...ctx.chatMetadata, variables } }, warnings);
    }
    if (bundle?.version === 2 && bundle.graph)
        fail('AMIN_MIGRATION_HISTORY_UNSUPPORTED', '旧楼层图存档不能直接猜测为当前状态；请显式选择已校验的当前快照，重复候选不会自动去重。');
    fail('AMIN_MIGRATION_IMPORT_INVALID', '该文件不是可识别的 Amin 独立状态或当前状态备份。');
}

/** Explicit read-only previews; applying them belongs to the canonical writer. */
export function createIndependentMigration(getContext) {
    const plans = new WeakMap();
    function context() {
        const ctx = getContext(); assertChatReady(ctx);
        if (!plain(ctx?.chatMetadata) || !Array.isArray(ctx.chat) || (ctx.getCurrentChatId?.() ?? ctx.chatId) == null)
            fail('AMIN_MIGRATION_NO_CHAT', '请先打开已加载完成的聊天。');
        return ctx;
    }
    function token(ctx, source) {
        return { metadata: ctx.chatMetadata, identity: chatIdentity(ctx), integrity: ctx.chatMetadata.integrity,
            bodies: canonicalJSON(ctx.chat.map(message => [message?.mes ?? null, message?.swipe_id ?? null, message?.swipes ?? null])),
            basis: basis(ctx, source), source };
    }
    function makePreview(ctx, source, read) {
        const warnings = [], errors = []; let modules = emptyModules(), normalized = null;
        try { modules = read(warnings); }
        catch (error) { errors.push({ module: 'source', code: error.code ?? 'AMIN_MIGRATION_INVALID', message: error.message }); }
        const rows = Object.keys(MODULE_LABELS).filter(name => !['informationLibrary', 'linkage'].includes(name)).map(key => {
            const value = modules[key] ?? null; let error, count = '未建立';
            try { validateModules({ ...emptyModules(), [key]: value }); count = describeModule(key, value); }
            catch (cause) {
                error = cause.message; errors.push({ module: key, code: cause.code ?? 'AMIN_MIGRATION_INVALID', message: error });
            }
            return { key, label: MODULE_LABELS[key], count, ...(error ? { error } : {}) };
        });
        if (!errors.length) try { normalized = normalizeModules(modules); }
        catch (error) { errors.push({ module: 'references', code: error.code ?? 'AMIN_MIGRATION_INVALID', message: error.message }); }
        const valid = !errors.length, plan = Object.freeze({});
        const summary = valid ? Object.values(normalized).some(value => value !== null)
            ? '来源已校验；迁移只建立 Amin 当前状态，旧资料与配置保留。'
            : '所选来源没有已建立的当前资料；确认后将建立空 Amin 状态，不恢复旧楼层。'
            : '来源未通过校验，不能迁移；重复编号和缺失引用不会自动修正。';
        plans.set(plan, { token: token(ctx, source), valid, modules: normalized, source, warnings: clone(warnings), summary });
        return { plan, valid, source, modules: rows, errors, warnings, summary };
    }
    function previewLegacy(options = {}) {
        const source = typeof options === 'string' ? options : options.source ?? 'app';
        if (!['app', 'native'].includes(source)) fail('AMIN_MIGRATION_SOURCE_INVALID', '请明确选择当前应用资料或当前原生变量。');
        const ctx = context();
        return makePreview(ctx, source, warnings => source === 'native' ? nativeModules(legacyContext(ctx), warnings) : materialize(legacyContext(ctx)));
    }
    function previewImport(raw) {
        const ctx = context();
        return makePreview(ctx, 'import', warnings => {
            let bundle = raw;
            if (typeof raw === 'string') {
                if (new TextEncoder().encode(raw).length > MAX_STATE_BYTES) fail('AMIN_MIGRATION_IMPORT_INVALID', '导入文件超过大小限制。');
                try { bundle = JSON.parse(raw); } catch { fail('AMIN_MIGRATION_IMPORT_INVALID', '导入文件不是有效 JSON。'); }
            }
            validateJSON(bundle, MAX_STATE_BYTES);
            return importModules(bundle, ctx, warnings);
        });
    }
    function validatePreview(plan) {
        const saved = plan && plans.get(plan);
        if (!saved || !saved.valid) fail('AMIN_MIGRATION_PLAN_INVALID', '迁移预览无效或未通过校验，请重新预览。');
        const ctx = context(), now = token(ctx, saved.source);
        if (now.metadata !== saved.token.metadata || now.identity !== saved.token.identity || now.integrity !== saved.token.integrity
            || now.bodies !== saved.token.bodies || now.basis !== saved.token.basis)
            fail('AMIN_MIGRATION_STALE', '聊天、候选或迁移来源已变化，请重新预览。');
        return { modules: normalizeModules(saved.modules), source: saved.source, warnings: clone(saved.warnings), summary: saved.summary };
    }
    return { previewLegacy, previewImport, validatePreview };
}
