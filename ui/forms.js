/** Shared markup only. Each app retains its own events, drafts and save locks. */
export function createFormControls(doc, { rows = 4, register = () => {} } = {}) {
    const make = (tag, text = '', className = '') => {
        const node = doc.createElement(tag); node.textContent = text;
        if (className) node.className = className;
        return node;
    };
    function appendControl(parent, label, input, { full = false, check = false, kind = 'form' } = {}) {
        const wrap = make('label', '', check ? 'amin-check' : 'amin-field' + (full ? ' amin-span-full' : ''));
        input.setAttribute('aria-label', label);
        if (check) wrap.append(input, make('span', label));
        else wrap.append(make('span', label), input);
        parent.append(wrap); register(input, kind); return input;
    }
    function field(parent, label, value = '', { type = 'text', multi = false, min, max, step, maxLength, full = false, kind = 'form' } = {}) {
        const input = make(multi ? 'textarea' : 'input'); input.value = String(value ?? '');
        if (multi) input.rows = rows; else input.type = type;
        if (min != null) input.min = min; if (max != null) input.max = max;
        if (step != null) input.step = step; if (maxLength != null) input.maxLength = maxLength;
        return appendControl(parent, label, input, { full: full || multi, kind });
    }
    function select(parent, label, choices, value = '', kind = 'form') {
        const input = make('select');
        for (const [id, text] of choices) {
            const option = make('option', text); option.value = String(id); input.append(option);
        }
        input.value = String(value ?? '');
        return appendControl(parent, label, input, { kind });
    }
    function checkbox(parent, label, checked = false) {
        const input = make('input'); input.type = 'checkbox'; input.checked = checked;
        return appendControl(parent, label, input, { check: true });
    }
    function toolbar(parent, className = 'amin-toolbar') {
        const box = make('div', '', className); parent.append(box); return box;
    }
    const grid = parent => toolbar(parent, 'amin-form-grid');
    return { make, field, select, checkbox, toolbar, grid };
}

/**
 * One short sentence with the details behind an ⓘ marker (title on hover, the
 * same text for screen readers and on keyboard focus). Use for page notes that
 * would otherwise be a long disclaimer paragraph.
 */
export function infoNote(doc, text, detail = '', className = 'amin-help') {
    const note = doc.createElement('p'); note.className = className; note.textContent = text;
    if (detail) {
        const info = doc.createElement('span'); info.className = 'amin-info'; info.textContent = ' ⓘ';
        info.title = detail; info.tabIndex = 0; info.setAttribute('role', 'note'); info.setAttribute('aria-label', detail);
        note.title = detail; note.append(info);
    }
    return note;
}
