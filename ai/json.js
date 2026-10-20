// One tolerant reader for structured model output. Models often wrap JSON in a
// Markdown fence or add a sentence before/after it; the payload itself is never
// repaired or unescaped, only located and handed to JSON.parse.
const OPENERS = { '{': '}', '[': ']' };
const FENCE = /```[ \t]*(?:json5?|javascript|js)?[ \t]*\r?\n?([\s\S]*?)```/i;
const isStructured = value => value !== null && typeof value === 'object';

/** Returns the balanced object/array starting at `start`, or null when it never closes or mismatches. */
function balanced(text, start) {
    const stack = [];
    let inString = false, escaped = false;
    for (let i = start; i < text.length; i++) {
        const char = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (OPENERS[char]) stack.push(OPENERS[char]);
        else if (char === '}' || char === ']') {
            if (stack.pop() !== char) return { mismatched: true };
            if (!stack.length) return { text: text.slice(start, i + 1) };
        }
    }
    return { unclosed: true };
}

function attempt(text) {
    try { const value = JSON.parse(text); return isStructured(value) ? { value } : { primitive: true }; }
    catch (error) { return { error }; }
}

// Trailing prose is allowed, but a second structure that never closes (for example
// '{"a":1}{') means the model was cut off or emitted several payloads.
function truncatedAfter(text, from) {
    for (let i = from; i < text.length; i++) {
        if (!OPENERS[text[i]]) continue;
        const block = balanced(text, i);
        if (!block.text) return true;
        i += block.text.length - 1;
    }
    return false;
}

function locate(text) {
    const direct = attempt(text);
    if (direct.value !== undefined) return direct;
    let detail = direct.primitive ? '结果不是 JSON 对象或数组' : '', found = false;
    for (let i = 0; i < text.length; i++) {
        if (!OPENERS[text[i]]) continue;
        found = true;
        const block = balanced(text, i);
        // Everything after an unclosed or mismatched opener lies inside it; never
        // return a nested fragment of a truncated or broken payload.
        if (block.unclosed) { detail ||= '括号未闭合，输出可能被截断'; break; }
        if (block.mismatched) { detail ||= '括号不匹配'; break; }
        const parsed = attempt(block.text);
        if (parsed.value !== undefined) return truncatedAfter(text, i + block.text.length) ? { detail: 'JSON 之后还有未闭合的内容，输出可能被截断' } : parsed;
        // A balanced but invalid block (such as "[注]" in prose) is skipped whole.
        detail ||= parsed.error?.message || '结果不是 JSON 对象或数组';
        i += block.text.length - 1;
    }
    return { detail: found ? detail : '没有找到 JSON 对象或数组' };
}

/**
 * Parses the first complete JSON object or array in model output. Tolerates a BOM,
 * Markdown code fences and explanatory text before or after the payload. Brackets
 * inside strings (including escaped quotes) do not affect matching.
 * Throws a Chinese error naming `label`; the original failure is kept as `cause`.
 */
export function parseModelJSON(text, { label = '模型输出' } = {}) {
    if (typeof text !== 'string') throw Error(`${label}为空或不是文本，未应用结果。`);
    const clean = text.replace(/^﻿/, '').trim();
    if (!clean) throw Error(`${label}为空，未应用结果。`);
    const fenced = clean.match(FENCE)?.[1]?.replace(/^﻿/, '').trim();
    let detail = '';
    for (const candidate of fenced ? [fenced, clean] : [clean]) {
        const result = locate(candidate);
        if (result.value !== undefined) return result.value;
        detail ||= result.detail;
    }
    throw Error(`${label}不是完整合法的 JSON（${detail}），未应用结果。`);
}
