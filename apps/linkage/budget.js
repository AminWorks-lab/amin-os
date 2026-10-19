// The host trims chat history first when a prompt exceeds its context budget, and
// in-chat extension prompts can be dropped with it. Warn before Amin's own prompts
// silently push the conversation out of the request.
export const BUDGET_WARN_RATIO = 0.5;

const CJK = /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/gu;

// Rough tokenizer-neutral estimate: CJK and full-width characters cost about one
// token each in common tokenizers; other text averages several characters per token.
export function estimateTokens(text) {
    if (typeof text !== 'string' || !text) return 0;
    const wide = text.match(CJK)?.length ?? 0;
    return Math.ceil(wide * 0.85 + (text.length - wide) / 2.8);
}

const positive = value => { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : 0; };

// Tokens the host can spend on the prompt itself (context minus reserved reply).
export function promptBudget(ctx) {
    const chat = ctx?.mainApi === 'openai' ? ctx.chatCompletionSettings : null;
    const max = chat ? positive(chat.openai_max_context) : positive(ctx?.maxContext);
    if (!max) return null;
    const reply = chat ? positive(chat.openai_max_tokens) : positive(ctx?.amountGen);
    return Math.max(0, max - reply);
}

export function checkPromptBudget(ctx, texts = []) {
    const tokens = texts.reduce((sum, text) => sum + estimateTokens(text), 0);
    const available = promptBudget(ctx);
    if (available == null || !tokens) return { tokens, available, ratio: null, level: 'unknown' };
    const ratio = available ? tokens / available : Infinity;
    return { tokens, available, ratio, level: ratio >= 1 ? 'over' : ratio >= BUDGET_WARN_RATIO ? 'warn' : 'ok' };
}

export function budgetMessage({ tokens, available, ratio, level } = {}) {
    if (level !== 'warn' && level !== 'over') return '';
    const share = Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : '全部';
    const head = `Amin 联动资料与更新规则约 ${tokens} token，占本轮可用上下文（约 ${available} token）的 ${share}`;
    return level === 'over'
        ? `${head}，已超出上限：酒馆会裁掉聊天记录，Amin 资料也可能被一起丢弃。请提高上下文上限，或在「世界状态 → 联动更新」关闭不需要更新的模块。`
        : `${head}：酒馆可能裁掉较早的聊天记录。建议提高上下文上限，或在「世界状态 → 联动更新」关闭不需要更新的模块。`;
}
