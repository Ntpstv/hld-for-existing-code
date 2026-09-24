// HLD for existing code (Figma plugin) — draws a hld-for-existing-code/1 bundle (from scripts/hld-for-existing-code.mjs) as a Figma board:
// one column per screen (header, wireframe, GOES TO, API, storage), screens grouped into journeys and
// laid out left→right in flow order, arrows between neighbouring columns, a diamond where a screen branches.

figma.showUI(__html__, { width: 380, height: 420, title: 'HLD for existing code' });

// ── Palette ────────────────────────────────────────────────────────────────
const C = {
  surface:  { r: 0.13, g: 0.14, b: 0.22 },
  surface2: { r: 0.17, g: 0.18, b: 0.27 },
  paper:    { r: 0.97, g: 0.97, b: 0.99 },
  paperLine:{ r: 0.84, g: 0.86, b: 0.91 },
  ink:      { r: 0.16, g: 0.17, b: 0.22 },
  inkDim:   { r: 0.50, g: 0.52, b: 0.60 },
  border:   { r: 0.24, g: 0.27, b: 0.40 },
  text:     { r: 0.78, g: 0.81, b: 0.87 },
  textDim:  { r: 0.45, g: 0.48, b: 0.58 },
  textHead: { r: 0.91, g: 0.92, b: 0.96 },
  accent:   { r: 0.30, g: 0.56, b: 1.00 },   // navigation
  green:    { r: 0.18, g: 0.83, b: 0.63 },   // API
  amber:    { r: 0.96, g: 0.77, b: 0.09 },   // decision / external
  red:      { r: 0.91, g: 0.34, b: 0.42 },   // exit / back
  pink:     { r: 0.95, g: 0.28, b: 0.60 },   // other journey
  violet:   { r: 0.66, g: 0.52, b: 1.00 },   // storage
};
const solid = (c, a = 1) => [{ type: 'SOLID', color: c, opacity: a }];

// ── Layout ─────────────────────────────────────────────────────────────────
const CARD_W = 300;
const HEADER_H = 58;          // title, route, component
const WIRE_H = 380;           // phone-proportioned wireframe
const PANEL_GAP = 12, PANEL_HEAD_H = 24, PANEL_PAD = 10, ROW_H = 14, API_ROW_H = 42;
const MAX_NAV_ROWS = 10, MAX_API_ROWS = 6, MAX_LIST_ROWS = 6;
const LAYER_GAP = 320, STACK_GAP = 60, SECTION_GAP = 120, MAX_COLS = 5, CARD_GAP = 120, ROW_GAP = 90;
const FANIN_SPACING = 34, BRANCH_STUB = 14, DECISION = 44;
const JOURNEY_COLS = 3, GROUP_PAD = 56, GROUP_GAP = 150, GROUP_LABEL_H = 44;
const TAG = 'hld-for-existing-code';
let MONO = { family: 'Inter', style: 'Regular' };
const API_CARD_W = 560, API_COLS = 3, API_GAP = 40;

const tag = n => { n.setPluginData(TAG, '1'); return n; };
const headOf = new Map();      // screen → height of its header (title, route, component, description)
/** Wireframe height: the screenshot's own proportions when there is one, else a phone-shaped outline. */
const wireH = s => s.screenshot ? Math.max(120, Math.min(900, Math.round(CARD_W * s.screenshot.height / s.screenshot.width))) : WIRE_H;
const truncate = (s, n) => (s = String(s || '')).length > n ? s.slice(0, n - 1) + '…' : s;
function truncatePath(p, max) {
  if (p.length <= max) return p;
  const parts = p.split('/').filter(Boolean);
  let tail = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    const next = '/' + parts[i] + tail;
    if (('…' + next).length > max) break;
    tail = next;
  }
  return tail ? '…' + tail : '…' + p.slice(p.length - (max - 1));
}

async function text(chars, size, color, weight = 'Regular', opts = {}) {
  const t = figma.createText();
  t.fontName = { family: 'Inter', style: weight };
  t.fontSize = size;
  t.characters = chars || ' ';
  t.fills = solid(color, opts.opacity ?? 1);
  if (opts.width) { t.resize(opts.width, t.height); t.textAutoResize = 'HEIGHT'; }
  return t;
}

// ── Entry ──────────────────────────────────────────────────────────────────
figma.ui.onmessage = async (msg) => {
  if (msg.type !== 'generate') return;
  try {
    await Promise.all([
      figma.loadFontAsync({ family: 'Inter', style: 'Regular' }),
      figma.loadFontAsync({ family: 'Inter', style: 'Semi Bold' }),
    ]);
    // JSON reads best monospaced; fall back to Inter where Roboto Mono is unavailable
    MONO = await figma.loadFontAsync({ family: 'Roboto Mono', style: 'Regular' })
      .then(() => ({ family: 'Roboto Mono', style: 'Regular' }))
      .catch(() => ({ family: 'Inter', style: 'Regular' }));
    const detail = await generate(msg.bundle);
    figma.ui.postMessage({ type: 'done', detail });
  } catch (e) {
    figma.ui.postMessage({ type: 'error', detail: String(e && e.stack || e) });
  }
};

