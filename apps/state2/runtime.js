import { isIndependent, prepareIndependentManualWrite } from '../story-state/access.js';
import { createStoryStateRuntime } from '../story-state/runtime.js';

// Compatibility facade: 0.18+ stores story data only in the independent
// snapshot. Chats without it must import or start blank before any write.
const context = () => globalThis.SillyTavern?.getContext?.();
const IMPORT_REQUIRED = '请先在剧情存储中导入旧资料或开始空白资料。';
let shared;
export function prepareState2ManualWrite(ctx, paths) {
    if (isIndependent(ctx)) return prepareIndependentManualWrite(ctx,paths);
    // Without the runtime (isolated app tests) a plain chat has nothing to mirror.
    if (shared) throw Error(IMPORT_REQUIRED);
    return () => {};
}
export function state2HistoryMode(ctx) {
    if (isIndependent(ctx)) return {managed:true,ready:true,currentOnly:true,historical:false,independent:true};
    return { managed: false, ready: true };
}
export function nativeState2Status(ctx = context()) {
    if (isIndependent(ctx)) return {available:true,migrated:true,message:'Amin 独立剧情资料已启用；不依赖小白变量。'};
    return { available: false, migrated: false, message: IMPORT_REQUIRED };
}
export function initializeState2(getContext = context, options = {}) { return shared ??= createStoryStateRuntime(getContext,options); }
export function getState2Runtime(){return shared;}
