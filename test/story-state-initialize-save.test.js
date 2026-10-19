import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoryStateRuntime } from '../apps/story-state/runtime.js';
import { STATE_KEY, validateState } from '../apps/story-state/schema.js';
import { createStore, META } from '../apps/organizations/service.js';

// Mirrors a fresh TauriTavern/SillyTavern chat after Amin opened it: the organizations
// store has already materialized its own metadata root and history caches.
function fixture() {
  const ctx = { chatId: 'fresh-chat', characterId: 0, characters: [{ avatar: 'fresh.png' }], groupId: null,
    getCurrentChatId() { return this.chatId; },
    chat: [{ name: 'Hero', is_user: false, mes: 'Hello', swipe_id: 0, extra: {} }],
    extensionSettings: {}, saveSettingsDebounced() {},
    saves: 0, async saveMetadata() { this.saves++; },
    chatMetadata: { integrity: 'abc', note_prompt: '', note_interval: 1,
      amin_os_organizations_history_v1: { records: {} },
      [META]: { assessment: null, backups: [], locks: [] },
      world_status_hud_history_v1: { records: {} },
      amin_os_saves_v1: { version: 1, saves: [] } } };
  const runtime = createStoryStateRuntime(() => ctx);
  const organizations = createStore({ context: () => ctx, setVariable() { throw Error('unexpected legacy write'); },
    nativeState: () => ({ managed: false, ready: true }) });
  return { ctx, runtime, organizations, dispose() { organizations.dispose(); runtime.destroy(); } };
}

test('starting blank story data in a fresh chat saves without a stale completion', async () => {
  const f = fixture();
  try {
    f.organizations.locks();
    const status = await f.runtime.initializeEmpty();
    assert.equal(status.ready, true);
    assert.equal(validateState(f.ctx.chatMetadata[STATE_KEY]).revision, 0);
    assert.equal(f.ctx.saves, 1);
    assert.equal(Object.hasOwn(f.ctx.chatMetadata, META), false, 'the organizations reader must not re-materialize a removed legacy root');
    assert.deepEqual(f.organizations.locks(), []);
    assert.equal(Object.hasOwn(f.ctx.chatMetadata, META), false);
  } finally { f.dispose(); }
});

test('resetting existing independent story data saves without a stale completion', async () => {
  const f = fixture();
  try {
    await f.runtime.initializeEmpty();
    f.organizations.sync(); f.organizations.locks(); f.organizations.assessment();
    // A root left behind by an older build or another writer is removed by the reset itself.
    f.ctx.chatMetadata[META] = { assessment: null, backups: [], locks: [] };
    await f.runtime.reset();
    f.organizations.sync();
    await f.runtime.initializeEmpty();
    assert.equal(validateState(f.ctx.chatMetadata[STATE_KEY]).revision, 2);
    assert.equal(f.ctx.saves, 3);
    assert.equal(Object.hasOwn(f.ctx.chatMetadata, META), false);
  } finally { f.dispose(); }
});
