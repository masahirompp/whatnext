#!/usr/bin/env node
// Compare the shape of `claude agents --json --all` with docs/claude-agents-json.samples.json.
// Usage: node check-agents-json.mjs [rows.json]   (without an argument, runs claude)
// Exit 0: nothing new. Exit 1: something the samples don't know about. Exit 2: could not run.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const samples = JSON.parse(readFileSync(join(repo, 'docs/claude-agents-json.samples.json'), 'utf8'));
const ENUMS = ['kind', 'state', 'status', 'waitingFor'];

let version = '(from file)';
let rows;
try {
  if (process.argv[2]) rows = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  else {
    version = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
    rows = JSON.parse(execFileSync('claude', ['agents', '--json', '--all'], { encoding: 'utf8' }));
  }
} catch (e) {
  console.error(`could not read rows: ${e.message}`);
  process.exit(2);
}
if (!Array.isArray(rows)) { console.error('not an array'); process.exit(1); }

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// shape: kind -> key -> { types:Set, values:Set (enum keys only) }
function shape(list, extra = {}) {
  const s = new Map();
  const slot = (kind, key) => {
    if (!s.has(kind)) s.set(kind, new Map());
    const k = s.get(kind);
    if (!k.has(key)) k.set(key, { types: new Set(), values: new Set() });
    return k.get(key);
  };
  for (const r of list) {
    for (const [key, v] of Object.entries(r)) {
      const e = slot(r.kind, key);
      e.types.add(typeOf(v));
      if (ENUMS.includes(key)) e.values.add(v);
    }
  }
  for (const [path, vals] of Object.entries(extra)) {
    const [kind, key] = path.split('.');
    const e = slot(kind, key);
    for (const v of vals) { e.types.add(typeOf(v)); e.values.add(v); }
  }
  return s;
}

const known = shape(samples.rows, samples.otherKnownValues);
const now = shape(rows);
const news = [];
const unseen = [];

for (const [kind, keys] of now) {
  if (!known.has(kind)) { news.push(`new kind: ${JSON.stringify(kind)} (keys: ${[...keys.keys()].join(', ')})`); continue; }
  const k = known.get(kind);
  for (const [key, e] of keys) {
    if (!k.has(key)) { news.push(`${kind}: new key ${key} (${[...e.types].join('|')}) e.g. ${JSON.stringify([...e.values][0] ?? rows.find((r) => r.kind === kind && key in r)[key])}`); continue; }
    for (const t of e.types) if (!k.get(key).types.has(t)) news.push(`${kind}.${key}: new type ${t}`);
    for (const v of e.values) if (!k.get(key).values.has(v)) news.push(`${kind}.${key}: new value ${JSON.stringify(v)}`);
  }
}
for (const [kind, keys] of known) {
  if (!now.has(kind)) { unseen.push(`kind ${kind} (no such rows right now)`); continue; }
  for (const key of keys.keys()) if (!now.get(kind).has(key)) unseen.push(`${kind}.${key}`);
}

console.log(`claude: ${version} / samples: ${samples.claudeVersion} / rows: ${rows.length}`);
if (news.length) { console.log('\nNEW (not in samples):'); for (const n of news) console.log(`  ${n}`); }
if (unseen.length) console.log(`\nnot seen this time (may just mean no such row now): ${unseen.join(', ')}`);
if (!news.length) console.log('\nOK: every key, type and value is already in the samples.');
process.exit(news.length ? 1 : 0);
