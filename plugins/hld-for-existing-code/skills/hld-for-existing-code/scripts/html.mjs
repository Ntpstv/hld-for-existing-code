#!/usr/bin/env node
// Renders a web-hld bundle as one self-contained HTML page (no Figma needed).
//   Overview  — totals and every journey as a one-row mini flow, the whole app on one screen
//   Journey   — that journey's flow with compact cards and arrows
//   Drawer    — click any screen/API: screenshot, description, where it goes, API examples
//   API       — searchable table of endpoints
// Hash routes (#/, #/j/<journey>, #/s/<route>, #/api, #/a/<key>) keep the browser's back button working.
//
//   node html.mjs <bundle.json> [-o board.html]      (default: board.html beside the bundle)
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './lib/sample.mjs';

const argv = process.argv.slice(2);
const oi = argv.indexOf('-o');
const outArg = oi >= 0 ? argv.splice(oi, 2)[1] : null;
const bundlePath = argv[0];
if (!bundlePath) { process.stderr.write('Usage: node html.mjs <bundle.json> [-o board.html]\n'); process.exit(1); }
const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
if (bundle.schema !== 'web-hld/1') { process.stderr.write('error: not a web-hld/1 bundle\n'); process.exit(1); }
const out = outArg || path.join(path.dirname(path.resolve(bundlePath)), 'board.html');

const screens = bundle.screens;
const byRoute = new Map(screens.map(s => [s.route, s]));

// ── Flow: edges inside a journey, columns by flow depth (same rules as the Figma plugin) ──
const edges = [];
for (const s of screens) for (const g of s.goesTo || []) {
  const t = g.target && byRoute.get(g.target);
  if (!t || t === s || t.journey !== s.journey) continue;
  if ((g.via || []).length && g.via.every(v => v === 'on init')) continue;      // guard bounce, not flow
  if (!edges.some(e => e.from === s.route && e.to === t.route)) {
    edges.push({ from: s.route, to: t.route, label: (g.via || [])[0] || '', more: Math.max(0, (g.via || []).length - 1) });
  }
}
function layout(list) {
  const outE = new Map(list.map(s => [s.route, []]));
  for (const e of edges) if (outE.has(e.from) && outE.has(e.to) && !outE.get(e.from).includes(e.to)) outE.get(e.from).push(e.to);
  const depth = r => r.split('/').filter(Boolean).length;
  const indeg = new Map(list.map(s => [s.route, 0]));
  for (const ts of outE.values()) for (const t of ts) indeg.set(t, indeg.get(t) + 1);
  const order = list.map(s => s.route).sort((a, b) => depth(a) - depth(b) || indeg.get(a) - indeg.get(b) || a.localeCompare(b));
  const fwd = new Map(order.map(r => [r, []])), state = new Map();
  const visit = r => { state.set(r, 1); for (const t of outE.get(r)) { if (state.get(t) === 1) continue; fwd.get(r).push(t); if (!state.get(t)) visit(t); } state.set(r, 2); };
  for (const r of order) if (!state.get(r)) visit(r);
  const layer = new Map(order.map(r => [r, 0])), fin = new Map(order.map(r => [r, 0]));
  for (const ts of fwd.values()) for (const t of ts) fin.set(t, fin.get(t) + 1);
  const q = order.filter(r => fin.get(r) === 0);
  while (q.length) { const r = q.shift(); for (const t of fwd.get(r)) { layer.set(t, Math.max(layer.get(t), layer.get(r) + 1)); fin.set(t, fin.get(t) - 1); if (!fin.get(t)) q.push(t); } }
  const linked = new Set();
  for (const [r, ts] of fwd) if (ts.length) { linked.add(r); ts.forEach(t => linked.add(t)); }
  const cols = [];
  for (const r of order) if (linked.has(r)) (cols[layer.get(r)] = cols[layer.get(r)] || []).push(r);
  return { cols: cols.filter(Boolean), loose: order.filter(r => !linked.has(r)) };
}

