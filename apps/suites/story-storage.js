// 剧情存储 as its own window view (存档与历史 → 剧情存储). The page itself lives in
// settings/story-storage-view.js; this view gives it a context line, a result line
// and a fresh read of the current chat each time it opens.
import { mountStoryStorage } from '../../settings/story-storage-view.js';
import { contextLine } from '../shared/context-line.js';
import { takeAppRequest } from '../shared/open-app.js';

export function mount(target, { getContext = () => globalThis.SillyTavern?.getContext?.(), mountStorage = mountStoryStorage } = {}) {
    const doc = target.ownerDocument ?? globalThis.document;
    const make = (tag, className, text) => { const e = doc.createElement(tag); if (className) e.className = className; if (text) e.textContent = text; return e; };
    target.classList.add('amin-ai', 'amin-settings', 'amin-app-page');
    const heading = make('header', 'amin-context'), line = make('p'), notice = make('p', 'amin-result'), body = make('section', 'amin-stack');
    notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite'); notice.hidden = true;
    heading.append(line); target.replaceChildren(heading, notice, body);
    const report = (text, state = 'success') => { notice.textContent = text; notice.dataset.state = state; notice.hidden = !text; };
    let view = null;
    function draw() {
        view?.dispose(); body.replaceChildren(); report('');
        line.textContent = contextLine(getContext(), '剧情文件、备份与跨设备同步');
        view = mountStorage(body, report);
    }
    return {
        open() {
            const request = takeAppRequest('story');
            draw();
            if (request?.focus === 'import') target.querySelector?.('[data-story-import]')?.focus?.();
        },
        dispose() { view?.dispose(); view = null; target.replaceChildren(); },
    };
}
