// Window UIs load when a window first opens; startup keeps only background services.
// Lazy imports are written `import(/* view */ '...' + retry)` so scripts/startup-graph.mjs leaves them out of the startup budget.
// Browsers remember a failed module fetch, so each retry asks for the module under a fresh query string.
export function lazyView(importer, name) {
    let pending = null, failures = 0;
    return () => pending ??= importer(failures ? '?retry=' + failures : '').catch(cause => {
        pending = null; failures++;
        throw Object.assign(Error(`${name}界面加载失败，请检查网络连接后重试；仍失败时请刷新页面。`), { cause });
    });
}

// A light placeholder for floor windows while their view module loads.
export function floorLoading(body, doc = body.ownerDocument ?? globalThis.document) {
    const status = doc.createElement('p');
    status.className = 'amin-floor-loading amin-meta'; status.setAttribute('role', 'status'); status.textContent = '正在加载…';
    body.append(status);
    return {
        done() { status.remove(); },
        fail(error, retry) {
            status.textContent = error?.message || '加载失败，请重试。'; status.dataset.state = 'error'; status.setAttribute('role', 'alert');
            if (!retry) return;
            const button = doc.createElement('button'); button.type = 'button'; button.textContent = '重试';
            button.onclick = () => { status.remove(); retry(); };
            status.append(' ', button);
        },
    };
}
