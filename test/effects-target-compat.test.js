import test from 'node:test';
import assert from 'node:assert/strict';
import { empty, anchor, activeEffects, validateEffectsSnapshot, snapshotEffects, restoreEffects, change, compile, effectTarget, readStore, KEY } from '../apps/effects/model.js';
import { createEffects } from '../apps/effects/service.js';
import { normalizeModules } from '../apps/story-state/schema.js';

const chat = [{ name: 'User', is_user: true, mes: 'activate ability', swipe_id: 0 }];
const skill = { id: 'skill', name: 'Ability', original: 'Original ability rules', reminder: 'Follow confirmed scope', book: 'custom', entryId: '1' };
const effect = (extra = {}) => ({ id: 'old-effect', skill: structuredClone(skill), holder: 'Caster', targetMode: 'direct', target: 'Confirmed target',
  scope: 'vision', command: 'Keep instruction', condition: 'Until release', ...extra });
const snapshot = (extra = {}) => ({ version: 1, enabled: true, limit: 30000, effects: [effect(extra)], consumedActionIds: [] });
const legacyStore = (extra = {}) => ({ ...empty(), skills: [structuredClone(skill)], events: [{ op: 'create', anchor: anchor(chat), effect: effect(extra) }] });

test('legacy direct snapshot with an explicit target returns normalized targeted data without mutating input', () => {
  const input = snapshot({ target: ' Confirmed target ' }), before = structuredClone(input);
  const normalized = validateEffectsSnapshot(input);
  assert.equal(normalized.effects[0].targetMode, 'targeted');
  assert.equal(normalized.effects[0].target, ' Confirmed target ');
  assert.deepEqual(normalized.effects[0], { ...before.effects[0], targetMode: 'targeted' });
  assert.deepEqual(input, before);
  assert.deepEqual(validateEffectsSnapshot(normalized), normalized);
});

test('old create and restore events use the normalized target for reads, snapshots, collision checks and prompts', () => {
  for (const store of [legacyStore(), { ...empty(), skills: [structuredClone(skill)], events: [{ op: 'restore', anchor: anchor(chat), snapshot: snapshot() }] }]) {
    const before = structuredClone(store), current = activeEffects(store, chat);
    assert.equal(current[0].targetMode, 'targeted'); assert.equal(effectTarget(current[0]), 'Confirmed target');
    assert.equal(snapshotEffects(store, chat).effects[0].targetMode, 'targeted');
    assert.match(compile(store, chat), /"targetMode":"targeted"/);
    assert.match(compile(store, chat), /Confirmed target/);
    assert.throws(() => change(store, chat, 'create', { skillId: 'skill', holder: 'Caster', targetMode: 'targeted', target: 'Confirmed target', scope: 'vision', condition: 'Until release' }), /已有记录/);
    assert.deepEqual(store, before);
  }
});

test('restoration preserves old explicit target and full fields in the actual restored event', () => {
  const input = snapshot(), restored = restoreEffects(empty(), chat, input, { operationId: 'compat-restore' });
  assert.equal(restored.events[0].snapshot.effects[0].targetMode, 'targeted');
  assert.deepEqual(activeEffects(restored, chat)[0], { ...input.effects[0], targetMode: 'targeted' });
  assert.equal(input.effects[0].targetMode, 'direct');
});

test('independent state validation and its effect codec both consume normalized target data', () => {
  const raw = snapshot(), before = structuredClone(raw);
  const modules = normalizeModules({ effects: raw });
  assert.equal(modules.effects.effects[0].targetMode, 'targeted');
  const ctx = { chat, chatMetadata: { amin_os_state_v1: { version: 1, modules: { effects: raw } } }, extensionSettings: {} };
  const store = readStore(ctx);
  assert.equal(store.events[0].snapshot.effects[0].targetMode, 'targeted');
  assert.equal(activeEffects(store, chat)[0].target, 'Confirmed target');
  assert.deepEqual(raw, before);
  const invalid = snapshot(); invalid.effects.push(structuredClone(invalid.effects[0]));
  assert.throws(() => normalizeModules({ effects: invalid }), /编号无效或重复/);
});

test('direct no-target activation still ignores hidden stale text; targeted activation still requires a target', () => {
  const initial = { ...empty(), skills: [skill] }, data = { skillId: 'skill', holder: 'Caster', scope: 'vision', condition: 'Until release' };
  const direct = change(initial, chat, 'create', { ...data, targetMode: 'direct', target: 'Hidden stale target' });
  assert.equal(activeEffects(direct, chat)[0].targetMode, 'direct');
  assert.equal(activeEffects(direct, chat)[0].target, '');
  assert.equal(validateEffectsSnapshot(snapshot({ target: '' })).effects[0].targetMode, 'direct');
  assert.equal(validateEffectsSnapshot(snapshot({ target: '  ' })).effects[0].target, '');
  assert.throws(() => change(initial, chat, 'create', { ...data, targetMode: 'targeted', target: '' }), /目标/);
});

test('target compatibility does not relax duplicate IDs, mode, field or periodic snapshot validation', () => {
  const duplicate = snapshot(); duplicate.effects.push(structuredClone(duplicate.effects[0]));
  assert.throws(() => validateEffectsSnapshot(duplicate), /编号无效或重复/);
  assert.throws(() => validateEffectsSnapshot(snapshot({ targetMode: 'unknown' })), /发动方式无效/);
  assert.throws(() => validateEffectsSnapshot(snapshot({ target: null })), /字段无效/);
  assert.throws(() => validateEffectsSnapshot(snapshot({ periodic: { version: 1, intervalMinutes: 0, operations: [] } })), /周期|结算间隔/);
});

for (const targetMode of ['targeted', 'direct']) test(`actual non-check ${targetMode} activation can save beside an old inconsistent direct record`, async () => {
  const ctx = { chatId: 'compat-chat', getCurrentChatId() { return this.chatId; }, characterId: 0,
    chat: structuredClone(chat), chatMetadata: { [KEY]: legacyStore(), variables: {} }, extensionSettings: {},
    saveMetadata: async () => {}, saveSettingsDebounced: async () => {} };
  const api = createEffects(() => ctx);
  try {
    const token = api.capture();
    await api.mutate(token, 'create', { skillId: 'skill', holder: 'Caster', targetMode, target: 'Other target', scope: 'vision', condition: 'Until release' });
    const current = activeEffects(api.read(), ctx.chat);
    assert.equal(current.length, 2);
    assert.deepEqual(current.map(item => item.target), ['Confirmed target', targetMode === 'direct' ? '' : 'Other target']);
    assert.deepEqual(current.map(item => item.targetMode), ['targeted', targetMode]);
    assert.equal(ctx.chatMetadata[KEY].events[0].effect.targetMode, 'direct', 'reads do not overwrite the original event');
  } finally { api.dispose(); }
});
