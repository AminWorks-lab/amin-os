import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoryStateRuntime, LEGACY_STORY_KEYS } from '../apps/story-state/runtime.js';
import { STATE_KEY, STATE_FORMAT, emptyState, validateState } from '../apps/story-state/schema.js';
import { createIndependentBackups } from '../apps/story-state/backups.js';
import { createOperationService } from '../apps/shared/operations.js';
import { ROOTS } from '../apps/story-state/legacy-roots.js';
import * as Characters from '../apps/characters/model.js';
import * as Effects from '../apps/effects/model.js';
import { LIBRARY_KEY, emptyLibrary } from '../apps/effects/library.js';

const copy = value => structuredClone(value);
const person = notes => ({ id: 'hero', name: 'Hero', kind: 'pc', notes, stats: [] });
const characterState = notes => ({ version: 1, characters: [person(notes)] });
function fixture({ independent = false, files } = {}) {
  const calls = { saves: [], puts: 0 };
  let failSave = false;
  const ctx = {
    chatId: 'management-test', characterId: 0, characters: [{ avatar: 'management.png' }],
    getCurrentChatId() { return this.chatId; },
    chat: [{ mes: 'Original <state>old native text</state>', is_user: false,
      swipes: ['Original <state>old native text</state>', 'Other unchanged response'], swipe_id: 0,
      extra: { unrelated: 'preserve' } }],
    extensionSettings: { [LIBRARY_KEY]: emptyLibrary(), unrelated: { unchanged: true } },
    chatMetadata: {
      variables: { Foreign: { nested: ['unchanged'] }, 状态栏: JSON.stringify({ 版本: 1, 项目: {} }),
        [ROOTS.characters]: JSON.stringify(characterState('native source')) },
      LWB_RULES_V2: { Foreign: { ro: true }, [ROOTS.characters]: { ro: false } },
      extensions: { LittleWhiteBox: { __logs: { 0: { sentinel: 'original WAL' } }, __ckpt: { 0: { sentinel: 'original checkpoint' } } } },
      world_info: 'keep worldbook', otherPlugin: { arbitrary: 'preserve' },
    },
    async saveMetadata() {
      calls.saves.push(copy(this.chatMetadata));
      if (failSave) throw Error('host disk offline');
    },
  };
  if (independent) {
    const state = emptyState({ updatedAt: '2026-10-10T00:00:00.000Z' });
    state.modules.characters = characterState('initial');
    ctx.chatMetadata[STATE_KEY] = validateState(state);
  } else {
    ctx.chatMetadata[Characters.KEY] = Characters.buildRestore(ctx, characterState('app source'), {
      id: 'old_import', at: '2026-10-10T00:00:00.000Z', reason: 'Original application record',
    });
    ctx.chatMetadata[Effects.KEY] = { ...Effects.empty(), skills: [
      { id: 'local-skill', name: 'Local shield', book: 'Old rules', entryId: '1', original: 'Original ability prose', reminder: 'Keep the shield' },
    ] };
  }
  const protectedData = copy({ chat: ctx.chat, variables: ctx.chatMetadata.variables,
    rules: ctx.chatMetadata.LWB_RULES_V2, extensions: ctx.chatMetadata.extensions,
    settings: ctx.extensionSettings, worldbook: ctx.chatMetadata.world_info, otherPlugin: ctx.chatMetadata.otherPlugin });
  const backups = createIndependentBackups(() => ctx, files ? { files } : { getHostWindow: () => undefined });
  const runtime = createStoryStateRuntime(() => ctx, { backups });
  return { ctx, runtime, calls, backups, set failSave(value) { failSave = value; },
    assertProtected() {
      assert.deepEqual({ chat: ctx.chat, variables: ctx.chatMetadata.variables,
        rules: ctx.chatMetadata.LWB_RULES_V2, extensions: ctx.chatMetadata.extensions,
        settings: ctx.extensionSettings, worldbook: ctx.chatMetadata.world_info, otherPlugin: ctx.chatMetadata.otherPlugin }, protectedData);
      assert.equal(globalThis.LWB_StateV2, undefined);
      assert.equal(ctx.extensionSettings.LittleWhiteBox, undefined);
    }, dispose() { runtime.destroy(); },
  };
}
function memoryFiles() {
  const records = new Map(); let writes = 0;
  return { records, get writes() { return writes; }, available: () => true,
    async get(key) { return copy(records.get(key) ?? null); },
    async put(key, value, { expected }) {
      assert.deepEqual(records.get(key) ?? null, expected, 'backup writes require the exact old record');
      records.set(key, copy(value)); writes++;
    },
  };
}
async function changeNotes(f, notes) {
  const exported = f.runtime.exportState();
  exported.state.modules.characters.characters[0].notes = notes;
  const preview = f.runtime.previewImport(exported);
  assert.equal(preview.valid, true, JSON.stringify(preview.errors));
  return f.runtime.applyPreview(preview.plan);
}

