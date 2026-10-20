import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {startupGraph} from './startup-graph.mjs';
const root=path.resolve(import.meta.dirname,'..');let count=0;const skip=new Set(['.git','.claude','node_modules']);
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory()){if(!skip.has(entry.name))walk(file);}else if(/\.(?:m?js|json)$/.test(file)){const source=fs.readFileSync(file,'utf8');if(file.endsWith('.json'))JSON.parse(source);else{const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(result.status)throw Error(result.stderr);for(const match of source.matchAll(/^import\s+(?:[^;\n]*?\s+from\s+)?['"](\.[^'"]+)['"]/gm)){if(!fs.existsSync(path.resolve(path.dirname(file),match[1])))throw Error('Missing import '+file+' '+match[1]);}count++;}}}}
walk(root);const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));for(const key of ['js','css'])if(!fs.existsSync(path.join(root,manifest[key])))throw Error('Missing entry '+key);
const html=fs.readFileSync(path.join(root,'apps/status/hud.html'),'utf8');for(const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)){const r=spawnSync(process.execPath,['--check'],{input:match[1],encoding:'utf8'});if(r.status)throw Error(r.stderr);}
const rel=file=>path.relative(root,file).split(path.sep).join('/'),read=file=>fs.readFileSync(file,'utf8');
const files=(dir,test)=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?(skip.has(e.name)?[]:files(path.join(dir,e.name),test)):test(e.name)?[path.join(dir,e.name)]:[]);
// Version: manifest is the source; package.json, the AminOS global and README must match it.
const pkg=JSON.parse(read(path.join(root,'package.json'))),versions={'package.json':pkg.version,'index.js':read(path.join(root,'index.js')).match(/\bversion:'([^']+)'/)?.[1],'README.md':read(path.join(root,'README.md')).match(/当前版本：\*\*([^*]+)\*\*/)?.[1]};
for(const [file,v] of Object.entries(versions))if(v!==manifest.version)throw Error(`Version mismatch: manifest.json ${manifest.version}, ${file} ${v}`);
// Every asset must be referenced by name from code, styles or pages; licence texts ship beside their fonts.
const sources=files(root,name=>/\.(?:m?js|css|html)$/.test(name)).map(read).join('\n');
const unused=files(path.join(root,'assets'),()=>true).filter(file=>!/-OFL\.txt$|LICENSE/i.test(file)&&!sources.includes(path.basename(file)));
if(unused.length)throw Error('Unreferenced assets: '+unused.map(rel).join(', '));
// A stylesheet reached twice through the @import chain is parsed twice and reorders the cascade.
const cssSeen=new Map();
(function css(file,from){const key=rel(file);if(cssSeen.has(key))throw Error(`Duplicate @import ${key}: ${cssSeen.get(key)} and ${from}`);cssSeen.set(key,from);for(const m of read(file).matchAll(/@import\s+(?:url\()?\s*['"]([^'"]+)['"]/g))css(path.resolve(path.dirname(file),m[1]),key);})(path.join(root,manifest.css),'manifest.json');
// Startup budget: modules the entry loads before any window opens (see startup-graph.mjs).
const MODULE_BUDGET=188,{modules:graph,views,bytes}=startupGraph(path.join(root,manifest.js));
console.log(`Startup graph: ${graph.size} modules, ${(bytes/1024).toFixed(1)} KiB (budget ${MODULE_BUDGET}); ${views.size} lazy views`);
if(graph.size>MODULE_BUDGET)throw Error(`Startup graph has ${graph.size} modules, over the ${MODULE_BUDGET} budget`);
console.log(`PASS: ${count} JS modules, relative imports, JSON, entry points, HUD inline script, version ${manifest.version}, assets, ${cssSeen.size} stylesheets`);
