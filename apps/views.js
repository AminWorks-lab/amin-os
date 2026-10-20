import { lazyView } from './lazy-view.js';
// One loader per app window view, shared by the Amin OS pane and the message-floor windows.
// The map's window loads from apps/map/index.js; the world-status HUD stays with its background.
export const views = {
    characters: lazyView(retry => import(/* view */ './characters/view.js' + retry), '人物卡'),
    inventory: lazyView(retry => import(/* view */ './inventory/view.js' + retry), '背包与账本'),
    relationships: lazyView(retry => import(/* view */ './relationships/view.js' + retry), '人物关系'),
    saves: lazyView(retry => import(/* view */ './saves/view.js' + retry), '跨应用存档'),
    scene: lazyView(retry => import(/* view */ './scene/view.js' + retry), '场景与时间'),
    journal: lazyView(retry => import(/* view */ './journal/view.js' + retry), '剧情档案'),
    dice: lazyView(retry => import(/* view */ './dice/view.js' + retry), '骰子'),
    tts: lazyView(retry => import(/* view */ './tts/view.js' + retry), '语音朗读'),
    worldbooks: lazyView(retry => import(/* view */ './worldbooks/view.js' + retry), '世界书管理'),
    information: lazyView(retry => import(/* view */ './information/view.js' + retry), '信息面板'),
    effects: lazyView(retry => import(/* view */ './effects/view.js' + retry), '能力面板'),
    organizations: lazyView(retry => import(/* view */ './organizations/view.js' + retry), '势力概览'),
    linkage: lazyView(retry => import(/* view */ './linkage/view.js' + retry), '联动更新'),
    reply: lazyView(retry => import(/* view */ './reply/workspace.js' + retry), '回复选项'),
    settings: lazyView(retry => import(/* view */ '../settings/view.js' + retry), '设置'),
    ai: lazyView(retry => import(/* view */ '../ai/view.js' + retry), 'AI 设置'),
    // Pages that appear only as tabs of a suite (存档与历史).
    story: lazyView(retry => import(/* view */ './suites/story-storage.js' + retry), '剧情存储'),
    floors: lazyView(retry => import(/* view */ './suites/floor-history.js' + retry), '楼层记录'),
    // Suite windows: one row of tabs over the member views above (see apps/suites/registry.js).
    archive: lazyView(retry => import(/* view */ './suites/view.js' + retry), '存档与历史'),
    library: lazyView(retry => import(/* view */ './suites/view.js' + retry), '资料库'),
    abilities: lazyView(retry => import(/* view */ './suites/view.js' + retry), '能力与检定'),
    preferences: lazyView(retry => import(/* view */ './suites/view.js' + retry), '设置'),
};