for (const source of ['app', 'native']) {
  test(`${source} preview applies and host-saves canonical state while archiving inactive old roots once`, async () => {
    const f = fixture();
    try {
      const original = copy(f.ctx.chatMetadata);
      const sourceRoots = Object.fromEntries(LEGACY_STORY_KEYS.filter(key => Object.hasOwn(original, key)).map(key => [key, copy(original[key])]));
      const preview = f.runtime.previewLegacy(source);
      assert.equal(preview.valid, true, JSON.stringify(preview.errors));
      assert.deepEqual(f.ctx.chatMetadata, original, 'preview is read-only');
      assert.equal(f.calls.saves.length, 0);
      assert.equal(f.runtime.ready(), false);
      await f.runtime.applyPreview(preview.plan);
      assert.equal(f.runtime.ready(), true);
      assert.equal(f.ctx.chatMetadata[STATE_KEY].modules.characters.characters[0].notes, `${source} source`);
      assert.equal(Characters.readCharacters(f.ctx).characters[0].notes, `${source} source`);
      assert.equal(f.calls.saves.length, 1);
      assert.deepEqual(f.calls.saves[0][STATE_KEY], f.ctx.chatMetadata[STATE_KEY]);
      for (const key of LEGACY_STORY_KEYS) assert.equal(Object.hasOwn(f.calls.saves[0], key), false, `${key} must no longer be an active root`);
      assert.deepEqual(f.ctx.chatMetadata.amin_os_legacy_source_v1, sourceRoots);
      assert.deepEqual(f.runtime.exportLegacySource(), { format: 'amin-os-legacy-source', version: 1, sources: sourceRoots });
      assert.deepEqual(f.ctx.chatMetadata.amin_os_imported_skills_v1, original[Effects.KEY].skills);
      assert.ok(Effects.readStore(f.ctx).skills.some(skill => skill.id === 'local-skill' && skill.original === 'Original ability prose'));
      assert.equal(Object.hasOwn(f.ctx.chatMetadata[STATE_KEY].modules.effects ?? {}, 'skills'), false, 'ability definitions remain configuration, not a story snapshot');
      const archived = copy(f.ctx.chatMetadata.amin_os_legacy_source_v1);
      await changeNotes(f, 'canonical update');
      assert.deepEqual(f.ctx.chatMetadata.amin_os_legacy_source_v1, archived, 'later writes never append or replace the static raw archive');
      assert.equal(Characters.readCharacters(f.ctx).characters[0].notes, 'canonical update', 'old archived app/native values are inactive');
      assert.equal(Object.keys(f.ctx.chatMetadata).filter(key => key === 'amin_os_legacy_source_v1').length, 1);
      assert.equal(f.calls.saves.length, 2);
      f.assertProtected();
    } finally { f.dispose(); }
  });
}

test('failed first import save retries the same canonical state and exact static legacy archive', async () => {
  const f = fixture();
  try {
    const preview = f.runtime.previewLegacy('app');
    assert.equal(preview.valid, true);
    f.failSave = true;
    await assert.rejects(f.runtime.applyPreview(preview.plan), /offline/);
    const committed = copy(f.ctx.chatMetadata);
    assert.equal(committed[STATE_KEY].revision, 0);
    assert.equal(Characters.readCharacters(f.ctx).characters[0].notes, 'app source');
    f.failSave = false; await f.runtime.retrySave();
    assert.deepEqual(f.ctx.chatMetadata, committed, 'retry persists the already applied import without re-conversion');
    assert.deepEqual(f.calls.saves[1], f.calls.saves[0]);
    assert.equal(f.calls.saves.length, 2);
    f.assertProtected();
  } finally { f.dispose(); }
});