async function generate(bundle) {
  // Re-running replaces the previous board; anything drawn by hand stays.
  for (const n of figma.currentPage.children.slice()) if (n.getPluginData(TAG) === '1') n.remove();

  const screens = bundle.screens;
  const byRoute = new Map(screens.map(s => [s.route, s]));

  // ── API page first: screen cards link to its endpoint cards ──────────────
  const api = await buildApiPage(bundle);

  // ── Journeys and the navigation graph ────────────────────────────────────
  const journeys = new Map();
  for (const s of screens) {
    if (!journeys.has(s.journey)) journeys.set(s.journey, []);
    journeys.get(s.journey).push(s);
  }
  const edges = new Map();                 // "a->b" → { from, to, actions }
  for (const s of screens) {
    for (const g of s.goesTo || []) {
      const t = g.target && byRoute.get(g.target);
      if (!t || t === s || t.journey !== s.journey) continue;
      // Angular ngOnInit navigations are guards bouncing back (missing state) — not the flow forward.
      // They stay in GOES TO but would otherwise put a child screen ahead of its parent.
      if ((g.via || []).length && g.via.every(v => v === 'on init')) continue;
      const k = `${s.route}->${t.route}`;
      if (!edges.has(k)) edges.set(k, { from: s, to: t, actions: [] });
      for (const a of g.via || []) if (!edges.get(k).actions.includes(a)) edges.get(k).actions.push(a);
    }
  }

  // ── Build every screen first: descriptions make heights uneven, so layout uses measured sizes ──
  const nodeOf = new Map();
  const linkRows = [];
  for (const s of screens) {
    const node = await buildScreen(s, byRoute, linkRows, api.cardOf);
    tag(node);
    nodeOf.set(s, node);
  }
  const heightOf = s => nodeOf.get(s).height;
  const journeyDesc = new Map((bundle.journeys || []).filter(j => j.description).map(j => [j.name, j.description]));

  // ── Layout each journey, then pack journeys into columns ─────────────────
  const layouts = [];
  for (const [name, list] of journeys) {
    const l = { name, ...layoutJourney(list, edges, heightOf) };
    if (journeyDesc.has(name)) {
      l.desc = await text(journeyDesc.get(name), 14, C.text, 'Regular', { width: Math.max(CARD_W, Math.min(l.w, 1100)) });
      l.descH = l.desc.height + 24;
    } else l.descH = 0;
    layouts.push(l);
  }
  layouts.sort((a, b) => b.h - a.h);
  const colCount = Math.max(1, Math.min(JOURNEY_COLS, layouts.length));
  const colWidth = Math.max(...layouts.map(l => l.w)) + GROUP_PAD * 2 + GROUP_GAP;
  const colHeights = new Array(colCount).fill(0);
  const TITLE_H = 120;

  const bounds = [];
  let lines = 0, decisions = 0;

  for (const l of layouts) {
    let c = 0;
    for (let i = 1; i < colCount; i++) if (colHeights[i] < colHeights[c]) c = i;
    const ox = c * colWidth + GROUP_PAD;
    const oy = TITLE_H + colHeights[c] + GROUP_PAD + GROUP_LABEL_H + l.descH;
    if (l.desc) { l.desc.x = ox; l.desc.y = oy - l.descH; tag(l.desc); figma.currentPage.appendChild(l.desc); }

    for (const [s, p] of l.pos) {
      const node = nodeOf.get(s);
      node.x = ox + p.x; node.y = oy + p.y;
      figma.currentPage.appendChild(node);
    }

    // connectors: neighbouring columns only; a diamond when one screen fans out to several
    const inbound = new Map();
    for (const [f, ts] of l.fwd) for (const t of ts) {
      if (!inbound.has(t)) inbound.set(t, []);
      inbound.get(t).push(f);
    }
    const midY = s => headOf.get(s) + wireH(s) / 2;
    const out = s => { const p = l.pos.get(s); return { x: ox + p.x + CARD_W, y: oy + p.y + midY(s) }; };
    const into = (s, from) => {
      const p = l.pos.get(s), srcs = inbound.get(s) || [from];
      const i = Math.max(0, srcs.indexOf(from)), n = srcs.length;
      return { x: ox + p.x, y: oy + p.y + midY(s) + (i - (n - 1) / 2) * FANIN_SPACING };
    };
    for (const [from, all] of l.fwd) {
      const col = l.pos.get(from).col;
      const targets = all.filter(t => l.pos.get(t).col === col + 1);
      if (!targets.length) continue;
      const start = out(from);
      if (targets.length === 1) {
        const end = into(targets[0], from), bend = end.x - LAYER_GAP / 2;
        addLine(elbow(start, end, bend, C.accent), `${from.route} → ${targets[0].route}`); lines++;
        await label(edges.get(`${from.route}->${targets[0].route}`), bend, end);
        continue;
      }
      const cx = start.x + LAYER_GAP / 2, cy = start.y;
      const d = await diamond(cx, cy, targets.length);
      d.name = `decision: ${from.route}`; tag(d); figma.currentPage.appendChild(d); decisions++;
      addLine(elbow(start, { x: cx - DECISION / 2, y: cy }, start.x, C.accent), `${from.route} → decision`); lines++;
      for (const t of targets) {
        const end = into(t, from), bend = cx + DECISION / 2 + BRANCH_STUB;
        addLine(elbow({ x: cx + DECISION / 2, y: cy }, end, bend, C.accent), `${from.route} → ${t.route}`); lines++;
        await label(edges.get(`${from.route}->${t.route}`), bend, end);
      }
    }
    colHeights[c] += l.h + GROUP_PAD * 2 + GROUP_LABEL_H + l.descH + GROUP_GAP;
    bounds.push({ name: l.name, x: ox, y: oy - l.descH, w: l.w, h: l.h + l.descH });
  }

  // GOES TO rows become links to the screen they name
  let links = 0;
  for (const { node, target } of linkRows) {
    const dest = nodeOf.get(target);
    if (!dest) continue;
    node.hyperlink = { type: 'NODE', value: dest.id };
    node.textDecoration = 'UNDERLINE';
    links++;
  }

  // Journey boxes go to the bottom of the z-order, label first so the box does not cover it
  for (const b of bounds) {
    const box = figma.createRectangle();
    box.name = `journey: ${b.name}`;
    box.x = b.x - GROUP_PAD; box.y = b.y - GROUP_PAD;
    box.resize(b.w + GROUP_PAD * 2, b.h + GROUP_PAD * 2);
    box.fills = solid(C.surface, 0.35); box.strokes = solid(C.border); box.strokeWeight = 2;
    box.dashPattern = [10, 8]; box.cornerRadius = 16;
    const t = await text(b.name, 22, C.textHead, 'Semi Bold', { opacity: 0.9 });
    t.x = b.x - GROUP_PAD + 12; t.y = b.y - GROUP_PAD - GROUP_LABEL_H + 6;
    tag(box); tag(t);
    figma.currentPage.insertChild(0, t);
    figma.currentPage.insertChild(0, box);
  }

  // Board title
  const title = await text(`${bundle.project} — ${bundle.framework}`, 36, C.textHead, 'Semi Bold');
  title.x = 0; title.y = 0; tag(title); figma.currentPage.appendChild(title);
  const sub = await text(`${screens.length} screens · ${journeys.size} journeys · generated ${String(bundle.generatedAt || '').slice(0, 10)} by HLD for existing code`, 14, C.textDim);
  sub.x = 0; sub.y = 52; tag(sub); figma.currentPage.appendChild(sub);

  // endpoint cards link back to the screens that call them
  for (const { node, screen } of api.usedByRows) {
    const dest = nodeOf.get(screen);
    if (dest) { node.hyperlink = { type: 'NODE', value: dest.id }; node.textDecoration = 'UNDERLINE'; links++; }
  }

  figma.viewport.scrollAndZoomIntoView([title, ...nodeOf.values()]);
  return `${screens.length} screens · ${journeys.size} journeys · ${decisions} decisions · ${lines} lines · ${links} links`;
}

