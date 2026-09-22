#!/usr/bin/env node
// Fills `apiExamples` in a web-hld bundle: one request + response per endpoint, best source first.
//   captured  — what the app really sent/received during capture.mjs (already in the bundle)
//   stub      — stubby4j YAML mappings (url → response file / body, `post` → request)
//   type      — a skeleton built from the request/response TypeScript types
//
//   node examples.mjs <bundle.json> --project <appDir> [--stubby <yaml|dir> ...] [-o out.json]
import fs from 'node:fs';
import path from 'node:path';
import { Project } from './lib/project.mjs';
import { makeEndpointMatcher, trim, parseJsonLoose, redact } from './lib/sample.mjs';

const argv = process.argv.slice(2);
const opt = { stubby: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--project') opt.project = argv[++i];
  else if (a === '--stubby') opt.stubby.push(argv[++i]);
  else if (a === '-o') opt.out = argv[++i];
  else if (!a.startsWith('-') && !opt.bundle) opt.bundle = a;
  else { process.stderr.write(`unknown argument: ${a}\n`); process.exit(1); }
}
if (!opt.bundle || !opt.project) {
  process.stderr.write('Usage: node examples.mjs <bundle.json> --project <appDir> [--stubby <yaml|dir> ...] [-o out.json]\n');
  process.exit(1);
}
opt.out = opt.out || opt.bundle;

const bundle = JSON.parse(fs.readFileSync(opt.bundle, 'utf8'));
const ex = bundle.apiExamples = bundle.apiExamples || {};
const matchEndpoint = makeEndpointMatcher(bundle);

// Examples carried over from runs before masking existed get masked now
for (const cur of Object.values(ex)) {
  for (const k of ['request', 'response']) {
    if (cur[k] === undefined || /^(type|fields)/.test(cur[`${k}From`] || '')) continue;   // skeletons hold no data
    const [r, m] = redact(cur[k]); cur[k] = r; cur.masked = cur.masked || m;
  }
}

// ── stubby4j mappings ──────────────────────────────────────────────────────
function yamlFiles(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return [p];
  return fs.readdirSync(p).filter(f => /\.ya?ml$/.test(f) && !f.startsWith('__')).map(f => path.join(p, f));
}

/** Just enough YAML for stubby entries: method, url, post/json matcher, response status + file/body. */
function stubEntries(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const chunk of src.split(/^-\s+request:\s*$/m).slice(1)) {
    const [reqPart, resPart = ''] = chunk.split(/^\s+response:\s*$/m);
    const field = (part, name) => {
      const m = new RegExp(`^(\\s+)${name}:\\s*(.*)$`, 'm').exec(part);
      if (!m) return undefined;
      let v = m[2].trim();
      if (v === '' || v === '>' || v === '|' || v === '>-' || v === '|-') {           // block scalar
        const indent = m[1].length;
        const rest = part.slice(m.index + m[0].length).split('\n').slice(1);
        const lines = [];
        for (const l of rest) { if (l.trim() && l.search(/\S/) <= indent) break; lines.push(l.trim()); }
        v = lines.join('\n').trim();
        if (/^-\s/.test(v)) v = v.split('\n').map(x => x.replace(/^-\s*/, '')).join(',');   // method list
      }
      return v.replace(/^(['"])([\s\S]*)\1$/, '$2');
    };
    const methods = (field(reqPart, 'method') || 'GET').replace(/[[\]]/g, '').split(',').map(x => x.trim().toUpperCase());
    const url = field(reqPart, 'url');
    if (!url) continue;
    const post = field(reqPart, 'json') || field(reqPart, 'post');
    const status = Number(field(resPart, 'status') || 200);
    const bodyFile = field(resPart, 'file');
    const body = field(resPart, 'body');
    out.push({ file, methods, url, post, status, bodyFile, body });
  }
  return out;
}

const stubUrlPath = u => u.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/');
let fromStub = 0;
for (const p of opt.stubby) {
  for (const f of yamlFiles(p)) {
    for (const e of stubEntries(f)) {
      if (e.status >= 300) continue;
      for (const m of e.methods) {
        if (m === 'OPTIONS') continue;
        const key = matchEndpoint(m, stubUrlPath(e.url));
        if (!key) continue;
        const cur = ex[key] = ex[key] || {};
        if (cur.response === undefined) {
          let text = e.body;
          if (e.bodyFile) {
            const abs = path.resolve(path.dirname(e.file), e.bodyFile);
            try { text = fs.readFileSync(abs, 'utf8'); } catch { /* missing file */ }
          }
          const json = parseJsonLoose(text);
          // stub files are often copied from production responses — mask them like live traffic
          if (json !== undefined) { const [r, m] = redact(trim(json)); cur.response = r; cur.masked = cur.masked || m; cur.responseFrom = `stub: ${e.bodyFile || path.basename(e.file)}`; fromStub++; }
        }
        if (cur.request === undefined && e.post) {
          const json = parseJsonLoose(e.post);
          if (json !== undefined) { const [r, m] = redact(trim(json)); cur.request = r; cur.masked = cur.masked || m; cur.requestFrom = `stub: ${path.basename(e.file)}`; }
        }
      }
    }
  }
}

// ── TypeScript types for whatever is still missing ─────────────────────────
const project = new Project(opt.project);
let fromType = 0;
for (const s of bundle.screens) for (const a of s.apis || []) {
  const key = `${a.method} ${a.path}`;
  const cur = ex[key] = ex[key] || {};
  if (cur.request === undefined && /^(POST|PUT|PATCH)$/.test(a.method)) {
    let sample = a.requestType ? project.sampleOf(a.requestType) : null;
    if (sample == null && (a.requestFields || []).length) sample = Object.fromEntries(a.requestFields.map(f => [f, null]));
    if (sample != null) { cur.request = trim(sample); cur.requestFrom = a.requestType ? `type: ${a.requestType}` : 'fields in the call'; fromType++; }
  }
  if (cur.response === undefined && a.responseType) {
    const sample = project.sampleOf(a.responseType);
    if (sample != null) { cur.response = trim(sample); cur.responseFrom = `type: ${a.responseType}`; fromType++; }
  }
}

fs.writeFileSync(opt.out, JSON.stringify(bundle));
const keys = new Set(bundle.screens.flatMap(s => (s.apis || []).map(a => `${a.method} ${a.path}`)));
const withResp = [...keys].filter(k => ex[k] && ex[k].response !== undefined).length;
const withReq = [...keys].filter(k => ex[k] && ex[k].request !== undefined).length;
const captured = [...keys].filter(k => ex[k] && /^captured/.test(ex[k].responseFrom || '')).length;
process.stderr.write(`${keys.size} endpoints · response example for ${withResp} (captured ${captured}, stub ${fromStub}) · request example for ${withReq} · type skeletons ${fromType} · wrote ${opt.out}\n`);
