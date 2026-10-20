import { getAI } from './service.js';

export const retryNote = error => `上次输出无法解析：${error?.message ?? String(error)}，请只输出合法 JSON。`;

/**
 * Runs one structured AI task on the shared layer:
 * capture → generate → cancellation/guard check → empty check → parse.
 * When `parse` throws and `retryOnParseError` is set, the request is sent once more
 * with a note naming the parse error appended to the task request.
 *
 * `app` is the task name shown in AI settings (for example '信息面板 · 模拟推演');
 * `channel` is the app whose route is captured (defaults to `app`). A caller that
 * must freeze the route earlier passes its own `snapshot`. `include` forwards the
 * generate() include* flags. `cancelled(signal)` builds the error thrown after an abort.
 */
export async function runTask(app, {
    ai = getAI(), ctx, system, payload, parse = text => text, signal, check = () => {},
    retryOnParseError = true, channel = app, snapshot, include = {},
    cancelled = () => Error('已取消生成'), emptyMessage = 'AI 返回空内容，未应用结果',
} = {}) {
    if (!ai?.capture || !ai?.generate) throw Error('共享 AI 尚未就绪，请检查 AI 设置。');
    const prompt = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const captured = snapshot ?? ai.capture(channel);
    const guard = () => { check(); if (signal?.aborted) throw cancelled(signal); };
    const ask = async request => {
        const raw = await ai.generate(app, ctx, { systemPrompt: system, prompt: request }, { ...include, signal, snapshot: captured, data: { request } });
        guard();
        if (typeof raw !== 'string' || !raw.trim()) throw Error(emptyMessage);
        return raw;
    };
    const first = await ask(prompt);
    try { return await parse(first); }
    catch (error) {
        if (!retryOnParseError) throw error;
        return await parse(await ask(`${prompt}\n\n${retryNote(error)}`));
    }
}
