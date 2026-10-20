import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SUITES, SUITE_IDS, routeApp, suiteOf, isSuite } from '../apps/suites/registry.js';
import { views } from '../apps/views.js';
import { openApp, takeAppRequest, APP_LABELS } from '../apps/shared/open-app.js';
import { openSearchResult } from '../apps/home/navigate.js';
import { mount as mountSuite } from '../apps/suites/view.js';
import { defaultTiles, groupSuiteTiles, loadTiles, saveTiles, normalizeTiles, TILE_KEY, TILE_TARGETS } from '../tile-layout.js';
import { summarizeTiles } from '../tile-live.js';
import { startupGraph } from '../scripts/startup-graph.mjs';

const root = path.resolve(import.meta.dirname, '..');
const memory = (entries = []) => { const data = new Map(entries); return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) }; };

test('the four suites group the overlapping apps and every member opens on its suite tab', () => {
    assert.deepEqual(SUITES.map(s => [s.id, s.name, s.members.map(m => m.id)]), [
        ['archive', '存档与历史', ['saves', 'story', 'floors']],
        ['library', '资料库', ['information', 'organizations', 'worldbooks']],
        ['abilities', '能力与检定', ['effects', 'dice']],
        ['preferences', '设置', ['settings', 'ai']],
    ]);
    for (const suite of SUITES) {
        assert.deepEqual(routeApp(suite.id), { window: suite.id, tab: null }, 'a suite opens itself on its last tab');
        assert.ok(views[suite.id], suite.id + ' has a lazy suite view');
        for (const member of suite.members) {
            assert.deepEqual(routeApp(member.id), { window: suite.id, tab: member.id });
            assert.equal(suiteOf(member.id), suite);
            assert.ok(views[member.id], member.id + ' keeps its own view loader');
            assert.ok(APP_LABELS[member.id], member.id + ' has a label for error text');
        }
    }
    for (const id of ['characters', 'inventory', 'relationships', 'scene', 'journal', 'map', 'status', 'reply', 'tts', 'linkage']) {
        assert.deepEqual(routeApp(id), { window: id, tab: null }); assert.equal(suiteOf(id), null); assert.equal(isSuite(id), false);
    }
});

test('old app ids keep their requests; 设置 → 剧情存储 links reach 存档与历史', async () => {
    const opened = [], opener = id => { opened.push(id); return Promise.resolve(); };
    await openApp('dice', { focus: 'd20' }, { opener });
    assert.deepEqual(takeAppRequest('dice'), { focus: 'd20' }, 'the dice view still takes its own request inside the suite');
    await openApp('settings', { page: 'story', focus: 'import' }, { opener });
    assert.deepEqual(opened, ['dice', 'story']);
    assert.equal(takeAppRequest('settings'), undefined);
    assert.deepEqual({ ...takeAppRequest('story') }, { page: undefined, focus: 'import' });
    await openSearchResult({ app: 'information', request: { focus: 'entry-1' } }, { openApp: (id, request) => openApp(id, request, { opener }) });
    assert.equal(opened.at(-1), 'information'); assert.deepEqual(takeAppRequest('information'), { focus: 'entry-1' });
});

class FakeElement {
    constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.dataset = {}; this.attributes = {}; this.hidden = false; this.listeners = {}; this.id = ''; this.className = ''; this.textContent = ''; this.classList = { add: (...c) => { this.className = [this.className, ...c].filter(Boolean).join(' '); }, remove() {} }; }
    append(...nodes) { for (const node of nodes) { node.parentNode?.children.splice(node.parentNode.children.indexOf(node), 1); node.parentNode = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k] ?? null; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    click() { for (const fn of this.listeners.click ?? []) fn({}); }
    focus() {}
}
const fakeDocument = () => { const doc = { createElement: tag => new FakeElement(tag, doc) }; return doc; };

