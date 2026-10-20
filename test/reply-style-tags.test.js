import test from 'node:test';
import assert from 'node:assert/strict';
import { styleTags, rememberStyles, usedStyleKeys, normalizeRecent, RECENT_LIMIT } from '../apps/reply/style-tags.js';
import { normalizeSettings } from '../apps/reply/generator.js';

const library = presets => ({ get: id => presets.find(preset => preset.id === id), list: () => presets });
const contents = library([{ id: 'normal', name: '正常模式' }, { id: 'nsfw', name: 'NSFW 模式' }, { id: 'violence', name: '暴力模式' }, { id: 'absurd', name: '无厘头模式' }]);
const styles = library([{ id: 'w1', name: '简洁明快' }]);

test('without history three default content styles are offered', () => {
    const tags = styleTags({ recent: [], contents, styles, settings: { contentMode: 'violence' } });
    assert.deepEqual(tags.map(tag => tag.label), ['正常模式', '暴力模式', '无厘头模式']);
    assert.deepEqual(tags.map(tag => tag.active), [false, true, false]);
    assert.ok(tags.every(tag => !tag.recent));
    const custom = styleTags({ recent: [], contents: library([{ id: 'x', name: '自定义' }]), styles });
    assert.deepEqual(custom.map(tag => tag.label), ['自定义'], 'falls back to whatever the library holds');
});

test('recently used content styles and writing presets come first and drop deleted ones', () => {
    let recent = rememberStyles([], usedStyleKeys({ contentMode: 'absurd', writingStyleMode: 'none' }));
    recent = rememberStyles(recent, usedStyleKeys({ contentMode: 'normal', writingStyleMode: 'custom', writingStyleId: 'w1' }));
    assert.deepEqual(recent, ['writing:w1', 'content:normal', 'content:absurd']);
    recent = rememberStyles([...recent, 'content:gone'], ['content:absurd']);
    const tags = styleTags({ recent, contents, styles, settings: { contentMode: 'absurd', writingStyleMode: 'custom', writingStyleId: 'w1' } });
    assert.deepEqual(tags.map(tag => [tag.kind, tag.label, tag.active]), [['content', '无厘头模式', true], ['writing', '简洁明快', true], ['content', '正常模式', false]]);
    const padded = styleTags({ recent: ['content:violence'], contents, styles, settings: {} });
    assert.deepEqual(padded.map(tag => [tag.label, tag.recent]), [['暴力模式', true], ['正常模式', false], ['无厘头模式', false]], 'defaults fill the row to three tags');
    assert.equal(rememberStyles(Array.from({ length: 10 }, (_, i) => 'content:c' + i), ['content:new']).length, RECENT_LIMIT);
});

test('recent styles are kept by normalized reply settings and ignore invalid values', () => {
    assert.deepEqual(normalizeRecent(['content:none', 'content:a', 'content:a', 'bad', 3, 'writing:b']), ['content:a', 'writing:b']);
    assert.deepEqual(normalizeSettings({ recentStyles: ['content:a'] }).recentStyles, ['content:a']);
    assert.deepEqual(normalizeSettings({}).recentStyles, []);
});