function addLine(v, name) { v.name = name; tag(v); figma.currentPage.appendChild(v); }

// ── Journey layout: layer screens by flow depth (loops broken at their return edge) ──
function layoutJourney(list, edges, heightOf) {
  const inJ = new Set(list);
  const outE = new Map(list.map(s => [s, []]));
  for (const { from, to } of edges.values()) {
    if (inJ.has(from) && inJ.has(to) && !outE.get(from).includes(to)) outE.get(from).push(to);
  }
  const fwd = new Map(list.map(s => [s, []]));
  const state = new Map();
  const indeg = new Map(list.map(s => [s, 0]));
  for (const ts of outE.values()) for (const t of ts) indeg.set(t, indeg.get(t) + 1);
  const visit = s => {
    state.set(s, 1);
    for (const t of outE.get(s)) {
      if (state.get(t) === 1) continue;             // back edge closes a loop: not drawn as a column hop
      fwd.get(s).push(t);
      if (!state.get(t)) visit(t);
    }
    state.set(s, 2);
  };
  // Shallowest route first, then fewest inbound links: `/assessment` leads `/assessment/profile` even
  // when the child's ngOnInit guard redirects back, so loops break at the return edge.
  const depth = s => s.route.split('/').filter(Boolean).length;
  const order = [...list].sort((a, b) => depth(a) - depth(b) || indeg.get(a) - indeg.get(b) || a.route.localeCompare(b.route));
  for (const s of order) if (!state.get(s)) visit(s);

  const layer = new Map(list.map(s => [s, 0]));
  const fin = new Map(list.map(s => [s, 0]));
  for (const ts of fwd.values()) for (const t of ts) fin.set(t, fin.get(t) + 1);
  const queue = list.filter(s => fin.get(s) === 0);
  while (queue.length) {
    const s = queue.shift();
    for (const t of fwd.get(s)) {
      layer.set(t, Math.max(layer.get(t), layer.get(s) + 1));
      fin.set(t, fin.get(t) - 1);
      if (fin.get(t) === 0) queue.push(t);
    }
  }
  const linked = new Set();
  for (const [s, ts] of fwd) if (ts.length) { linked.add(s); ts.forEach(t => linked.add(t)); }
  const columns = [];
  for (const s of order) if (linked.has(s)) (columns[layer.get(s)] = columns[layer.get(s)] || []).push(s);
  const rank = new Map();
  columns.forEach((col, L) => {
    if (L > 0) {
      const pr = s => {
        const ps = list.filter(p => fwd.get(p).includes(s) && rank.has(p)).map(p => rank.get(p));
        return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 1e9;
      };
      col.sort((a, b) => pr(a) - pr(b));
    }
    col.forEach((s, i) => rank.set(s, i));
  });

  const pos = new Map();
  let flowBottom = 0;
  columns.forEach((col, L) => {
    let y = 0;
    for (const s of col || []) { const h = heightOf(s); pos.set(s, { x: L * (CARD_W + LAYER_GAP), y, col: L }); y += h + STACK_GAP; }
    flowBottom = Math.max(flowBottom, y - STACK_GAP);
  });
  const loose = order.filter(s => !linked.has(s));
  let y = columns.length ? flowBottom + SECTION_GAP : 0, rowH = 0;
  loose.forEach((s, i) => {
    if (i > 0 && i % MAX_COLS === 0) { y += rowH + ROW_GAP; rowH = 0; }
    pos.set(s, { x: (i % MAX_COLS) * (CARD_W + CARD_GAP), y, col: -1 });
    rowH = Math.max(rowH, heightOf(s));
  });
  let w = 0;
  for (const p of pos.values()) w = Math.max(w, p.x + CARD_W);
  const h = Math.max(loose.length ? y + rowH : flowBottom, HEADER_H + WIRE_H);
  return { pos, fwd, w, h };
}

