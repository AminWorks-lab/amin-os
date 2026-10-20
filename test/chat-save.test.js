import test from 'node:test';
import assert from 'node:assert/strict';
import { markChatIdsDirty, saveChatMetadata, registerChatSavePreparation } from '../apps/shared/chat-save.js';

const fixture = () => {
  let chatSaves = 0, metadataSaves = 0;
  const ctx = {
    chatMetadata: {}, chat: [{ mes: '第一楼', extra: {} }],
    getCurrentChatId: () => 'chapter',
    saveChat: async () => { chatSaves++; },
    saveMetadata: async () => { metadataSaves++; },
  };
  return { ctx, chatSaves: () => chatSaves, metadataSaves: () => metadataSaves };
};

test('pending floor IDs use one full save, then ordinary metadata saves resume', async () => {
  const t = fixture(); markChatIdsDirty(t.ctx);
  assert.equal(await saveChatMetadata(t.ctx), 'chat');
  assert.equal(t.chatSaves(), 1); assert.equal(t.metadataSaves(), 0);
  assert.equal(await saveChatMetadata(t.ctx), 'metadata');
  assert.equal(t.chatSaves(), 1); assert.equal(t.metadataSaves(), 1);
});

test('a full save failure retains pending floor IDs for the next attempt', async () => {
  const t = fixture(); let calls = 0;
  t.ctx.saveChat = async () => { calls++; if (calls === 1) throw Error('disk busy'); };
  markChatIdsDirty(t.ctx);
  await assert.rejects(saveChatMetadata(t.ctx), /disk busy/);
  assert.equal(await saveChatMetadata(t.ctx), 'chat');
  assert.equal(calls, 2); assert.equal(t.metadataSaves(), 0);
});

test('an ID assigned during an in-flight full save remains pending', async () => {
  const t = fixture(); let finishFirst, calls = 0;
  t.ctx.saveChat = () => {
    calls++;
    return calls === 1 ? new Promise(resolve => { finishFirst = resolve; }) : Promise.resolve();
  };
  markChatIdsDirty(t.ctx);
  const first = saveChatMetadata(t.ctx);
  markChatIdsDirty(t.ctx);
  finishFirst(); await first;
  assert.equal(await saveChatMetadata(t.ctx), 'chat');
  assert.equal(calls, 2); assert.equal(t.metadataSaves(), 0);
});

test('the final check blocks a stale candidate after preparations without dispatching either save', async () => {
  for (const fullChat of [false, true]) {
    const t = fixture(), original = t.ctx.chat[0].mes;
    if (fullChat) markChatIdsDirty(t.ctx);
    const remove = registerChatSavePreparation(async ctx => {
      await Promise.resolve();
      return () => { ctx.chat[0].mes = '候选已变化'; };
    });
    try {
      await assert.rejects(saveChatMetadata(t.ctx, { finalCheck() {
        if (t.ctx.chat[0].mes !== original) throw Error('stale candidate');
      } }), /stale candidate/);
      assert.equal(t.chatSaves(), 0); assert.equal(t.metadataSaves(), 0);
    } finally { remove(); }
    assert.equal(await saveChatMetadata(t.ctx), fullChat ? 'chat' : 'metadata');
    assert.equal(t.chatSaves(), Number(fullChat));
    assert.equal(t.metadataSaves(), Number(!fullChat));
  }
});

test('the final check runs after all preparation checks with no await before host dispatch', async () => {
  for (const fullChat of [false, true]) {
    const t = fixture(), order = [];
    if (fullChat) markChatIdsDirty(t.ctx);
    const removeFirst = registerChatSavePreparation(async () => {
      order.push('prepare-first');
      return () => order.push('check-first');
    });
    const removeSecond = registerChatSavePreparation(async () => {
      order.push('prepare-second');
      return () => order.push('check-second');
    });
    const expected = ['prepare-first', 'prepare-second', 'check-first', 'check-second', 'final'];
    const save = async () => {
      assert.deepEqual(order, expected, 'host save must dispatch before a queued microtask');
      order.push('save');
    };
    t.ctx.saveChat = save; t.ctx.saveMetadata = save;
    try {
      assert.equal(await saveChatMetadata(t.ctx, { finalCheck() {
        order.push('final');
        assert.deepEqual(order, expected);
        queueMicrotask(() => order.push('microtask'));
      } }), fullChat ? 'chat' : 'metadata');
      assert.deepEqual(order, [...expected, 'save', 'microtask']);
    } finally { removeSecond(); removeFirst(); }
  }
});