test('a suite window shows one member pane at a time and loads members only when shown', async () => {
    const doc = fakeDocument(), target = new FakeElement('section', doc), suite = SUITES[2];
    const members = suite.members.map(m => ({ ...m, pane: new FakeElement('section', doc) }));
    const loads = [], selections = [], routed = [];
    const view = mountSuite(target, { suite, members, openMember: async (id, section) => { loads.push([id, section]); }, openApp: id => { routed.push(id); }, onSelect: id => selections.push(id) });
    const [tabs, body] = target.children;
    assert.equal(tabs.attributes.role, 'tablist'); assert.deepEqual(tabs.children.map(t => t.textContent), ['能力面板', '骰子']);
    assert.deepEqual(body.children, members.map(m => m.pane), 'member panes move under the suite tabs');
    assert.deepEqual(loads, [], 'nothing loads before the window opens');
    await view.open({ tab: 'dice', section: 'coc' });
    assert.deepEqual(loads, [['dice', 'coc']]); assert.equal(members[1].pane.hidden, false); assert.equal(members[0].pane.hidden, true);
    assert.equal(tabs.children[1].attributes['aria-selected'], 'true'); assert.equal(selections.at(-1), 'dice');
    await view.open(); assert.deepEqual(loads.at(-1), ['dice', undefined], 'reopening keeps the last tab');
    tabs.children[0].click(); assert.deepEqual(routed, ['effects'], 'tab clicks go through the shell router');
    view.dispose(); assert.equal(members[0].pane.parentNode, null);
});

test('saved layouts replace grouped app tiles with one suite tile at the first position, largest size, keeping colours', () => {
    const tiles = [
        { id: 'map', target: 'map', label: '', size: 'wide', x: 0, y: 0 },
        { id: 'dice', target: 'dice', label: '我的骰子', size: 'small', x: 4, y: 0, backgroundColor: '#112233' },
        { id: 'effects', target: 'effects', label: '', size: 'wide', x: 0, y: 4, image: 'https://example.com/a.png' },
        { id: 'dice-copy', target: 'dice', label: '', size: 'medium', x: 0, y: 8, iconColor: '#abcdef' },
        { id: 'settings', target: 'settings', label: '', size: 'small', x: 5, y: 0 },
        { id: 'ai', target: 'ai', label: '', size: 'slimWide', x: 4, y: 2 },
        { id: 'saves', target: 'saves', label: '', size: 'medium', x: 2, y: 2 },
    ];
    const grouped = groupSuiteTiles(tiles);
    assert.deepEqual(grouped.map(t => t.target), ['map', 'abilities', 'preferences', 'archive']);
    const abilities = grouped.find(t => t.target === 'abilities');
    assert.deepEqual({ x: abilities.x, y: abilities.y, size: abilities.size }, { x: 0, y: 4, size: 'wide' }, 'largest size, at the first old cell (reading order) that fits it');
    assert.equal(abilities.backgroundColor, '#112233'); assert.equal(abilities.image, 'https://example.com/a.png'); assert.equal(abilities.iconColor, '#abcdef'); assert.equal(abilities.label, '');
    const preferences = grouped.find(t => t.target === 'preferences');
    assert.deepEqual({ x: preferences.x, y: preferences.y, size: preferences.size }, { x: 4, y: 2, size: 'slimWide' });
    const archive = grouped.find(t => t.target === 'archive');
    assert.deepEqual({ x: archive.x, y: archive.y, size: archive.size }, { x: 2, y: 2, size: 'medium' }, 'a single old tile keeps its own cell');
    const simple = groupSuiteTiles([{ id: 'a', target: 'worldbooks', size: 'small', x: 2, y: 1 }, { id: 'b', target: 'information', size: 'medium', x: 0, y: 3 }]);
    assert.deepEqual(simple.map(({ target, x, y, size }) => ({ target, x, y, size })), [{ target: 'library', x: 2, y: 1, size: 'medium' }], 'the first old tile in reading order gives the position');
    assert.deepEqual(groupSuiteTiles([{ id: 'map', target: 'map', size: 'wide' }]), [{ id: 'map', target: 'map', size: 'wide' }]);
    assert.ok(TILE_TARGETS.includes('dice') && TILE_TARGETS.includes('abilities'), 'tiles may still target one member');
});

