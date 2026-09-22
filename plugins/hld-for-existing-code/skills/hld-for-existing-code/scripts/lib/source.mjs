// Low-level source reading: file walking, comment stripping, bracket matching, function extraction.
// Regex + bracket counting, not a real TS parser — fast and dependency-free, fooled only by unusual formatting.
import fs from 'node:fs';
import path from 'node:path';

export const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '.angular',
  '.turbo', '.vercel', '.nx', '.cache', 'storybook-static', 'e2e', 'cypress', 'playwright',
  'playwright-report', 'test-results', 'reports', 'allure-results', 'allure-report', 'tmp', 'temp',
]);

export const CODE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];

export function walk(dir, exts, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, exts, out); }
    else if (exts.some(x => e.name.endsWith(x)) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Bundled or third-party code: hashed/minified file names, vendor folders, very long lines. */
export function isGeneratedFile(f) {
  if (/[\\/](public|static|vendor|vendors|third[-_]?party|lib[\\/]js)[\\/]/i.test(f)) return true;
  if (/\.(min|bundle|chunk)\.[cm]?js$|[.-][A-Za-z0-9_]{8,}\.[cm]?js$/.test(f)) return true;
  if (/(^|[\\/])[\w.-]+\.config\.[cm]?[jt]s$/.test(f)) return true;
  const s = readRaw(f);
  if (s.length > 400_000) return true;
  let longest = 0, start = 0;
  for (let i = 0; i <= s.length && i < 200_000; i++) {
    if (i === s.length || s.charCodeAt(i) === 10) { longest = Math.max(longest, i - start); start = i + 1; }
  }
  return longest > 1500;
}

export function isTestFile(f) {
  return /\.(spec|test|stories|story|mock|mocks)\.[jt]sx?$/.test(f) || /[\\/](__tests__|__mocks__|__snapshots__|testUtils|test-utils|testing)[\\/]/.test(f);
}

const rawCache = new Map();
const codeCache = new Map();

export function readRaw(file) {
  if (!rawCache.has(file)) {
    let s = '';
    try { s = fs.readFileSync(file, 'utf8'); } catch { /* missing file reads as empty */ }
    rawCache.set(file, s);
  }
  return rawCache.get(file);
}

/** Source with comments removed (strings kept), cached. */
export function read(file) {
  if (!codeCache.has(file)) codeCache.set(file, stripComments(readRaw(file)));
  return codeCache.get(file);
}

// A quote opens a string only where an expression can start. Inside JSX text (`Don't`) the
// character before is a letter, so the apostrophe is left alone instead of swallowing the file.
const EXPR_START = /[\s(,=:[!&|?{};+\-*/%<>~^]/;
function quoteOpensString(src, i) {
  let j = i - 1;
  while (j >= 0 && (src[j] === ' ' || src[j] === '\t')) j--;
  if (j < 0) return true;
  if (src[j] === '\n' || src[j] === '\r') return true;
  if (EXPR_START.test(src[j])) return true;
  // `return'x'`, `case"x"` — keyword right before the quote
  return /\b(return|case|typeof|in|of)$/.test(src.slice(Math.max(0, j - 7), j + 1));
}

/** Index just past the string/template starting at i (src[i] is a quote). */
export function skipString(src, i) {
  const q = src[i];
  let k = i + 1;
  while (k < src.length) {
    const c = src[k];
    if (c === '\\') { k += 2; continue; }
    if (q === '`' && c === '$' && src[k + 1] === '{') {
      const close = matchClose(src, k + 1);
      if (close < 0) return src.length;
      k = close + 1; continue;
    }
    if (c === q) return k + 1;
    if (q !== '`' && c === '\n') return k + 1;   // unterminated single-line string: stop at EOL
    k++;
  }
  return src.length;
}

export function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if ((c === '"' || c === "'" || c === '`') && (c === '`' || quoteOpensString(src, i))) {
      const end = skipString(src, i);
      out += src.slice(i, end); i = end; continue;
    }
    if (c === '/' && n === '/' && src[i - 1] !== ':' && src[i - 1] !== '\\') {   // keep `https://` in JSX text
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const chunk = src.slice(i, end < 0 ? src.length : end + 2);
      out += chunk.replace(/[^\n]/g, ' ');           // keep line structure
      i = end < 0 ? src.length : end + 2; continue;
    }
    out += c; i++;
  }
  return out;
}

const PAIRS = { '(': ')', '[': ']', '{': '}' };

/** Index of the bracket closing the one at `open`, skipping strings; -1 if unbalanced. */
export function matchClose(src, open) {
  const want = [PAIRS[src[open]]];
  if (!want[0]) return -1;
  let k = open + 1;
  while (k < src.length) {
    const c = src[k];
    if ((c === '"' || c === "'" || c === '`') && (c === '`' || quoteOpensString(src, k))) { k = skipString(src, k); continue; }
    if (PAIRS[c]) want.push(PAIRS[c]);
    else if (c === want[want.length - 1]) { want.pop(); if (!want.length) return k; }
    k++;
  }
  return -1;
}

/** Splits `a, (b, c), d` on top-level commas. */
export function splitTopLevel(src, sep = ',') {
  const parts = [];
  let depth = 0, start = 0, k = 0;
  while (k < src.length) {
    const c = src[k];
    if ((c === '"' || c === "'" || c === '`') && (c === '`' || quoteOpensString(src, k))) { k = skipString(src, k); continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && src.startsWith(sep, k)) {
      // `a => b` contains no `+`, but `=>` must not be split on `>`-style separators; only ',' and '+' are used
      if (!(sep === '+' && (src[k + 1] === '+' || src[k - 1] === '+'))) {
        parts.push(src.slice(start, k)); start = k + sep.length; k += sep.length; continue;
      }
    }
    k++;
  }
  parts.push(src.slice(start));
  return parts.map(s => s.trim()).filter(s => s.length);
}

/** Arguments of the call whose `(` is at `open`. */
export function callArgs(src, open) {
  const close = matchClose(src, open);
  if (close < 0) return { args: [], end: open + 1 };
  return { args: splitTopLevel(src.slice(open + 1, close)), end: close + 1 };
}

function skipWs(src, k) { while (k < src.length && /\s/.test(src[k])) k++; return k; }

/** From just after a parameter list, skip an optional `: ReturnType` to the body `{` or `=>`. */
function findBodyStart(src, k, arrow) {
  k = skipWs(src, k);
  if (src[k] === ':') {                                  // return type annotation
    k++;
    while (k < src.length) {
      const c = src[k];
      if (c === '(' || c === '[' || (c === '<')) {
        if (c === '<') { let d = 1; k++; while (k < src.length && d) { if (src[k] === '<') d++; else if (src[k] === '>' && src[k - 1] !== '=') d--; k++; } continue; }
        const e = matchClose(src, k); if (e < 0) return -1; k = e + 1; continue;
      }
      if (arrow && src.startsWith('=>', k)) break;
      if (!arrow && c === '{') {
        // `): { a: string } {` — an object type followed by the real body
        const e = matchClose(src, k);
        const after = e > 0 ? skipWs(src, e + 1) : -1;
        if (after > 0 && src[after] === '{') { k = after; }
        break;
      }
      if (c === ';') return -1;
      k++;
    }
  }
  k = skipWs(src, k);
  if (arrow) {
    if (!src.startsWith('=>', k)) return -1;
    return skipWs(src, k + 2);
  }
  return src[k] === '{' ? k : -1;
}

const STMT_START = /^(const|let|var|export|function|return|if|for|while|import|type|interface|class|@|async\s+function)\b/;

/** End of an expression-bodied arrow: stops at `;`, an unbalanced closer, or a new statement line. */
export function exprEnd(src, k) {
  while (k < src.length) {
    const c = src[k];
    if ((c === '"' || c === "'" || c === '`') && (c === '`' || quoteOpensString(src, k))) { k = skipString(src, k); continue; }
    if (PAIRS[c]) { const e = matchClose(src, k); if (e < 0) return src.length; k = e + 1; continue; }
    if (c === ';' || c === ')' || c === ']' || c === '}' || c === ',') return k;
    if (c === '\n') {
      const rest = src.slice(k + 1, k + 60).trimStart();
      if (STMT_START.test(rest) || rest.startsWith('}')) return k;
    }
    k++;
  }
  return k;
}

const RESERVED = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await',
  'new', 'super', 'import', 'export', 'else', 'do', 'try', 'with', 'yield', 'delete', 'void', 'in', 'of', 'case']);