function panelRows(n, max) { return n === 0 ? 0 : Math.min(n, max) + (n > max ? 1 : 0); }

// ── One screen: header + wireframe + panels, as a single node ──────────────
async function buildScreen(s, byRoute, linkRows, cardOf) {
  const g = figma.createFrame();
  g.name = `${s.journey} · ${s.route}`;
  g.fills = []; g.clipsContent = false;

  const title = await text(truncate(s.title || s.name, 34), 14, s.title ? C.textHead : C.textDim, 'Semi Bold');
  title.x = 2; title.y = 0; g.appendChild(title);
  const route = await text(truncate(s.route, 44), 11, C.accent, 'Semi Bold');
  route.x = 2; route.y = 22; g.appendChild(route);
  const comp = await text(truncate(s.name, 48), 9, C.textDim);
  comp.x = 2; comp.y = 40; g.appendChild(comp);

  // What the screen is for — written from the source, merged in by scripts/annotate.mjs
  let head = HEADER_H;
  if (s.description) {
    const d = await text(s.description, 11, C.text, 'Regular', { width: CARD_W - 4 });
    d.x = 2; d.y = HEADER_H; d.name = 'description'; g.appendChild(d);
    head = HEADER_H + d.height + 12;
  }
  headOf.set(s, head);

  const wire = await buildWireframe(s);
  wire.y = head; g.appendChild(wire);

  let y = head + wireH(s) + PANEL_GAP;
  const place = p => { if (!p) return; p.y = y; g.appendChild(p); y += p.height + PANEL_GAP; };
  place(await buildGoesTo(s, byRoute, linkRows));
  place(await buildApis(s.apis || [], cardOf));
  place(await buildList('STORAGE', s.storage || [], C.violet));
  g.resize(CARD_W, y - PANEL_GAP);
  return g;
}

const EL_H = { heading: 24, text: 18, button: 34, input: 34, link: 18, image: 64, list: 60, loading: 34, component: 40 };

