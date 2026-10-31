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
export function replaceInMessages(messages, forms, replacement) {
    if (!Array.isArray(messages) || !forms.length) return false;
    for (const message of messages) {
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
