// Parser and writer for the bracket character-card template:
//   名字=[
//   分区:[
//   *键: 值
//   ]
//   ]
// A line ending in `:[` opens a group, `]` closes it, `键: 值` is a field and any other
// line is plain text. `*` marks are kept as written. Duplicate keys stay in order.
// Groups may also open with `键=[`, and more `名字=[ … ]` blocks may follow the first one:
// they become top-level groups marked `block` and are written back after the root's `]`.
export const MAX_SOURCE = 400000;
const OPEN = /^(\*?)\s*([^\[\]]*?)(\s*[:：=]\s*)\[\s*$/;
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
    const end = parseBody(lines, start + 1, root, root.children, makeId);
    if (end.missing) throw failure(`模板缺少 ${end.missing} 个结尾的“]”。`, end.missing > 1 ? null : start + 1);
    root.after = lines.slice(end.index + 1).join('\n').trim();
    liftBlocks(root, makeId);
    return root;
}

// Parse lines from `from` into `children` until the `]` that closes them. Returns {index} of that
// line, or {missing} (how many `]` are missing) when the text ends first.
function parseBody(lines, from, owner, children, makeId) {
    const stack = [{ children }];
    for (let index = from; index < lines.length; index++) {
        const line = lines[index].trim();
        if (!line) continue;
        const parent = stack.at(-1);
        if (line === ']') {
            stack.pop();
            if (!stack.length) return { index };
            continue;
        }
        let match = line.match(OPEN);
        if (match && !(match[3].includes('=') && /[:：]/.test(match[2]))) {
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
    return { missing: stack.length };
}

/** Move `名字=[ … ]` blocks written right after the root out of `after` into top-level groups.
 *  Stops at the first line that is not such a block; what is left stays in `after`. */
export function liftBlocks(tree, makeId) {
    if (!tree.after) return 0;
    const lines = tree.after.split('\n');
    let index = 0, lifted = 0, rest = 0;
    while (true) {
        while (index < lines.length && !lines[index].trim()) index++;
        const head = lines[index]?.trim().match(ROOT);
        if (!head) break;
        const group = { id: '', kind: 'group', key: head[1].trim(), star: false, block: true, children: [] };
        const end = parseBody(lines, index + 1, group, group.children, makeId);
        if (end.missing) break;
        group.id = makeId();
        tree.children.push(group); lifted++;
        index = end.index + 1; rest = index;
    }
    if (lifted) tree.after = lines.slice(rest).join('\n').trim();
    return lifted;
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
    walk(tree.children.filter(node => !node.block));
    out.push(']');
    for (const block of tree.children.filter(node => node.block)) {
        out.push(`${block.key}=[`); walk(block.children); out.push(']');
        const extra = annotate?.(block);
        if (extra) out.push(extra);
    }
    if (tree.after) out.push(tree.after);
    return out.join('\n');
}

export function counter(prefix = 'n', start = 1) { let next = start; return () => `${prefix}${next++}`; }