async function buildWireframe(s) {
  if (s.screenshot) return buildScreenshot(s);
  const f = figma.createFrame();
  f.name = 'wireframe';
  f.resize(CARD_W, WIRE_H);
  f.fills = solid(C.paper); f.strokes = solid(C.border); f.strokeWeight = 1; f.cornerRadius = 14; f.clipsContent = true;

  const bar = figma.createFrame();
  bar.resize(CARD_W, 30); bar.fills = solid(C.paperLine, 0.6);
  f.appendChild(bar);
  const url = await text(truncate(s.route, 46), 9, C.inkDim);
  url.x = 12; url.y = 9; bar.appendChild(url);

  const inner = CARD_W - 32;
  let y = 42;
  const els = s.elements || [];
  let shown = 0;
  for (const e of els) {
    const h = EL_H[e.kind] || 20;
    if (y + h > WIRE_H - 26) break;
    const node = await buildElement(e, inner, h);
    node.x = 16; node.y = y; f.appendChild(node);
    y += h + 8; shown++;
  }
  if (!els.length) {
    const t = await text('no UI elements found', 10, C.inkDim); t.x = 16; t.y = 46; f.appendChild(t);
  } else if (shown < els.length) {
    const t = await text(`+${els.length - shown} more`, 9, C.inkDim); t.x = 16; t.y = WIRE_H - 20; f.appendChild(t);
  }
  if (s.captureNote) {                      // screenshot was attempted but would have shown another page
    const t = await text(truncate(`outline only — ${s.captureNote}`, 52), 8, C.red); t.x = 16; t.y = WIRE_H - 34; f.appendChild(t);
  }
  return f;
}

/** The real page, captured by scripts/capture.mjs, as an image fill. */
async function buildScreenshot(s) {
  const f = figma.createFrame();
  f.name = `screenshot ${s.screenshot.url || s.route}`;
  f.resize(CARD_W, wireH(s));
  f.strokes = solid(C.border); f.strokeWeight = 1; f.cornerRadius = 10; f.clipsContent = true;
  const img = figma.createImage(figma.base64Decode(s.screenshot.data));
  f.fills = [{ type: 'IMAGE', imageHash: img.hash, scaleMode: 'FILL' }];
  return f;
}

async function buildElement(e, w, h) {
  const box = figma.createFrame();
  box.name = `${e.kind}${e.label ? ': ' + e.label : ''}`;
  box.resize(w, h); box.fills = [];
  const lbl = e.label || '';
  const add = n => { box.appendChild(n); return n; };
  if (e.kind === 'heading') {
    add(await text(truncate(lbl, 30), 15, C.ink, 'Semi Bold'));
  } else if (e.kind === 'text') {
    add(await text(truncate(lbl, 48), 11, C.inkDim));
  } else if (e.kind === 'link') {
    const t = add(await text(truncate(lbl, 44), 11, C.accent)); t.textDecoration = 'UNDERLINE';
  } else if (e.kind === 'button') {
    box.fills = solid(C.accent); box.cornerRadius = 8;
    const t = add(await text(truncate(lbl || 'button', 34), 11, { r: 1, g: 1, b: 1 }, 'Semi Bold'));
    t.x = Math.max(8, (w - t.width) / 2); t.y = (h - t.height) / 2;
  } else if (e.kind === 'input') {
    box.fills = solid({ r: 1, g: 1, b: 1 }); box.strokes = solid(C.paperLine); box.strokeWeight = 1; box.cornerRadius = 6;
    const t = add(await text(truncate(lbl || 'input', 40), 10, C.inkDim)); t.x = 10; t.y = (h - t.height) / 2;
  } else if (e.kind === 'image') {
    box.fills = solid(C.paperLine, 0.7); box.cornerRadius = 8;
    const t = add(await text(truncate(lbl ? `▣ ${lbl}` : '▣ image', 40), 10, C.inkDim)); t.x = 10; t.y = (h - t.height) / 2;
  } else if (e.kind === 'list') {
    for (let i = 0; i < 3; i++) {
      const r = figma.createRectangle(); r.resize(w, 16); r.y = i * 22; r.cornerRadius = 4;
      r.fills = solid(C.paperLine, 0.8 - i * 0.2); box.appendChild(r);
    }
    if (lbl) { const t = add(await text(truncate(lbl, 40), 9, C.inkDim)); t.x = 6; t.y = 2; }
  } else if (e.kind === 'loading') {
    const r = figma.createEllipse(); r.resize(22, 22); r.x = (w - 22) / 2; r.y = 6;
    r.fills = []; r.strokes = solid(C.accent); r.strokeWeight = 3; r.dashPattern = [10, 6]; box.appendChild(r);
  } else {
    box.fills = solid(C.paperLine, 0.35); box.strokes = solid(C.paperLine); box.dashPattern = [4, 3]; box.cornerRadius = 6;
    const t = add(await text(truncate(`⧉ ${lbl || 'component'}`, 42), 10, C.inkDim)); t.x = 10; t.y = (h - t.height) / 2;
  }
  return box;
}

function panel(name, height, accent) {
  const f = figma.createFrame();
  f.name = name;
  f.resize(CARD_W, height);
  f.fills = solid(accent, 0.08); f.strokes = solid(accent, 0.7); f.strokeWeight = 1; f.cornerRadius = 8;
  return f;
}

async function panelHead(f, label, accent) {
  const h = await text(label, 8, accent, 'Semi Bold');
  h.letterSpacing = { unit: 'PIXELS', value: 0.6 };
  h.x = 10; h.y = 8; f.appendChild(h);
}