/**
 * Every named function body in the file:
 *   function name(...) {}           const name = (...) => {} | expr
 *   const name = useCallback((...) => {}, [])   class methods / arrow properties
 * Returns [{ name, cls, params, body, start, end }].
 */
export function extractFunctions(src) {
  const fns = [];
  const seen = new Set();
  const push = (f) => { const key = `${f.cls || ''}.${f.name}@${f.start}`; if (!seen.has(key)) { seen.add(key); fns.push(f); } };

  // 1. function declarations
  for (const m of src.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^()]*?>)?\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(src, open); if (close < 0) continue;
    const b = findBodyStart(src, close + 1, false); if (b < 0) continue;
    const e = matchClose(src, b); if (e < 0) continue;
    push({ name: m[1], cls: null, params: src.slice(open + 1, close), body: src.slice(b + 1, e), start: m.index, end: e });
  }

  // 2. const/let/var name = [async] [wrapper(] (params) => body | function (params) {}
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*/g)) {
    let k = m.index + m[0].length;
    for (let hop = 0; hop < 3; hop++) {                 // wrappers: useCallback(, memo(, forwardRef(
      const w = /^(?:async\s+)?([A-Za-z_$][\w$.]*)\s*(?:<[^()]*?>)?\s*\(\s*/.exec(src.slice(k, k + 80));
      if (!w || /^(async\s+)?function$/.test(w[1])) break;
      // A wrapper call's first argument must itself be a function
      const inner = k + w[0].length;
      if (!/^(?:async\s*)?(?:\(|[A-Za-z_$][\w$]*\s*=>|function\b)/.test(src.slice(inner, inner + 40))) break;
      k = inner;
    }
    k = skipWs(src, k);
    if (src.startsWith('async', k)) k = skipWs(src, k + 5);
    let params = '', bodyStart = -1;
    if (src.startsWith('function', k)) {
      const open = src.indexOf('(', k); const close = matchClose(src, open); if (close < 0) continue;
      params = src.slice(open + 1, close);
      bodyStart = findBodyStart(src, close + 1, false);
      if (bodyStart < 0) continue;
      const e = matchClose(src, bodyStart); if (e < 0) continue;
      push({ name: m[1], cls: null, params, body: src.slice(bodyStart + 1, e), start: m.index, end: e });
      continue;
    }
    if (src[k] === '<') { const g = src.indexOf('(', k); if (g < 0 || g - k > 60) continue; k = g; }
    if (src[k] === '(') {
      const close = matchClose(src, k); if (close < 0) continue;
      params = src.slice(k + 1, close);
      bodyStart = findBodyStart(src, close + 1, true);
    } else {
      const single = /^([A-Za-z_$][\w$]*)\s*=>\s*/.exec(src.slice(k, k + 60));
      if (!single) continue;
      params = single[1]; bodyStart = skipWs(src, k + single[0].length);
    }
    if (bodyStart < 0) continue;
    if (src[bodyStart] === '{') {
      const e = matchClose(src, bodyStart); if (e < 0) continue;
      push({ name: m[1], cls: null, params, body: src.slice(bodyStart + 1, e), start: m.index, end: e });
    } else {
      const e = exprEnd(src, bodyStart);
      push({ name: m[1], cls: null, params, body: src.slice(bodyStart, e), start: m.index, end: e });
    }
  }

  // 3. class members
  for (const c of extractClasses(src)) {
    for (const f of c.methods) push(f);
  }
  return fns;
}

/** Classes with decorators, fields and methods. [{ name, decorators, fields: Map, methods, body, start }] */
export function extractClasses(src) {
  const classes = [];
  for (const m of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)[^{]*\{/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(src, open); if (close < 0) continue;
    const body = src.slice(open + 1, close);
    // Decorator(s) directly above the class — @Component({...}), @Injectable(...)
    const before = src.slice(Math.max(0, m.index - 4000), m.index);
    const decorators = [];
    for (const d of before.matchAll(/@([A-Za-z_$][\w$]*)\s*\(/g)) {
      const abs = Math.max(0, m.index - 4000) + d.index + d[0].length - 1;
      const e = matchClose(src, abs);
      if (e > 0 && src.slice(e + 1, m.index).replace(/\bexport\b|\bdefault\b|\babstract\b|@\w+\s*\([^)]*\)/g, '').trim() === '') {
        decorators.push({ name: d[1], args: src.slice(abs + 1, e) });
      }
    }
    const cls = { name: m[1], decorators, fields: new Map(), methods: [], body, start: m.index };
    parseClassBody(cls, body, open + 1);
    classes.push(cls);
  }
  return classes;
}

const MEMBER = /(?:(?:public|private|protected|static|readonly|async|override|abstract|declare|get|set)\s+)*([A-Za-z_$][\w$]*)\s*[?!]?\s*/y;

function parseClassBody(cls, body, offset) {
  let k = 0;
  while (k < body.length) {
    k = skipWs(body, k);
    if (k >= body.length) break;
    if (body[k] === '@') {                                   // member decorator: @Input() / @HostListener('x')
      const d = /^@[\w$.]+\s*/.exec(body.slice(k)); k += d ? d[0].length : 1;
      if (body[k] === '(') { const e = matchClose(body, k); k = e < 0 ? k + 1 : e + 1; }
      continue;
    }
    if (body[k] === ';' || body[k] === ',') { k++; continue; }
    MEMBER.lastIndex = k;
    const m = MEMBER.exec(body);
    if (!m || m.index !== k || !m[1]) {                     // skip unknown token to the next line
      const nl = body.indexOf('\n', k); k = nl < 0 ? body.length : nl + 1; continue;
    }
    const name = m[1];
    let p = k + m[0].length;
    if (body[p] === '<') { const g = body.indexOf('(', p); if (g > 0 && g - p < 80) p = g; }
    if (body[p] === '(' && !RESERVED.has(name)) {             // method
      const close = matchClose(body, p);
      if (close < 0) break;
      const params = body.slice(p + 1, close);
      if (name === 'constructor') {
        for (const f of params.matchAll(/(?:private|public|protected|readonly)\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?!]?\s*:\s*([A-Za-z_$][\w$]*)/g)) {
          cls.fields.set(f[1], { type: f[2], init: '' });
        }
      }
      const b = findBodyStart(body, close + 1, false);
      if (b < 0) { k = close + 1; continue; }
      const e = matchClose(body, b); if (e < 0) break;
      cls.methods.push({ name, cls: cls.name, params, body: body.slice(b + 1, e), start: offset + k, end: offset + e });
      k = e + 1; continue;
    }
    // property: name: Type = init;  or  name = (x) => { ... }
    let type = '';
    if (body[p] === ':') {
      const t = /^:\s*([A-Za-z_$][\w$.]*)/.exec(body.slice(p)); if (t) type = t[1];
    }
    const eq = scanToPropertyEnd(body, p);
    const text = body.slice(p, eq.end);
    const initM = /=\s*([\s\S]*)$/.exec(text.replace(/^:[^=]*/, ''));
    const init = initM ? initM[1].trim() : '';
    const injected = /^inject\s*\(\s*([A-Za-z_$][\w$]*)/.exec(init);
    cls.fields.set(name, { type: injected ? injected[1] : type, init });
    const arrow = /^(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*(?::[^=]*)?=>\s*/.exec(init);
    if (arrow) {
      const rest = init.slice(arrow[0].length);
      const bodyText = rest.startsWith('{') ? rest.slice(1, rest.lastIndexOf('}')) : rest;
      cls.methods.push({ name, cls: cls.name, params: arrow[1] || arrow[2] || '', body: bodyText, start: offset + k, end: offset + eq.end });
    }
    k = eq.end + 1;
  }
}

function scanToPropertyEnd(body, k) {
  while (k < body.length) {
    const c = body[k];
    if ((c === '"' || c === "'" || c === '`') && (c === '`' || quoteOpensString(body, k))) { k = skipString(body, k); continue; }
    if (PAIRS[c]) { const e = matchClose(body, k); if (e < 0) return { end: body.length }; k = e + 1; continue; }
    if (c === ';') return { end: k };
    if (c === '\n') {
      const rest = body.slice(k + 1).trimStart();
      // a new member begins on the next line unless this one visibly continues
      const prev = body.slice(0, k).trimEnd().slice(-1);
      if (!/[=+\-*/,(|&?:.]/.test(prev) && !/^[.?:+\-*/|&=]/.test(rest)) return { end: k };
    }
    k++;
  }
  return { end: body.length };
}

/** `a: T, b?: U = 1` → Map(name → type). */
export function paramTypes(params) {
  const out = new Map();
  for (const p of splitTopLevel(params || '')) {
    const m = /^(?:(?:private|public|protected|readonly)\s+)*\.{0,3}([A-Za-z_$][\w$]*)\s*\??\s*(?::\s*([^=]+))?/.exec(p);
    if (m) out.set(m[1], (m[2] || '').trim());
  }
  return out;
}

export function rel(root, file) { return path.relative(root, file).split(path.sep).join('/'); }

export function lineOf(src, index) {
  let n = 1; for (let i = 0; i < index && i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}