test('runtime keeps previous snapshots in one ring bounded by the default limit and save retry adds none', async () => {
  const files = memoryFiles(), f = fixture({ independent: true, files });
  try {
    for (let revision = 1; revision <= 12; revision++) await changeNotes(f, `revision ${revision}`);
    assert.equal(f.ctx.chatMetadata[STATE_KEY].revision, 12);
    const recent = await f.runtime.listBackups();
    assert.deepEqual(recent.map(entry => entry.revision), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    assert.ok(recent.every(entry => entry.kind === 'before-change'));
    assert.equal(files.records.size, 1);
    assert.equal(files.writes, 12);
    assert.equal(new Set(recent.map(entry => entry.id)).size, 10);
    assert.equal(f.runtime.status().backupLimit, 10);
    const backupPreview = await f.runtime.previewBackup(recent[0].id);
    assert.equal(backupPreview.valid, true);
    assert.equal(f.ctx.chatMetadata[STATE_KEY].revision, 12, 'backup preview does not restore live state');
    f.failSave = true; await assert.rejects(changeNotes(f, 'revision 13'), /offline/);
    const committed = copy(f.ctx.chatMetadata), records = copy([...files.records]), writes = files.writes;
    assert.equal(committed[STATE_KEY].revision, 13);
    assert.deepEqual((await f.runtime.listBackups()).map(entry => entry.revision), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    f.failSave = false; await f.runtime.retrySave();
    assert.deepEqual(f.ctx.chatMetadata, committed);
    assert.deepEqual([...files.records], records);
    assert.equal(files.writes, writes, 'host save retry must not create or rotate another previous snapshot');
    assert.equal(f.calls.saves.length, 14);
    f.assertProtected();
  } finally { f.dispose(); }
});

test('ordinary invalid staged replacement preserves the complete old canonical state', () => {
  const f = fixture({ independent: true }), operation = createOperationService(() => f.ctx);
  try {
    const old = copy(f.ctx.chatMetadata), bad = copy(old[STATE_KEY]);
    bad.modules.characters.characters.push(person('duplicate'));
    bad.modules.status = { 版本: 1, 项目: { unrelated: { value: 4 } } };
    assert.throws(() => operation.stage({ label: 'Invalid replacement', patches: [{ path: [STATE_KEY], value: bad }] }), /人物编号重复/);
    assert.deepEqual(f.ctx.chatMetadata, old);
    assert.equal(f.calls.saves.length, 0);
    f.assertProtected();
  } finally { operation.dispose(); f.dispose(); }
});

test('explicit reset can replace duplicate corrupted canonical state while ordinary replacement still refuses it', async () => {
  const f = fixture({ independent: true }), operation = createOperationService(() => f.ctx);
  try {
    const valid = copy(f.ctx.chatMetadata[STATE_KEY]);
    f.ctx.chatMetadata[STATE_KEY].modules.characters.characters.push(person('corrupt duplicate'));
    const damaged = copy(f.ctx.chatMetadata);
    assert.equal(f.runtime.ready(), false);
    assert.match(f.runtime.status().restoreError, /人物编号重复/);
    assert.throws(() => operation.stage({ label: 'Ordinary update cannot bypass corruption', patches: [{ path: [STATE_KEY], value: valid }] }), /人物编号重复/);
    assert.deepEqual(f.ctx.chatMetadata, damaged);
    await f.runtime.reset();
    assert.equal(f.runtime.ready(), true);
    assert.deepEqual(f.ctx.chatMetadata[STATE_KEY].modules, emptyState().modules);
    assert.deepEqual(f.runtime.exportState(), { format: STATE_FORMAT, version: 1, state: f.ctx.chatMetadata[STATE_KEY] });
    assert.equal(f.calls.saves.length, 1);
    assert.deepEqual(f.calls.saves[0][STATE_KEY], f.ctx.chatMetadata[STATE_KEY]);
    f.assertProtected();
  } finally { operation.dispose(); f.dispose(); }
});
