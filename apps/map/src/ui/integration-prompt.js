import { isIndependent } from '../../../story-state/access.js';
import { buildDataPrompt, buildUpdateRules } from '../../../linkage/prompt.js';
import { mayRead, mayWrite, readLinkageSettings } from '../../../linkage/policy.js';

export const LEGACY_MAP_INTEGRATION_PROMPT = '当前地图摘要（只读，不修改“地图”变量）：\n{{xbgetvar_yaml::地图}}\n只有剧情明确发生移动时，才在 <state> 中完整写入：\n地图移动请求: {"请求ID":"本次唯一编号","地图版本":摘要中的地图版本数字,"地图ID":"目标地图ID","地点ID":"目标地点ID"}\n</state>\n不得虚构 ID；未开启位置更新时请求不执行。位置更新仅记录叙事位置，不自动寻路或推进时间。';

/** Preview the same permission-filtered context and protocol injected by linkage. */
export function mapIntegrationPrompt(ctx) {
    if (!isIndependent(ctx)) return LEGACY_MAP_INTEGRATION_PROMPT;
    const explanation = '地图资料与更新规则由 Amin OS 直接附加到生成请求，无需复制到世界书。联动权限在首页“联动更新”应用中调整。';
    try {
        const settings = readLinkageSettings(ctx);
        if (!settings.enabled) return explanation + '\n\n当前统一联动未启用，不发送地图资料或地图更新规则。';
        if (!mayRead(ctx, 'map', settings)) return explanation + '\n\n当前地图未加入可读取的联动范围，不发送地图资料或授权地图更新。';
        const permissions = mayWrite(ctx, 'map', settings)
            ? '当前允许模型读取与更新地图。只记录正文中已发生的移动，不自动寻路或推进时间。'
            : '当前地图仅供读取，未授权模型更新地图。';
        const source = settings.dataSource === 'external'
            ? '当前资料由预设／世界书提供，Amin 不发送地图资料；更新权限仍按当前联动设置执行。'
            : '';
        return [explanation, permissions, source, buildDataPrompt(ctx), buildUpdateRules(ctx)].filter(Boolean).join('\n\n');
    } catch (error) {
        return explanation + '\n\n联动预览暂不可用：' + error.message;
    }
}