test('a version 3 layout migrates once; later member tiles and removals are kept', () => {
    const storage = memory([[TILE_KEY, JSON.stringify({ version: 3, knownTargets: ['characters', 'inventory', 'relationships', 'saves', 'scene', 'journal', 'dice', 'map', 'status', 'organizations', 'reply', 'information', 'effects', 'worldbooks', 'tts', 'ai', 'settings', 'linkage'], grid: { columns: 6, scale: 100 }, tiles: [
        { id: 'information', target: 'information', label: '', size: 'wide', x: 0, y: 0, backgroundColor: '#204060' },
        { id: 'organizations', target: 'organizations', label: '', size: 'wide', x: 0, y: 2 },
        { id: 'worldbooks', target: 'worldbooks', label: '', size: 'medium', x: 4, y: 0 },
        { id: 'map', target: 'map', label: '', size: 'medium', x: 4, y: 2 },
        { id: 'tts', target: 'tts', label: '', size: 'small', x: 0, y: 4 },
    ] })]]);
    const loaded = loadTiles(storage), library = loaded.filter(t => t.target === 'library');
    assert.equal(library.length, 1); assert.deepEqual([library[0].x, library[0].y, library[0].size, library[0].backgroundColor], [0, 0, 'wide', '#204060']);
    assert.ok(!loaded.some(t => ['information', 'organizations', 'worldbooks', 'saves', 'dice', 'effects', 'settings', 'ai'].includes(t.target)));
    assert.equal(loaded.find(t => t.id === 'map').y, 2, 'unrelated tiles keep their cells');
    assert.equal(loaded.some(t => t.target === 'archive') && loaded.some(t => t.target === 'abilities'), false, 'suites whose apps the user had removed are not forced back');
    assert.equal(JSON.parse(storage.data.get(TILE_KEY)).version, 4);
    const withDice = [...loaded, { id: 'my-dice', target: 'dice', label: '骰子', size: 'small' }];
    saveTiles(storage, withDice); assert.ok(loadTiles(storage).some(t => t.target === 'dice'), 'a member tile added after migration stays');
    assert.deepEqual(loadTiles(storage), normalizeTiles(withDice));
});

test('the default home shows suite entries instead of their separate apps', () => {
    const targets = defaultTiles().map(t => t.target);
    assert.equal(targets.length, 14);
    for (const id of SUITE_IDS) assert.ok(targets.includes(id), id);
    for (const suite of SUITES) for (const member of suite.members) assert.ok(!targets.includes(member.id), member.id + ' is reached through ' + suite.name);
});

test('suite tiles carry a live summary where one fits', () => {
    const summary = summarizeTiles({ chat: true, effects: [{}, { paused: true }] });
    assert.deepEqual(summary.abilities, { lines: ['1 个效果生效中', '1 个已暂停'], short: '1' });
});

test('suite windows and suite-only pages load on first open, not at startup', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const { modules, views: lazy } = startupGraph(path.join(root, manifest.js));
    const rel = file => path.relative(root, file).split(path.sep).join('/');
    const startup = new Set([...modules].map(rel)), deferred = new Set([...lazy].map(rel));
    assert.ok(startup.has('apps/suites/registry.js'), 'routing data is available before any window opens');
    for (const file of ['apps/suites/view.js', 'apps/suites/story-storage.js', 'apps/suites/floor-history.js', 'settings/story-storage-view.js']) {
        assert.ok(!startup.has(file), file + ' must not load at startup');
    }
    for (const file of ['apps/suites/view.js', 'apps/suites/story-storage.js', 'apps/suites/floor-history.js']) assert.ok(deferred.has(file), file + ' is a lazy view');
});