async function buildGoesTo(s, byRoute, linkRows) {
  const rows = (s.goesTo || []).map(g => {
    const t = g.target && byRoute.get(g.target);
    const via = (g.via || [])[0] ? `  · ${g.via[0]}${g.via.length > 1 ? ` +${g.via.length - 1}` : ''}` : '';
    if (t && t.journey === s.journey) return { text: `→ ${g.target}${via}`, color: C.accent, target: t };
    if (t) return { text: `↗ ${g.target} (${t.journey})${via}`, color: C.pink, target: t };
    if (g.kind === 'external') return { text: `⇱ ${g.raw}${via}`, color: C.amber };
    if (g.kind === 'back') return { text: `← back${via}`, color: C.red };
    if (g.kind === 'exit') return { text: `✕ ${g.raw.replace(/^this\./, '')}${via}`, color: C.red };
    return { text: `? ${g.raw}${via}`, color: C.textDim };
  });
  if (!rows.length) return null;
  const shown = rows.slice(0, MAX_NAV_ROWS);
  const n = panelRows(rows.length, MAX_NAV_ROWS);
  const f = panel('GOES TO', PANEL_HEAD_H + n * ROW_H + PANEL_PAD, C.accent);
  await panelHead(f, 'GOES TO', C.accent);
  for (let i = 0; i < shown.length; i++) {
    const t = await text(truncate(shown[i].text, 52), 9, shown[i].color);
    t.x = 10; t.y = PANEL_HEAD_H + i * ROW_H; f.appendChild(t);
    if (shown[i].target) linkRows.push({ node: t, target: shown[i].target });
  }
  if (rows.length > MAX_NAV_ROWS) {
    const t = await text(`+${rows.length - MAX_NAV_ROWS} more`, 9, C.textDim);
    t.x = 10; t.y = PANEL_HEAD_H + MAX_NAV_ROWS * ROW_H; f.appendChild(t);
  }
  return f;
}

async function buildApis(apis, cardOf) {
  if (!apis.length) return null;
  const shown = apis.slice(0, MAX_API_ROWS);
  const more = apis.length > MAX_API_ROWS;
  const f = panel('API', PANEL_HEAD_H + shown.length * API_ROW_H + PANEL_PAD + (more ? ROW_H : 0), C.green);
  await panelHead(f, 'API', C.green);
  for (let i = 0; i < shown.length; i++) {
    const e = shown[i], top = PANEL_HEAD_H + i * API_ROW_H;
    const line = await text(`${e.method}  ${truncatePath(e.path, 44 - e.method.length)}`, 9, C.green, 'Semi Bold');
    line.x = 10; line.y = top; line.name = `${e.method} ${e.base}${e.path}  (${e.via})`; f.appendChild(line);
    const card = cardOf && cardOf.get(`${e.method} ${e.path}`);
    if (card) { line.hyperlink = { type: 'NODE', value: card.id }; line.textDecoration = 'UNDERLINE'; }
    const rows = [
      ['req ', e.requestFields, e.requestType],
      ['resp', e.responseFields, e.responseType],
    ];
    for (let j = 0; j < 2; j++) {
      const [lab, fields, type] = rows[j];
      const body = (fields || []).length ? fields.join(', ') : (type || '—');
      const t = await text(`${lab}  ${truncate(body, 50)}`, 8, C.textDim);
      t.x = 16; t.y = top + 13 + j * 11; f.appendChild(t);
    }
  }
  if (more) {
    const t = await text(`+${apis.length - MAX_API_ROWS} more`, 9, C.textDim);
    t.x = 10; t.y = PANEL_HEAD_H + shown.length * API_ROW_H; f.appendChild(t);
  }
  return f;
}

async function buildList(label, items, accent) {
  if (!items.length) return null;
  const n = panelRows(items.length, MAX_LIST_ROWS);
  const f = panel(label, PANEL_HEAD_H + n * ROW_H + PANEL_PAD, accent);
  await panelHead(f, label, accent);
  for (let i = 0; i < Math.min(items.length, MAX_LIST_ROWS); i++) {
    const t = await text(truncate(items[i], 52), 9, C.text);
    t.x = 10; t.y = PANEL_HEAD_H + i * ROW_H; f.appendChild(t);
  }
  if (items.length > MAX_LIST_ROWS) {
    const t = await text(`+${items.length - MAX_LIST_ROWS} more`, 9, C.textDim);
    t.x = 10; t.y = PANEL_HEAD_H + MAX_LIST_ROWS * ROW_H; f.appendChild(t);
  }
  return f;
}

