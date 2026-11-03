// Swap a card's original description for its living copy inside the finished prompt.
// Chat completion: an array of {role, content}; text completion: one string.
// Only an exact occurrence is replaced. Nothing is added when no occurrence is found.

/** Forms the trimmed description may take in the prompt: as written and with macros replaced. */
export function candidates(description, substitute) {
    const forms = [];
    const add = text => { if (typeof text === 'string' && text.trim().length >= 8 && !forms.includes(text)) forms.push(text); };
    const trimmed = typeof description === 'string' ? description.trim() : '';
    // SillyTavern trims, replaces macros, drops \r and may collapse blank lines (power user option).
    const variants = text => { const plain = text.replace(/\r/g, ''); return [plain, plain.replace(/\n+/g, '\n')]; };
    if (typeof substitute === 'function') { try { variants(substitute(trimmed)).forEach(add); } catch {} }
    variants(trimmed).forEach(add);
    // Longest first, so a trimmed form never cuts a longer exact match in half.
    return forms.sort((a, b) => b.length - a.length);
}

function replaceIn(text, forms, replacement) {
    for (const form of forms) {
        const at = text.indexOf(form);
        if (at >= 0) return { text: text.slice(0, at) + replacement + text.slice(at + form.length), matched: true };
    }
    return { text, matched: false };
}

/** Mutates the messages in place. Returns true when one occurrence was replaced. */
const isAssistant = message => message?.role === 'assistant' || message?.role === 'model';
export const messageText = message => typeof message?.content === 'string' ? message.content : Array.isArray(message?.content) ? message.content.map(part => typeof part?.text === 'string' ? part.text : '').join('\n') : '';
/** Mutates the messages in place. Returns true when one occurrence was replaced.
 *  System/user messages are searched first. Assistant messages come last and only when they are
 *  not chat history (`history`: the chat's message texts): providers such as Gemini sign the
 *  model's own replies (thought signatures) and reject a request whose signed text changed, but
 *  presets often put the character definitions in an assistant-role block. */
export function replaceInMessages(messages, forms, replacement, { history = [] } = {}) {
    if (!Array.isArray(messages) || !forms.length) return false;
    const past = history.map(text => String(text ?? '').trim()).filter(text => text.length >= 2);
    const fromChat = message => { const text = messageText(message); return past.some(item => text.includes(item)); };
    const ordered = [...messages.filter(message => !isAssistant(message)), ...messages.filter(message => isAssistant(message) && !fromChat(message))];
    for (const message of ordered) {
        if (typeof message?.content === 'string') {
            const result = replaceIn(message.content, forms, replacement);
            if (result.matched) { message.content = result.text; return true; }
        } else if (Array.isArray(message?.content)) {
            for (const part of message.content) {
                if (typeof part?.text !== 'string') continue;
                const result = replaceIn(part.text, forms, replacement);
                if (result.matched) { part.text = result.text; return true; }
            }
        }
    }
    return false;
}

export function replaceInText(prompt, forms, replacement) {
    if (typeof prompt !== 'string' || !forms.length) return { prompt, matched: false };
    const result = replaceIn(prompt, forms, replacement);
    return { prompt: result.text, matched: result.matched };
}
