import fs from 'node:fs';
import path from 'node:path';
// Startup graph: modules reachable from the entry through static imports and literal dynamic imports.
// `import(/* view */ './x.js')` marks a window view that loads when the window first opens: it is recorded, not followed.
const IMPORT = /(?:\bfrom|\bimport)\s*(\(\s*(?:\/\*\s*(\w+)\s*\*\/\s*)?)?['"](\.{1,2}\/[^'"]+)['"]/g;
export function startupGraph(entry) {
    const modules = new Set(), views = new Set(); let bytes = 0;
    (function visit(file) {
        if (modules.has(file)) return;
        if (!fs.existsSync(file)) throw Error('Missing startup module ' + file);
        modules.add(file); const source = fs.readFileSync(file, 'utf8'); bytes += Buffer.byteLength(source);
        for (const [, dynamic, tag, specifier] of source.matchAll(IMPORT)) {
            const target = path.resolve(path.dirname(file), specifier);
            if (dynamic && tag === 'view') { if (!fs.existsSync(target)) throw Error('Missing view import ' + file + ' ' + specifier); views.add(target); }
            else visit(target);
        }
    })(path.resolve(entry));
    return { modules, views, bytes };
}