// ── Connectors ─────────────────────────────────────────────────────────────
function elbow(a, b, bendX, color) {
  const pts = [a, { x: bendX, y: a.y }, { x: bendX, y: b.y }, b];
  const minX = Math.min(...pts.map(p => p.x)), minY = Math.min(...pts.map(p => p.y));
  const v = figma.createVector();
  v.x = minX; v.y = minY;
  v.fills = []; v.strokes = solid(color); v.strokeWeight = 2;
  v.vectorNetwork = {
    vertices: pts.map((p, i) => ({
      x: p.x - minX, y: p.y - minY,
      strokeCap: i === pts.length - 1 ? 'ARROW_LINES' : 'NONE',
      strokeJoin: 'ROUND', cornerRadius: 0, handleMirroring: 'NONE',
    })),
    segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }],
    regions: [],
  };
  return v;
}

async function label(edge, fromX, end) {
  if (!edge || !edge.actions.length) return;
  const room = Math.max(8, Math.floor((end.x - fromX - 12) / 5.4));
  const more = edge.actions.length - 1;
  const t = await text(truncate(edge.actions[0], room - (more ? 3 : 0)) + (more ? ` +${more}` : ''), 9, C.text);
  t.x = fromX + 6; t.y = end.y - 15;
  t.name = `action: ${edge.actions.join(', ')}`;
  tag(t); figma.currentPage.appendChild(t);
}

async function diamond(cx, cy, branches) {
  const d = figma.createVector();
  d.x = cx - DECISION / 2; d.y = cy - DECISION / 2;
  d.vectorPaths = [{ windingRule: 'NONZERO', data: `M ${DECISION / 2} 0 L ${DECISION} ${DECISION / 2} L ${DECISION / 2} ${DECISION} L 0 ${DECISION / 2} Z` }];
  d.fills = solid(C.amber, 0.18); d.strokes = solid(C.amber); d.strokeWeight = 2;
  const t = await text(String(branches), 10, C.amber, 'Semi Bold');
  t.x = cx - 4; t.y = cy - 7;
  return figma.group([d, t], figma.currentPage);
}


