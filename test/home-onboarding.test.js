import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowOnboarding, dismissOnboarding, runOnboardingAction, ONBOARDING_KEY } from '../apps/home/onboarding.js';
import { STATE_KEY } from '../apps/story-state/access.js';

const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), values }; };
const chat = (id, metadata = {}) => ({ getCurrentChatId: () => id, characterId: 0, characters: [{ avatar: 'guide.png' }], chat: [], chatMetadata: metadata });

test('the guide shows only for a loaded chat without Amin story state', () => {
    const store = storage();
    assert.equal(shouldShowOnboarding(chat('a'), store), true);
    assert.equal(shouldShowOnboarding(chat('a', { [STATE_KEY]: { version: 1 } }), store), false, 'a chat with story state needs no guide');
    assert.equal(shouldShowOnboarding({ ...chat(''), getCurrentChatId: () => '' }, store), false, 'no open chat');
    assert.equal(shouldShowOnboarding(undefined, store), false);
});

test('稍后 is remembered per chat and survives broken storage', () => {
    const store = storage();
    assert.equal(dismissOnboarding(chat('a'), store), true);
    assert.equal(shouldShowOnboarding(chat('a'), store), false);
    assert.equal(shouldShowOnboarding(chat('b'), store), true, 'another chat still shows the guide');
    assert.equal(shouldShowOnboarding({ ...chat('a'), characters: [{ avatar: 'other.png' }] }, store), true, 'the same chat id under another character is a different chat');
    store.setItem(ONBOARDING_KEY, '{broken');
    assert.equal(shouldShowOnboarding(chat('a'), store), true);
    const failing = { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); } };
    assert.equal(shouldShowOnboarding(chat('a'), failing), true);
    assert.equal(dismissOnboarding(chat('a'), failing), false);
});

test('choices go through story storage, the joint initializer and settings', async () => {
    const calls = [], ctx = chat('a');
    const runtime = { async initializeEmpty() { calls.push(['blank']); ctx.chatMetadata[STATE_KEY] = { version: 1 }; return { message: '已建立空白剧情资料。' }; } };
    const openApp = async (id, request) => { calls.push(['open', id, request]); };
    const openLinkage = async section => { calls.push(['linkage', section]); };
    assert.match(await runOnboardingAction('import', { runtime, openApp, openLinkage, getContext: () => ctx }), /预览导入/);
    assert.deepEqual(calls.splice(0), [['open', 'story', { focus: 'import' }]]);
    await runOnboardingAction('ai', { runtime, openApp, openLinkage, getContext: () => ctx });
    assert.deepEqual(calls.splice(0), [['blank'], ['linkage', 'joint']], 'AI setup starts blank data, then opens 联合初始化 in the linkage app');
    await runOnboardingAction('ai', { runtime, openApp, openLinkage, getContext: () => ctx });
    assert.deepEqual(calls.splice(0), [['linkage', 'joint']], 'existing story data is never replaced');
    await runOnboardingAction('blank', { runtime, openApp, openLinkage, getContext: () => ctx });
    assert.deepEqual(calls, []);
    await assert.rejects(runOnboardingAction('blank', { runtime: {}, openApp, getContext: () => chat('b') }), /剧情存储/);
    await assert.rejects(runOnboardingAction('other', { runtime, openApp }), /未知/);
});
