// The linkage page is its own Amin OS app. Other apps ask the shell to show it
// instead of mounting a second copy, so only one page holds the settings draft.
let opener = null;
export function setLinkageOpener(fn) { opener = typeof fn === 'function' ? fn : null; }
export async function openLinkage(section) {
    if (!opener) throw Error('联动设置尚未就绪，请稍后从首页“联动更新”打开。');
    return await opener(section);
}