// ── Data for the page (examples masked again: the file gets shared) ──
const journeyNames = [...new Set(screens.map(s => s.journey))];
const journeyDesc = new Map((bundle.journeys || []).map(j => [j.name, j.description || '']));
const journeys = journeyNames.map(name => {
  const list = screens.filter(s => s.journey === name);
  return { name, description: journeyDesc.get(name) || '', ...layout(list), count: list.length, shots: list.filter(s => s.screenshot).length };
});
const apis = new Map();
for (const s of screens) for (const a of s.apis || []) {
  const key = `${a.method} ${a.path}`;
  if (!apis.has(key)) {
    const ex = { ...((bundle.apiExamples || {})[key] || {}) };
    for (const f of ['request', 'response']) {
      if (ex[f] === undefined || /^(type|fields)/.test(ex[`${f}From`] || '')) continue;
      const [r, m] = redact(ex[f]); ex[f] = r; ex.masked = ex.masked || m;
    }
    apis.set(key, { key, method: a.method, path: a.path, base: a.base || '', via: a.via || '', requestType: a.requestType || '', responseType: a.responseType || '', usedBy: [], ex });
  }
  if (!apis.get(key).usedBy.includes(s.route)) apis.get(key).usedBy.push(s.route);
}
const data = {
  project: bundle.project, framework: bundle.framework, generatedAt: String(bundle.generatedAt || '').slice(0, 10),
  journeys, edges, warnings: bundle.warnings || [],
  screens: Object.fromEntries(screens.map(s => [s.route, {
    route: s.route, journey: s.journey, name: s.name, title: s.title || '', description: s.description || '',
    img: s.screenshot ? `data:${s.screenshot.mime};base64,${s.screenshot.data}` : '', note: s.captureNote || '',
    elements: (s.elements || []).slice(0, 14), goesTo: s.goesTo || [], apis: (s.apis || []).map(a => `${a.method} ${a.path}`),
    storage: s.storage || [], files: s.files || [],
  }])),
  apis: [...apis.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
};
const json = JSON.stringify(data).replace(/</g, '\\u003c');
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');

const html = `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(bundle.project)} · HLD</title>
<style>
:root{--bg:#f5f6fa;--panel:#fff;--panel2:#f0f2f7;--line:#e2e5ee;--text:#2b2f3c;--dim:#6c7286;--head:#141722;
--accent:#3563e9;--accent-soft:#e8eefd;--green:#12805c;--green-soft:#e3f5ee;--amber:#9a6700;--amber-soft:#fdf3dc;
--red:#c43349;--shadow:0 1px 2px rgba(16,24,40,.06),0 4px 14px rgba(16,24,40,.06);--hl:#f5b400}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#12141c;--panel:#1b1e29;--panel2:#232736;--line:#2f3446;--text:#c9cfdd;--dim:#8a90a3;--head:#eef0f6;
--accent:#6d97ff;--accent-soft:#1f2a4a;--green:#39c893;--green-soft:#153328;--amber:#f0b429;--amber-soft:#3a2f12;--red:#ef6b7f;--shadow:none}}
:root[data-theme="dark"]{--bg:#12141c;--panel:#1b1e29;--panel2:#232736;--line:#2f3446;--text:#c9cfdd;--dim:#8a90a3;--head:#eef0f6;
--accent:#6d97ff;--accent-soft:#1f2a4a;--green:#39c893;--green-soft:#153328;--amber:#f0b429;--amber-soft:#3a2f12;--red:#ef6b7f;--shadow:none}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 Inter,"Noto Sans Thai","Sukhumvit Set",system-ui,sans-serif}
a{color:var(--accent);text-decoration:none;cursor:pointer}a:hover{text-decoration:underline}
button{font:inherit;color:inherit}
.app{display:grid;grid-template-columns:240px 1fr;min-height:100vh}
aside{position:sticky;top:0;height:100vh;overflow:auto;background:var(--panel);border-right:1px solid var(--line);padding:18px 12px}
aside .brand{padding:0 8px 14px;border-bottom:1px solid var(--line);margin-bottom:10px}
aside .brand b{display:block;color:var(--head);font-size:15px;line-height:1.3;overflow-wrap:anywhere}aside .brand span{color:var(--dim);font-size:12px}
aside nav a{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;color:var(--text);font-size:13px}
aside nav a:hover{background:var(--panel2);text-decoration:none}aside nav a.on{background:var(--accent-soft);color:var(--accent);font-weight:600}
aside nav a small{color:var(--dim);font-size:11px;font-weight:400}aside nav .sep{margin:14px 10px 4px;color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
aside .tools{margin-top:16px;padding:0 8px}aside .tools button{width:100%;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:6px;cursor:pointer;font-size:12px}
main{min-width:0;padding:22px 28px 60px}
.search{position:relative;max-width:520px;margin-bottom:18px}
.search input{width:100%;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:9px 12px;color:var(--text);font:inherit;box-shadow:var(--shadow)}
.results{position:absolute;z-index:20;left:0;right:0;top:44px;background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.15);max-height:420px;overflow:auto;display:none}
.results.show{display:block}.results a{display:block;padding:8px 12px;border-bottom:1px solid var(--line);color:var(--text)}.results a:hover{background:var(--panel2);text-decoration:none}
.results small{color:var(--dim);display:block;font-size:11px}
h1{font-size:22px;margin:0 0 4px;color:var(--head)}h1+p{margin:0 0 18px;color:var(--dim);max-width:900px}
h2{font-size:16px;margin:26px 0 10px;color:var(--head)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:8px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;box-shadow:var(--shadow)}
.tile b{display:block;font-size:24px;color:var(--head);line-height:1.2}.tile span{color:var(--dim);font-size:12px}
.jrow{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:12px;box-shadow:var(--shadow)}
.jrow .jh{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}.jrow .jh a{color:var(--head);font-size:15px;font-weight:700}.jrow .jh span{color:var(--dim);font-size:12px}
.jrow p{margin:2px 0 10px;color:var(--text);font-size:13px}
.mini{display:flex;align-items:center;gap:6px;overflow-x:auto;padding-bottom:4px}
.mini .mcol{display:flex;flex-direction:column;gap:6px}.mini .arr{color:var(--dim);font-size:16px;flex:0 0 auto}
.mini .loose{display:flex;gap:6px;flex-wrap:wrap;margin-left:10px;padding-left:10px;border-left:1px dashed var(--line)}
.chip{display:flex;align-items:center;gap:8px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:4px 8px 4px 4px;width:190px;cursor:pointer;text-align:left}
.chip:hover{border-color:var(--accent)}
.chip .th{flex:0 0 44px;height:30px;border-radius:4px;background:var(--line) top/cover no-repeat;display:grid;place-items:center;color:var(--dim);font-size:10px}
.chip .tx{min-width:0;display:block}.chip b{display:block;font-size:11px;color:var(--head);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chip small{display:block;font-size:10px;color:var(--accent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.flow{position:relative;display:flex;gap:110px;overflow-x:auto;padding:6px 4px 20px;align-items:flex-start}
.flow .col{display:flex;flex-direction:column;gap:24px;flex:0 0 250px}
svg.links{position:absolute;left:0;top:0;pointer-events:none;overflow:visible}
svg.links path{fill:none;stroke:var(--accent);stroke-width:1.6;opacity:.75}svg.links text{fill:var(--dim);font-size:11px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,250px);gap:24px;margin-top:6px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;box-shadow:var(--shadow);cursor:pointer;width:250px;text-align:left;padding:0;display:block}
.card:hover{border-color:var(--accent)}
.card .th{aspect-ratio:16/10;background:var(--panel2) top/cover no-repeat;border-bottom:1px solid var(--line)}
.card .th.none{display:grid;place-items:center;color:var(--dim);font-size:12px;text-align:center;padding:10px}
.card .bd{padding:10px 12px 12px}.card .rt{display:block}.card b{display:block;color:var(--head);font-size:13px;line-height:1.35}
.card .rt{color:var(--accent);font-size:11px;font-weight:600;overflow-wrap:anywhere}
.card .ds{margin:6px 0 8px;font-size:12px;color:var(--text);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;min-height:1em}
.badges{display:flex;gap:6px;flex-wrap:wrap}.badge{font-size:11px;border-radius:999px;padding:1px 8px}
.badge.api{background:var(--green-soft);color:var(--green)}.badge.nav{background:var(--accent-soft);color:var(--accent)}
.flash{outline:3px solid var(--hl)!important;outline-offset:3px;animation:pulse 1.2s ease-out 2}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(245,180,0,.55)}100%{box-shadow:0 0 0 16px rgba(245,180,0,0)}}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;box-shadow:var(--shadow)}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);font-size:13px;vertical-align:top}
th{background:var(--panel2);color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
tbody tr{cursor:pointer}tbody tr:hover{background:var(--panel2)}
.m{display:inline-block;min-width:52px;text-align:center;font-size:11px;font-weight:700;border-radius:6px;padding:1px 6px;background:var(--green-soft);color:var(--green)}
.m.GET{background:var(--accent-soft);color:var(--accent)}.m.DELETE{color:var(--red)}
.p{font-family:"Roboto Mono",Menlo,monospace;font-size:12px;overflow-wrap:anywhere}.p i{color:var(--dim);font-style:normal}
.src{font-size:11px;color:var(--dim)}
.drawer{position:fixed;top:0;right:0;height:100vh;width:min(560px,100vw);background:var(--panel);border-left:1px solid var(--line);box-shadow:-10px 0 30px rgba(0,0,0,.12);transform:translateX(100%);transition:transform .2s ease;z-index:30;display:flex;flex-direction:column;visibility:hidden}
.drawer.open{transform:none;visibility:visible}
.drawer header{display:flex;gap:8px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line)}
.drawer header button{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:4px 10px;cursor:pointer}
.drawer header .t{flex:1;min-width:0;font-size:12px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.drawer .body{overflow:auto;padding:16px 18px 40px}
.drawer h3{margin:0;font-size:18px;color:var(--head)}.drawer .rt{color:var(--accent);font-weight:600}.drawer .comp{color:var(--dim);font-size:12px}
.drawer .desc{margin:10px 0;font-size:13px}
.drawer .shot{display:block;width:100%;border:1px solid var(--line);border-radius:10px;cursor:zoom-in;margin:6px 0 4px}
.drawer h4{margin:18px 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}
.drawer ul{list-style:none;margin:0;padding:0}.drawer li{padding:5px 0;border-bottom:1px solid var(--line);font-size:13px;overflow-wrap:anywhere}
.drawer li .via{color:var(--dim);font-size:12px;margin-left:6px}
.drawer li.ext{color:var(--amber)}.drawer li.exit{color:var(--red)}.drawer li.unk{color:var(--dim)}
.drawer details{border:1px solid var(--line);border-radius:10px;margin:8px 0;background:var(--panel2)}
.drawer summary{padding:8px 10px;cursor:pointer}
.drawer pre{margin:0 10px 10px;background:var(--bg);border-radius:8px;padding:10px;font:11.5px/1.45 "Roboto Mono",Menlo,monospace;overflow:auto;max-height:360px}
.drawer h5{margin:10px 10px 4px;font-size:11px;color:var(--green)}
.note{background:var(--amber-soft);color:var(--amber);border-radius:8px;padding:8px 10px;font-size:12px;margin:8px 0}
.wf{border:1px solid var(--line);border-radius:10px;padding:10px;background:var(--panel2);font-size:12px}
.wf div{margin:4px 0}.wf .h{font-weight:700}.wf .b{background:var(--accent);color:#fff;border-radius:6px;padding:4px 8px;text-align:center}
.wf .i{border:1px solid var(--line);background:var(--panel);border-radius:6px;padding:4px 8px;color:var(--dim)}.wf .c{border:1px dashed var(--line);border-radius:6px;padding:4px 8px;color:var(--dim)}
.scrim{position:fixed;inset:0;background:rgba(0,0,0,.25);z-index:25;display:none}.scrim.show{display:block}
dialog{border:0;padding:0;background:transparent;max-width:96vw}dialog::backdrop{background:rgba(0,0,0,.8)}dialog img{max-width:96vw;max-height:92vh;display:block;border-radius:8px}
.warns li{font-size:12px;color:var(--amber)}
.menu{display:none}
@media (max-width:860px){.app{grid-template-columns:1fr}aside{position:fixed;z-index:40;width:260px;transform:translateX(-100%);transition:transform .2s}aside.open{transform:none}
.menu{display:inline-block;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 10px;margin-bottom:12px;cursor:pointer}main{padding:16px}}
</style></head>
<body>
<div class="app">
  <aside id="side">
    <div class="brand"><b>${esc(bundle.project)}</b><span>${esc(bundle.framework)} · HLD</span></div>
    <nav id="nav" aria-label="ส่วนต่างๆ"></nav>
    <div class="tools"><button id="theme" type="button">สลับธีม สว่าง / มืด</button></div>
  </aside>
  <main>
    <button class="menu" id="menu" type="button">☰ เมนู</button>
    <div class="search"><input id="q" type="search" placeholder="ค้นหาหน้าจอหรือ API…" aria-label="ค้นหาหน้าจอหรือ API" autocomplete="off"><div class="results" id="results"></div></div>
    <div id="view"></div>
  </main>
</div>
<div class="scrim" id="scrim"></div>
<section class="drawer" id="drawer" aria-label="รายละเอียด"><header><button id="dback" type="button">← ย้อนกลับ</button><div class="t" id="dtitle"></div><button id="dclose" type="button" aria-label="ปิด">✕</button></header><div class="body" id="dbody"></div></section>
<dialog id="lightbox"><img alt=""></dialog>
<script>
const D = ${json};
const $ = s => document.querySelector(s);
const h = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const enc = s => encodeURIComponent(s);
const S = D.screens;
const apiByKey = new Map(D.apis.map(a => [a.key, a]));
const nScreens = Object.keys(S).length, shots = Object.values(S).filter(s => s.img).length;
const shortPath = p => { const seg = p.split('/').filter(Boolean); return seg.length > 2 ? '<i>…/</i>' + h(seg.slice(-2).join('/')) : h(p); };

// ── Sidebar ──────────────────────────────────────────────────────────────
function nav() {
  const js = D.journeys.map(j => '<a data-j="' + h(j.name) + '" href="#/j/' + enc(j.name) + '">' + h(j.name) + ' <small>' + j.count + '</small></a>').join('');
  $('#nav').innerHTML = '<a href="#/" data-j="__o">ภาพรวม</a><div class="sep">Journeys</div>' + js +
    '<div class="sep">Reference</div><a href="#/api" data-j="__api">API <small>' + D.apis.length + '</small></a>';
}
function markNav(id) { document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.j === id)); }

// ── Views ────────────────────────────────────────────────────────────────
const bg = s => s.img ? ' style="background-image:url(' + s.img + ')"' : '';
function chip(r) {
  const s = S[r];
  return '<button type="button" class="chip" data-key="s:' + h(r) + '" data-open="' + h(r) + '"><span class="th"' + bg(s) + '>' + (s.img ? '' : '—') + '</span><span class="tx"><b>' + h(s.title || s.name) + '</b><small>' + h(r) + '</small></span></button>';
}
function overview() {
  markNav('__o');
  const tiles = [[nScreens, 'หน้าจอ'], [D.journeys.length, 'journeys'], [shots + ' / ' + nScreens, 'มีรูปหน้าจอจริง'], [D.apis.length, 'API endpoints'], [D.warnings.length, 'คำเตือน']];
  const rows = D.journeys.map(j => {
    const cols = j.cols.map(c => '<div class="mcol">' + c.map(chip).join('') + '</div>').join('<span class="arr" aria-hidden="true">→</span>');
    const loose = j.loose.length ? '<div class="loose">' + j.loose.map(chip).join('') + '</div>' : '';
    return '<div class="jrow"><div class="jh"><a href="#/j/' + enc(j.name) + '">' + h(j.name) + ' ›</a><span>' + j.count + ' หน้า · รูปจริง ' + j.shots + '</span></div>' +
      (j.description ? '<p>' + h(j.description) + '</p>' : '') + '<div class="mini">' + cols + loose + '</div></div>';
  }).join('');
  const warns = D.warnings.length ? '<h2>คำเตือนจากการวิเคราะห์</h2><ul class="warns">' + D.warnings.map(w => '<li>' + h(w) + '</li>').join('') + '</ul>' : '';
  $('#view').innerHTML = '<h1>' + h(D.project) + '</h1><p>ภาพรวมทุกหน้าจอและ flow · สร้างเมื่อ ' + h(D.generatedAt) + ' โดย HLD for existing code · คลิกหน้าจอเพื่อดูรายละเอียด คลิกชื่อ journey เพื่อดู flow เต็ม</p>' +
    '<div class="tiles">' + tiles.map(t => '<div class="tile"><b>' + t[0] + '</b><span>' + t[1] + '</span></div>').join('') + '</div>' +
    '<h2>Journeys</h2>' + rows + warns;
}
function card(r) {
  const s = S[r];
  const navN = s.goesTo.length, apiN = s.apis.length;
  const th = s.img ? '<span class="th" style="display:block;background-image:url(' + s.img + ')"></span>' : '<span class="th none">' + (s.note ? 'ไม่มีรูป · ' + h(s.note) : 'ไม่มีรูป (wireframe)') + '</span>';
  return '<button type="button" class="card" data-key="s:' + h(r) + '" data-open="' + h(r) + '" data-route="' + h(r) + '">' + th + '<span class="bd" style="display:block"><b>' + h(s.title || s.name) + '</b><span class="rt">' + h(r) + '</span>' +
    '<span class="ds">' + h(s.description) + '</span><span class="badges">' + (navN ? '<span class="badge nav">→ ' + navN + ' ปลายทาง</span>' : '') + (apiN ? '<span class="badge api">API ' + apiN + '</span>' : '') + '</span></span></button>';
}
function journey(name) {
  const j = D.journeys.find(x => x.name === name);
  if (!j) return overview();
  markNav(name);
  const flow = j.cols.length ? '<div class="flow" id="flow"><svg class="links" aria-hidden="true"></svg>' + j.cols.map(c => '<div class="col">' + c.map(card).join('') + '</div>').join('') + '</div>' : '';
  const loose = j.loose.length ? (j.cols.length ? '<h2>หน้าอื่นใน journey นี้ (ไม่มีลูกศรเชื่อม)</h2>' : '') + '<div class="grid">' + j.loose.map(card).join('') + '</div>' : '';
  $('#view').innerHTML = '<h1>' + h(j.name) + '</h1><p>' + h(j.description || '') + '</p>' + flow + loose;
  requestAnimationFrame(drawLinks);
}
function drawLinks() {
  const flow = $('#flow'); if (!flow) return;
  const svg = flow.querySelector('svg'), box = flow.getBoundingClientRect();
  svg.setAttribute('width', flow.scrollWidth); svg.setAttribute('height', flow.scrollHeight);
  let o = '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10" fill="none" style="stroke:var(--accent)"/></marker></defs>';
  for (const e of D.edges) {
    const a = flow.querySelector('.card[data-route="' + CSS.escape(e.from) + '"] .th'), b = flow.querySelector('.card[data-route="' + CSS.escape(e.to) + '"] .th');
    if (!a || !b) continue;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const x1 = ra.right - box.left + flow.scrollLeft, y1 = ra.top + ra.height / 2 - box.top, x2 = rb.left - box.left + flow.scrollLeft, y2 = rb.top + rb.height / 2 - box.top;
    if (x2 <= x1) continue;
    const dx = (x2 - x1) / 2;
    o += '<path marker-end="url(#ah)" d="M' + x1 + ',' + y1 + ' C' + (x1 + dx) + ',' + y1 + ' ' + (x2 - dx) + ',' + y2 + ' ' + x2 + ',' + y2 + '"/>';
    if (e.label) o += '<text x="' + (x1 + 8) + '" y="' + (y1 - 6) + '">' + h(e.label) + (e.more ? ' +' + e.more : '') + '</text>';
  }
  svg.innerHTML = o;
}
function apiTable() {
  markNav('__api');
  const rows = D.apis.map(a =>
    '<tr data-key="a:' + h(a.key) + '" data-api="' + h(a.key) + '"><td><span class="m ' + h(a.method) + '">' + h(a.method) + '</span></td><td class="p" title="' + h(a.path) + '">' + shortPath(a.path) +
    '</td><td>' + a.usedBy.map(r => h(r)).join('<br>') + '</td><td class="src">' + h((a.ex.responseFrom || a.ex.requestFrom || '—').split(' ')[0].replace(':', '')) + '</td></tr>').join('');
  $('#view').innerHTML = '<h1>API</h1><p>' + D.apis.length + ' endpoints · คลิกแถวเพื่อดูตัวอย่าง request/response · ข้อมูลส่วนบุคคลถูกปิดด้วย •</p>' +
    '<table><thead><tr><th>Method</th><th>Path</th><th>ใช้ในหน้า</th><th>ตัวอย่างจาก</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

// ── Drawer ───────────────────────────────────────────────────────────────
function openDrawer(title, html) { $('#dtitle').textContent = title; $('#dbody').innerHTML = html; $('#dbody').scrollTop = 0; $('#drawer').classList.add('open'); $('#scrim').classList.add('show'); }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#scrim').classList.remove('show'); }
function wireframe(s) {
  return '<div class="wf">' + (s.elements.map(e => {
    const l = h(e.label || '');
    return e.kind === 'heading' ? '<div class="h">' + l + '</div>' : e.kind === 'button' ? '<div class="b">' + (l || 'button') + '</div>' :
      e.kind === 'input' ? '<div class="i">' + (l || 'input') + '</div>' : e.kind === 'text' || e.kind === 'link' ? '<div>' + l + '</div>' :
      '<div class="c">' + ({ image: '▣ ', list: '☰ ', loading: '◌ ' }[e.kind] || '⧉ ') + (l || e.kind) + '</div>';
  }).join('') || '<div>ไม่พบ element ใน template</div>') + '</div>';
}
function exampleBlock(label, v, from, type, masked) {
  const src = from ? ' · ' + h(from) : type ? ' · ' + h(type) : '';
  const m = masked && from && !/^type/.test(from) ? ' · ปิดข้อมูลส่วนบุคคลแล้ว' : '';
  return '<h5>' + label + src + m + '</h5><pre>' + (v === undefined ? 'ไม่มีตัวอย่าง' : h(JSON.stringify(v, null, 2))) + '</pre>';
}
function apiDetails(a, open) {
  const req = /^(POST|PUT|PATCH)$/.test(a.method) || a.ex.request !== undefined ? exampleBlock('REQUEST', a.ex.request, a.ex.requestFrom, a.requestType, a.ex.masked) : '';
  return '<details' + (open ? ' open' : '') + '><summary><span class="m ' + h(a.method) + '">' + h(a.method) + '</span> <span class="p">' + shortPath(a.path) + '</span> · <a data-key="a:' + h(a.key) + '" data-api="' + h(a.key) + '">เปิด</a></summary>' + req +
    exampleBlock('RESPONSE', a.ex.response, a.ex.responseFrom, a.responseType, a.ex.masked) + '</details>';
}
function screenDrawer(r) {
  const s = S[r]; if (!s) return;
  const goes = s.goesTo.map(g => {
    const via = g.via && g.via.length ? '<span class="via">' + h(g.via[0]) + (g.via.length > 1 ? ' +' + (g.via.length - 1) : '') + '</span>' : '';
    if (g.target && S[g.target]) return '<li><a data-key="s:' + h(g.target) + '" data-open="' + h(g.target) + '">' + (S[g.target].journey === s.journey ? '→ ' : '↗ ') + h(g.target) + '</a>' +
      (S[g.target].journey !== s.journey ? ' <span class="via">(' + h(S[g.target].journey) + ')</span>' : '') + via + '</li>';
    if (g.kind === 'external') return '<li class="ext">⇱ ' + h(g.raw) + via + '</li>';
    if (g.kind === 'back') return '<li class="exit">← back' + via + '</li>';
    if (g.kind === 'exit') return '<li class="exit">✕ ' + h(String(g.raw).replace(/^this\\./, '')) + via + '</li>';
    return '<li class="unk">? ' + h(g.raw) + via + '</li>';
  }).join('');
  const inbound = Object.values(S).filter(x => x.goesTo.some(g => g.target === r)).map(x => '<li><a data-key="s:' + h(x.route) + '" data-open="' + h(x.route) + '">← ' + h(x.route) + '</a> <span class="via">' + h(x.title || '') + '</span></li>').join('');
  const img = s.img ? '<img class="shot" src="' + s.img + '" alt="รูปหน้าจอ ' + h(r) + '">' : (s.note ? '<div class="note">ไม่มีรูปหน้าจอ — ' + h(s.note) + '</div>' : '') + wireframe(s);
  openDrawer(r,
    '<h3>' + h(s.title || s.name) + '</h3><div class="rt">' + h(r) + '</div><div class="comp">' + h(s.name) + ' · journey <a href="#/j/' + enc(s.journey) + '">' + h(s.journey) + '</a></div>' +
    (s.description ? '<p class="desc">' + h(s.description) + '</p>' : '') + img +
    (goes ? '<h4>ไปต่อที่</h4><ul>' + goes + '</ul>' : '') +
    (inbound ? '<h4>เข้ามาจาก</h4><ul>' + inbound + '</ul>' : '') +
    (s.apis.length ? '<h4>API ที่เรียก (' + s.apis.length + ')</h4>' + s.apis.map(k => apiByKey.get(k)).filter(Boolean).map(a => apiDetails(a, false)).join('') : '') +
    (s.storage.length ? '<h4>Storage</h4><ul>' + s.storage.map(x => '<li>' + h(x) + '</li>').join('') + '</ul>' : '') +
    (s.files.length ? '<h4>ไฟล์ในโค้ด</h4><ul>' + s.files.map(x => '<li class="p">' + h(x) + '</li>').join('') + '</ul>' : ''));
}
function apiDrawer(key) {
  const a = apiByKey.get(key); if (!a) return;
  openDrawer(a.method + ' ' + a.path,
    '<h3><span class="m ' + h(a.method) + '">' + h(a.method) + '</span></h3><div class="p" style="margin:6px 0">' + h(a.path) + '</div>' +
    (a.base ? '<div class="src">base ' + h(a.base) + '</div>' : '') + (a.via ? '<div class="src">เรียกใน ' + h(a.via) + '</div>' : '') +
    '<h4>ใช้ในหน้า</h4><ul>' + a.usedBy.map(r => '<li><a data-key="s:' + h(r) + '" data-open="' + h(r) + '">' + h(r) + '</a> <span class="via">' + h((S[r] || {}).title || '') + '</span></li>').join('') + '</ul>' +
    '<h4>ตัวอย่าง</h4>' + apiDetails(a, true).replace(/ · <a[^>]*>เปิด<\\/a>/, ''));
}

// ── Router: base views swap the page; drawers sit on top of the last base view ──
let baseView = null, lastFrom = null;
function route() {
  const hsh = location.hash || '#/';
  const [, kind, ...rest] = hsh.split('/');
  const arg = decodeURIComponent(rest.join('/'));
  if (kind === 's' || kind === 'a') {
    if (baseView === null) { baseView = kind === 's' && S[arg] ? '#/j/' + enc(S[arg].journey) : kind === 'a' ? '#/api' : '#/'; render(baseView); }
    kind === 's' ? screenDrawer(arg) : apiDrawer(arg);
  } else {
    closeDrawer();
    if (hsh !== baseView) { baseView = hsh; render(hsh); }
    if (lastFrom) { const el = $('#view').querySelector('[data-key="' + CSS.escape(lastFrom) + '"]'); if (el) flash(el); lastFrom = null; }
  }
}
function render(hsh) {
  const [, kind, ...rest] = hsh.split('/');
  const arg = decodeURIComponent(rest.join('/'));
  if (kind === 'j') journey(arg); else if (kind === 'api') apiTable(); else overview();
  window.scrollTo(0, 0);
}
function flash(el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); setTimeout(() => el.classList.remove('flash'), 2600); }
// Closing a drawer returns to the base view and flashes the card that opened it
function closeToBase() { location.hash = baseView || '#/'; }

document.addEventListener('click', e => {
  const open = e.target.closest('[data-open]');
  if (open) { e.preventDefault(); if (!$('#drawer').contains(open)) lastFrom = open.dataset.key || null; location.hash = '#/s/' + enc(open.dataset.open); return; }
  const api = e.target.closest('[data-api]');
  if (api) { e.preventDefault(); if (!$('#drawer').contains(api)) lastFrom = api.dataset.key || null; location.hash = '#/a/' + enc(api.dataset.api); return; }
  const shot = e.target.closest('.shot');
  if (shot) { $('#lightbox img').src = shot.src; $('#lightbox').showModal(); return; }
  if (e.target.closest('dialog')) $('#lightbox').close();
  if (e.target.closest('#nav a') && innerWidth < 860) $('#side').classList.remove('open');
});
$('#scrim').onclick = closeToBase;
$('#dclose').onclick = closeToBase;
$('#dback').onclick = () => history.back();
$('#menu').onclick = () => $('#side').classList.toggle('open');
addEventListener('keydown', e => { if (e.key === 'Escape' && $('#drawer').classList.contains('open') && !$('#lightbox').open) closeToBase(); });
addEventListener('hashchange', route);
addEventListener('resize', () => requestAnimationFrame(drawLinks));

// ── Search ───────────────────────────────────────────────────────────────
const q = $('#q'), res = $('#results');
q.addEventListener('input', () => {
  const v = q.value.trim().toLowerCase();
  if (!v) { res.classList.remove('show'); return; }
  const hitsS = Object.values(S).filter(s => (s.route + ' ' + s.title + ' ' + s.name + ' ' + s.description).toLowerCase().includes(v)).slice(0, 12);
  const hitsA = D.apis.filter(a => a.key.toLowerCase().includes(v)).slice(0, 8);
  res.innerHTML = hitsS.map(s => '<a data-open="' + h(s.route) + '">' + h(s.title || s.name) + '<small>' + h(s.route) + ' · ' + h(s.journey) + '</small></a>').join('') +
    hitsA.map(a => '<a data-api="' + h(a.key) + '"><span class="m ' + h(a.method) + '">' + h(a.method) + '</span> ' + shortPath(a.path) + '<small>API · ใช้ใน ' + a.usedBy.length + ' หน้า</small></a>').join('') ||
    '<a>ไม่พบ</a>';
  res.classList.add('show');
});
document.addEventListener('click', e => { if (!e.target.closest('.search')) res.classList.remove('show'); else if (e.target.closest('.results a')) { res.classList.remove('show'); q.value = ''; } });

// ── Theme ────────────────────────────────────────────────────────────────
const root = document.documentElement;
try { const t = localStorage.getItem('webhld-theme'); if (t) root.dataset.theme = t; } catch {}
$('#theme').onclick = () => {
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('webhld-theme', root.dataset.theme); } catch {}
};

nav(); route();
</script>
</body></html>`;

fs.writeFileSync(out, html);
process.stderr.write(`${screens.length} screens (${screens.filter(s => s.screenshot).length} with screenshots) · ${apis.size} endpoints · wrote ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)\n`);