// ── API page: one card per endpoint with example request/response ──────────
async function buildApiPage(bundle) {
  const cardOf = new Map();
  const usedByRows = [];
  const endpoints = new Map();
  for (const s of bundle.screens) for (const a of s.apis || []) {
    const key = `${a.method} ${a.path}`;
    if (!endpoints.has(key)) endpoints.set(key, { ...a, key, usedBy: [] });
    if (!endpoints.get(key).usedBy.includes(s)) endpoints.get(key).usedBy.push(s);
  }
  if (!endpoints.size) return { cardOf, usedByRows };

  let page = figma.root.children.find(p => p.getPluginData(TAG) === 'api-page');
  if (!page) { page = figma.createPage(); page.setPluginData(TAG, 'api-page'); }
  if (page.loadAsync) await page.loadAsync();
  page.name = `API · ${bundle.project}`;
  for (const n of page.children.slice()) if (n.getPluginData(TAG) === '1') n.remove();

  const title = await text(`${bundle.project} — API (${endpoints.size} endpoints)`, 36, C.textHead, 'Semi Bold');
  tag(title); page.appendChild(title);
  const note = await text('Examples: captured = real traffic while capturing screens · stub = mock server file · type = skeleton from the TypeScript model. Personal data (names, ID/phone numbers, emails, addresses, tokens) is masked with •. Arrays trimmed to 2 items.', 13, C.textDim, 'Regular', { width: API_CARD_W * API_COLS + API_GAP * (API_COLS - 1) });
  note.y = 52; tag(note); page.appendChild(note);

  const colY = new Array(API_COLS).fill(52 + note.height + 40);
  const examples = bundle.apiExamples || {};
  const sorted = [...endpoints.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  for (const e of sorted) {
    const card = await buildApiCard(e, examples[e.key] || {}, usedByRows);
    let c = 0;
    for (let i = 1; i < API_COLS; i++) if (colY[i] < colY[c]) c = i;
    card.x = c * (API_CARD_W + API_GAP); card.y = colY[c];
    colY[c] += card.height + API_GAP;
    tag(card); page.appendChild(card);
    cardOf.set(e.key, card);
  }
  return { cardOf, usedByRows };
}

async function buildApiCard(e, exRaw, usedByRows) {
  const ex = { ...exRaw };
  for (const f of ['request', 'response']) {
    if (ex[f] === undefined || /^(type|fields)/.test(ex[`${f}From`] || '')) continue;
    const [r, m] = redact(ex[f]); ex[f] = r; ex.masked = ex.masked || m;
  }
  const f = figma.createFrame();
  f.name = e.key;
  f.fills = solid(C.surface); f.strokes = solid(C.green, 0.7); f.strokeWeight = 1; f.cornerRadius = 10;
  f.clipsContent = false;
  const inner = API_CARD_W - 32;
  let y = 16;
  const add = (n, gap = 6) => { n.x = 16; n.y = y; f.appendChild(n); y += n.height + gap; return n; };

  add(await text(`${e.method}  ${e.path}`, 13, C.green, 'Semi Bold', { width: inner }), 4);
  if (e.base) add(await text(`base ${e.base}`, 10, C.textDim, 'Regular', { width: inner }), 4);
  if (e.via) add(await text(`called in ${e.via}`, 10, C.textDim, 'Regular', { width: inner }), 8);
  add(await text('USED BY', 8, C.accent, 'Semi Bold'), 4);
  for (const s of e.usedBy.slice(0, 8)) {
    const row = add(await text(`→ ${s.route}${s.title ? '  ' + s.title : ''}`, 10, C.accent, 'Regular', { width: inner }), 2);
    usedByRows.push({ node: row, screen: s });
  }
  if (e.usedBy.length > 8) add(await text(`+${e.usedBy.length - 8} more`, 10, C.textDim), 2);
  y += 10;

  const section = async (label, value, from, typeName) => {
    add(await text(`${label}${from ? '  ·  ' + from : typeName ? '  ·  ' + typeName : ''}${ex.masked && from && !/^type/.test(from) ? '  ·  personal data masked' : ''}`, 8, C.green, 'Semi Bold', { width: inner }), 4);
    if (value === undefined) { add(await text('no example found', 10, C.textDim), 12); return; }
    let json = JSON.stringify(value, null, 2);
    if (json.length > 3500) json = json.slice(0, 3500) + '\n… (trimmed)';
    const box = figma.createFrame();
    box.fills = solid(C.surface2); box.cornerRadius = 6;
    const t = figma.createText();
    t.fontName = MONO; t.fontSize = 10; t.characters = json; t.fills = solid(C.text);
    t.x = 10; t.y = 8;
    t.resize(inner - 20, t.height); t.textAutoResize = 'HEIGHT';
    box.resize(inner, t.height + 16); box.appendChild(t);
    add(box, 14);
  };
  if (/^(POST|PUT|PATCH)$/.test(e.method) || ex.request !== undefined) await section('REQUEST', ex.request, ex.requestFrom, e.requestType);
  await section('RESPONSE', ex.response, ex.responseFrom, e.responseType);
  f.resize(API_CARD_W, y + 4);
  return f;
}


// Same masking as scripts/lib/sample.mjs, applied again when drawing: a bundle made by an older version or
// restored from an old copy must not put raw personal data on the board.
// ── Personal data ───────────────────────────────────────────────────────────
// Examples end up on a shared Figma board. Captured traffic (and stub files copied from production) can hold
// real people's data, so values are masked by key name and by shape before they are stored.
// Matched against the end of the key, so `secondaryMobileNo`, `staffName`, `careTakerFirstName` are caught too
const SENSITIVE_KEY = /(identifier|citizen(id|no)?|nationalid|idcard(no)?|passport(no)?|taxid|mobile(no|number)?|phone(no|number)?|telno|e?mail(address)?|address(detail)?|postcode|zipcode|(first|last|middle|full|given|family|sur|staff|customer|patient|member|user|officer|person|contact|owner|caretaker|caregiver)name|birth(date|day)?|dateofbirth|dob|token|authorization|password|passcode|otp|secret|sessionid|cookie|account(no|number)|card(no|number)|key|apikey|secret(key)?|signature|credential(s)?|(register|created|updated|modified|approved|assigned|requested|recorded|submitted|checked|verified)by(name)?|staff|officer|doctor|nurse|caretaker|guardian)$|^(cid|auth|moo|soi|road|street|pin)$/i;
const THAI_ID = /\b\d[- ]?\d{4}[- ]?\d{5}[- ]?\d{2}[- ]?\d\b/g;          // 13-digit citizen ID, with or without dashes
const PHONE = /(?<!\d)(\+?66|0)[- ]?\d{1,2}[- ]?\d{3}[- ]?\d{3,4}(?!\d)/g;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g;

function maskString(s) {
  if (!s) return s;
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 8 && digits.length === s.replace(/[\s-]/g, '').length) return '•'.repeat(digits.length - 4) + digits.slice(-4);
  return s.length <= 2 ? '••' : s[0] + '•'.repeat(Math.min(s.length - 1, 6));
}

/** Masks personal data. Returns [value, changed]. */
function redact(v, key = '') {
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map(x => { const [y, c] = redact(x, key); changed = changed || c; return y; });
    return [out, changed];
  }
  if (v && typeof v === 'object') {
    let changed = false;
    const out = {};
    for (const [k, x] of Object.entries(v)) { const [y, c] = redact(x, k); out[k] = y; changed = changed || c; }
    return [out, changed];
  }
  if (typeof v === 'string') {
    if (SENSITIVE_KEY.test(key) && v && !/^(null|undefined|-)$/.test(v)) return [maskString(v), true];
    const out = v.replace(JWT, '•••jwt•••').replace(EMAIL, m => maskString(m)).replace(THAI_ID, m => maskString(m)).replace(PHONE, m => maskString(m));
    return [out, out !== v];
  }
  if (typeof v === 'number' && SENSITIVE_KEY.test(key)) return [0, true];
  return [v, false];
}
