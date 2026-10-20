import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startupGraph } from '../scripts/startup-graph.mjs';
import { lazyView } from '../apps/lazy-view.js';

const root = path.resolve(import.meta.dirname, '..');
const rel = file => path.relative(root, file).split(path.sep).join('/');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const { modules, views } = startupGraph(path.join(root, manifest.js));
const startup = new Set([...modules].map(rel)), lazy = new Set([...views].map(rel));
const APP_VIEWS = ['characters', 'inventory', 'relationships', 'saves', 'scene', 'journal', 'dice', 'tts', 'worldbooks', 'information', 'effects', 'organizations']
    .map(id => `apps/${id}/view.js`).concat('settings/view.js', 'ai/view.js', 'apps/reply/workspace.js', 'apps/map/src/ui/panel.js');
// The world-status HUD mounts these two shared panels synchronously, so they stay with the status background.
const STATUS_SUBVIEWS = new Set(['apps/generation/view.js', 'apps/linkage/view.js']);

test('startup import graph leaves every app window view to load on first open', () => {
    for (const file of APP_VIEWS) {
        assert.ok(fs.existsSync(path.join(root, file)), file + ' exists');
        assert.ok(!startup.has(file), file + ' must not load at startup');
        assert.ok(lazy.has(file), file + ' is reachable as a lazy view');
    }
    const eagerViews = [...startup].filter(file => /(?:^|\/)view\.js$/.test(file) && !STATUS_SUBVIEWS.has(file));
    assert.deepEqual(eagerViews, [], 'no other view.js joins the startup graph');
});

test('background services that listen, inject prompts or register floors stay in the startup graph', () => {
    for (const file of ['apps/characters/service.js', 'apps/inventory/service.js', 'apps/relationships/service.js', 'apps/saves/service.js', 'apps/scene/service.js',
        'apps/journal/service.js', 'apps/dice/service.js', 'apps/worldbooks/runtime.js', 'apps/information/service.js', 'apps/effects/service.js',
        'apps/organizations/service.js', 'apps/map/index.js', 'apps/map/travel.js', 'apps/status/index.js', 'apps/extra-floor-ui.js', 'apps/reply/floor-ui.js'])
        assert.ok(startup.has(file), file + ' starts with the extension');
});

test('a lazy view caches its module, and a failed load reports in Chinese and retries under a fresh URL', async () => {
    const queries = []; let fail = true;
    const load = lazyView(async retry => { queries.push(retry); if (fail) throw TypeError('Failed to fetch dynamically imported module'); return { ok: true }; }, '骰子');
    await assert.rejects(load(), error => /骰子界面加载失败/.test(error.message) && error.cause instanceof TypeError);
    fail = false;
    assert.deepEqual(await load(), { ok: true });
    assert.equal(await load(), await load());
    assert.deepEqual(queries, ['', '?retry=1'], 'browsers cache a failed module fetch, so the retry changes the URL');
});
