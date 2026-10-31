// Parser and writer for the bracket character-card template:
//   名字=[
//   分区:[
//   *键: 值
//   ]
//   ]
// A line ending in `:[` opens a group, `]` closes it, `键: 值` is a field and any other
// line is plain text. `*` marks are kept as written. Duplicate keys stay in order.
export const MAX_SOURCE = 400000;
const OPEN = /^(\*?)\s*([^\[\]]*?)(\s*[:：]\s*)\[\s*$/;
const ROOT = /^([^=\[\]]+?)\s*=\s*\[\s*$/;
const FIELD = /^(\*?)\s*([^:：\[\]]{1,80}?)(\s*[:：]\s*)(.*)$/;
// Separators are stored only when they differ from the usual `: ` / `:` so the text round-trips.
const sep = (raw, usual) => raw === usual ? {} : { sep: raw };
const failure = (message, line) => Object.assign(Error(line ? `第 ${line} 行：${message}` : message), { code: 'CARD_PROFILE_PARSE', line });

/** Parse a description. Returns {name, before, after, children} or throws with the failing line. */
export function parseCard(source, makeId = counter()) {
    if (typeof source !== 'string' || !source.trim()) throw failure('角色描述为空。');
    if (source.length > MAX_SOURCE) throw failure('角色描述过长。');
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const start = lines.findIndex(line => ROOT.test(line.trim()));
    if (start < 0) throw failure('没有找到“名字=[”开头的模板。');
    const root = { name: lines[start].trim().match(ROOT)[1].trim(), before: lines.slice(0, start).join('\n').trim(), after: '', children: [] };
    const stack = [root];
    let end = -1;
    for (let index = start + 1; index < lines.length; index++) {
        const line = lines[index].trim(), number = index + 1;
        if (!line) continue;
        const parent = stack.at(-1);
        if (line === ']') {
            stack.pop();
            if (!stack.length) { end = index; break; }
            continue;
        }
        let match = line.match(OPEN);
        if (match) {
            const group = { id: makeId(), kind: 'group', key: match[2], star: !!match[1], ...sep(match[3], ':'), children: [] };
            parent.children.push(group); stack.push(group); continue;
        }
        match = line.match(FIELD);
        if (match && match[2].trim()) parent.children.push({ id: makeId(), kind: 'field', key: match[2].trim(), star: !!match[1], ...sep(match[3], ': '), value: match[4].trim() });
        else {
            const star = line.startsWith('*');
            parent.children.push({ id: makeId(), kind: 'text', star, value: (star ? line.slice(1) : line).trim() });
        }
    }
    if (end < 0) throw failure(`模板缺少 ${stack.length} 个结尾的“]”。`, stack.length > 1 ? null : start + 1);
    root.after = lines.slice(end + 1).join('\n').trim();
    return root;
}

/** Write a parsed tree back to template text. `annotate(node)` may return extra lines after a node. */
export function writeCard(tree, { annotate } = {}) {
    const out = [];
    if (tree.before) out.push(tree.before);
    out.push(`${tree.name}=[`);
    const walk = nodes => {
        for (const node of nodes) {
            const mark = node.star ? '*' : '';
            if (node.kind === 'group') { out.push(`${mark}${node.key}${node.sep ?? ':'}[`); walk(node.children); out.push(']'); }
            else if (node.kind === 'field') out.push(`${mark}${node.key}${node.sep ?? ': '}${node.value}`.trimEnd());
            else out.push(`${mark}${node.value}`);
            const extra = annotate?.(node);
            if (extra) out.push(extra);
        }
    };
    walk(tree.children);
    out.push(']');
    if (tree.after) out.push(tree.after);
    return out.join('\n');
}

export function counter(prefix = 'n', start = 1) { let next = start; return () => `${prefix}${next++}`; }
