import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const participants = [], callbacks = [], mode = process.argv[2];
let release, frozen = false, done = false;
const gate = new Promise(resolve => { release = resolve; });
const register = name => {
    assert.equal(frozen, false, 'participant registered after first projection');
    assert.ok(!participants.includes(name), 'participant registered twice');
    participants.push(name);
};
const shell = { panes: {}, register() {}, setBlocked() {}, refreshActive() {} };
const ctx = { extensionSettings: {}, saveSettingsDebounced() {}, eventSource: { on() {} }, eventTypes: {} };
const sandbox = vm.createContext({
    console, localStorage: {}, queueMicrotask,
    SillyTavern: { getContext: () => ctx },
    document: { readyState: 'loading', querySelector: () => null, getElementById: () => null, addEventListener: (_name, fn) => callbacks.push(fn) },
});
const stubs = {
    './apps/shared/chat-lifecycle.js': { initializeChatLifecycle() {} },
    './apps/state2/runtime.js': { initializeState2: () => ({}) },
    './uuid.js': { uuid: () => 'fixture' },
    './retired-data.js': { cleanupRetiredData: () => ({ errors: [] }) },
    './apps/extra-floor-ui.js': { installExtraFloorButtons: register },
    './apps/reply/floor-ui.js': { installReplyFloorButtons: () => register('reply-floor') },
    './apps/linkage/floor-turns.js': { installTurnSummaries: () => register('linkage-turns') },
    './settings/appearance.js': { initializeAppearance() {}, installAppearance() {}, getAppearance() {} },
    './ui/tabs.js': { installTabScroll() {} },
    './ai/service.js': { initializeAI() {} },
    './shell.js': { createShell: () => shell },
    './apps/views.js': { views: {} },
    './apps/linkage/service.js': { getSharedService: () => ({ reportHost() {} }) },
    './apps/linkage/host.js': { createLinkageHost: () => ({ status: () => ({}) }) },
    './apps/linkage/prompt.js': { buildUpdateRules() {}, buildDataPrompt() {} },
    './apps/linkage/open.js': { setLinkageOpener() {} },
    './tile-live-feed.js': { createLiveTileFeed: () => ({}) },
};
function synthetic(exports) {
    return new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context: sandbox });
}
const source = fs.readFileSync(new URL('../../index.js', import.meta.url), 'utf8');
const entry = new vm.SourceTextModule(source, {
    context: sandbox,
    importModuleDynamically: async specifier => {
        const isFloorApp = /apps\/(map|status)\/index\.js$/.test(specifier);
        if (isFloorApp) await gate;
        if (mode === 'failure' && specifier.includes('/status/')) throw Error('status registration failed');
        const result = synthetic({ mount: () => ({}), initialize: () => { if (isFloorApp) register(specifier); return {}; } });
        await result.link(() => {}); await result.evaluate(); return result;
    },
});
await entry.link(specifier => {
    assert.ok(stubs[specifier], `Unexpected static dependency ${specifier}`);
    return synthetic(stubs[specifier]);
});
await entry.evaluate();
const pending = entry.namespace.registerChatSurface().then(() => { done = true; });
await Promise.resolve(); await Promise.resolve();
assert.equal(done, false, 'host hook returned before async floor registration');
release();
if (mode === 'failure') {
    await assert.rejects(pending, /status registration failed/);
} else {
    await pending;
    assert.ok(participants.includes('./apps/status/index.js'));
    assert.ok(participants.includes('./apps/map/index.js'));
    assert.equal(participants.length, 16);
    frozen = true;
    await entry.namespace.registerChatSurface();
    for (const callback of callbacks) callback();
    assert.equal(participants.length, 16);
}
