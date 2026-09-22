// Project-wide indexes: import resolution (tsconfig paths), string constants, type fields, i18n.
import fs from 'node:fs';
import path from 'node:path';
import { walk, read, readRaw, isTestFile, isGeneratedFile, matchClose, splitTopLevel, skipString, stripComments, CODE_EXTS } from './source.mjs';

function readJsonLoose(file) {
  try {
    // String-aware: `"@/*": ["./src/*"]` and `"**/*.ts"` must not read as a block comment
    const txt = stripComments(readRaw(file)).replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(txt);
  } catch { return null; }
}

export class Project {
  constructor(root) {
    this.root = path.resolve(root);
    this.pkg = readJsonLoose(path.join(this.root, 'package.json')) || {};
    this.files = walk(this.root, CODE_EXTS).filter(f => !isTestFile(f) && !isGeneratedFile(f));
    this.fileSet = new Set(this.files);
    this.#loadTsconfig();
    this.consts = new Map();        // "NAME" / "OBJ.key.sub" → string | { ref|expr, file }
    this.fileConsts = new Map();    // file → Map(NAME → value): file scope wins over the global table
    this.types = new Map();         // "TypeName" → [{ name, type, optional }]
    this.#indexConstsAndTypes();
    this.axiosInstances = new Set(['axios']);
    this.axiosBase = new Map();     // instance → base placeholder
    for (const f of this.files) {
      for (const m of read(f).matchAll(/\b(?:const|let|var|export\s+const)\s+([A-Za-z_$][\w$]*)\s*=\s*axios\.create\s*\(/g)) {
        this.axiosInstances.add(m[1]);
        const open = m.index + m[0].length - 1;
        const close = matchClose(read(f), open);
        const cfg = close > 0 ? read(f).slice(open + 1, close) : '';
        const b = /baseURL\s*:\s*([^,\n}]+)/.exec(cfg);
        if (b) this.axiosBase.set(m[1], b[1].trim());
      }
    }
  }

  get deps() { return { ...(this.pkg.dependencies || {}), ...(this.pkg.devDependencies || {}) }; }

  #loadTsconfig() {
    this.baseUrl = this.root;
    this.paths = [];
    const visit = (file, depth) => {
      const cfg = readJsonLoose(file); if (!cfg || depth > 3) return;
      if (cfg.extends && typeof cfg.extends === 'string' && cfg.extends.startsWith('.')) {
        visit(path.resolve(path.dirname(file), cfg.extends.endsWith('.json') ? cfg.extends : cfg.extends + '.json'), depth + 1);
      }
      const co = cfg.compilerOptions || {};
      if (co.baseUrl) this.baseUrl = path.resolve(path.dirname(file), co.baseUrl);
      if (co.paths) {
        const base = co.baseUrl ? path.resolve(path.dirname(file), co.baseUrl) : path.dirname(file);
        for (const [k, v] of Object.entries(co.paths)) {
          this.paths.unshift({ prefix: k.replace(/\*$/, ''), wildcard: k.endsWith('*'), targets: v.map(t => path.resolve(base, t.replace(/\*$/, ''))) });
        }
      }
    };
    for (const name of ['tsconfig.json', 'tsconfig.app.json', 'jsconfig.json']) {
      const f = path.join(this.root, name);
      if (fs.existsSync(f)) visit(f, 0);
    }
  }

  /** Resolves an import specifier to a project file, or null for packages. */
  resolveImport(fromFile, spec) {
    const cands = [];
    if (spec.startsWith('.')) cands.push(path.resolve(path.dirname(fromFile), spec));
    else {
      for (const p of this.paths) {
        if (p.wildcard ? spec.startsWith(p.prefix) : spec === p.prefix) {
          for (const t of p.targets) cands.push(p.wildcard ? path.join(t, spec.slice(p.prefix.length)) : t);
        }
      }
      if (spec.startsWith('src/') || spec.startsWith('app/')) cands.push(path.join(this.root, spec));
      if (this.baseUrl !== this.root) cands.push(path.join(this.baseUrl, spec));
    }
    for (const c of cands) {
      const hit = this.#tryFile(c); if (hit) return hit;
    }
    return null;
  }

  #tryFile(base) {
    if (this.fileSet.has(base)) return base;
    for (const ext of CODE_EXTS) if (this.fileSet.has(base + ext)) return base + ext;
    for (const ext of CODE_EXTS) { const f = path.join(base, 'index' + ext); if (this.fileSet.has(f)) return f; }
    if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;   // .html templates etc.
    return null;
  }

  /** import map for a file: localName → { file, imported } */
  imports(file) {
    const src = read(file);
    const map = new Map();
    for (const m of src.matchAll(/\bimport\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
      const target = this.resolveImport(file, m[2]);
      const clause = m[1];
      const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
      if (def) map.set(def[1], { file: target, imported: 'default', spec: m[2] });
      const named = /\{([\s\S]*?)\}/.exec(clause);
      if (named) {
        for (const part of named[1].split(',')) {
          const p = part.trim().replace(/^type\s+/, ''); if (!p) continue;
          const [orig, alias] = p.split(/\s+as\s+/).map(s => s.trim());
          map.set(alias || orig, { file: target, imported: orig, spec: m[2] });
        }
      }
      const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
      if (ns) map.set(ns[1], { file: target, imported: '*', spec: m[2] });
    }
    for (const m of src.matchAll(/\bexport\s+\{\s*default(?:\s+as\s+(\w+))?\s*\}\s*from\s+['"]([^'"]+)['"]/g)) {
      map.set(m[1] || 'default', { file: this.resolveImport(file, m[2]), imported: 'default', spec: m[2], reexport: true });
    }
    return map;
  }

  #indexConstsAndTypes() {
    for (const f of this.files) {
      const src = read(f);
      // const NAME = "value"
      const local = new Map();
      this.fileConsts.set(f, local);
      for (const m of src.matchAll(/\b(?:const|let|var|readonly|static)\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*(['"`])/g)) {
        const start = m.index + m[0].length - 1;
        const end = skipString(src, start);
        let v = src.slice(start + 1, end - 1);
        // `const url = "a" + B + "/c"` — keep the whole concatenation, evaluated on lookup
        const tail = /^\s*\+[^;\n]*/.exec(src.slice(end));
        if (tail || (m[2] === '`' && v.includes('${'))) v = { expr: src.slice(start, end) + (tail ? tail[0] : ''), file: f };
        if (typeof v === 'string' && v.length >= 400) continue;
        if (!local.has(m[1])) local.set(m[1], v);
        if (!this.consts.has(m[1])) this.consts.set(m[1], v);
      }
      for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*([A-Za-z_$][\w$.]*\s*\+[^;\n]+)/g)) {
        const v = { expr: m[2], file: f };
        if (!local.has(m[1])) local.set(m[1], v);
        if (!this.consts.has(m[1])) this.consts.set(m[1], v);
      }
      // const NAME = { ... } (as const)   and   enum NAME { A = "x" }
      for (const m of src.matchAll(/\b(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*|enum\s+([A-Za-z_$][\w$]*)\s*)\{/g)) {
        const open = m.index + m[0].length - 1;
        const close = matchClose(src, open); if (close < 0) continue;
        this.#indexObject(m[1] || m[2], src.slice(open + 1, close), 0, !!m[2], f);
      }
      // interfaces / type literals / model classes → field names
      for (const m of src.matchAll(/\b(?:interface\s+([A-Za-z_$][\w$]*)(?:<[^>{]*>)?(?:\s+extends\s+([^{]+))?|type\s+([A-Za-z_$][\w$]*)(?:<[^=]*>)?\s*=\s*(?:([A-Za-z_$][\w$.]*(?:<[^{]*?>)?)\s*&\s*)?|class\s+([A-Za-z_$][\w$]*)(?:\s+(?:extends|implements)\s+([^{]+))?)\s*\{/g)) {
        const name = m[1] || m[3] || m[5];
        if (this.types.has(name)) continue;
        const open = m.index + m[0].length - 1;
        const close = matchClose(src, open); if (close < 0) continue;
        const isClass = !!m[5];
        const fields = parseTypeMembers(src.slice(open + 1, close), isClass);
        if (isClass && (fields.length === 0 || /constructor\s*\([^)]*\b(private|public)\b/.test(src.slice(open, close)))) continue;
        const parents = (m[2] || m[4] || m[6] || '').split(',').map(s => s.trim().replace(/<.*$/, '')).filter(Boolean);
        this.types.set(name, { fields, parents });
      }
    }
  }

  #indexObject(prefix, body, depth, isEnum, file) {
    if (depth > 3) return;
    for (const part of splitTopLevel(body)) {
      const m = /^\[?['"]?([A-Za-z_$][\w$-]*)['"]?\]?\s*[:=]\s*([\s\S]*)$/.exec(part);
      if (!m) continue;
      const key = `${prefix}.${m[1]}`;
      const val = m[2].trim().replace(/\s+as\s+const$/, '');
      const lit = /^(['"`])([\s\S]*)\1$/.exec(val);
      if (lit) { if (!this.consts.has(key)) this.consts.set(key, lit[2]); continue; }
      if (val.startsWith('{') && !isEnum) {
        const close = matchClose(val, 0);
        if (close > 0) this.#indexObject(key, val.slice(1, close), depth + 1, false, file);
        continue;
      }
      // a reference to another constant, or `url + "/x"` / `${BASE}/x` — resolved lazily in this file's scope
      if (this.consts.has(key)) continue;
      if (/^[A-Za-z_$][\w$.]*$/.test(val)) this.consts.set(key, { ref: val, file });
      else if (/^[A-Za-z_$`'"][\s\S]*\+|^`[\s\S]*\$\{/.test(val)) this.consts.set(key, { expr: val, file });
    }
  }

  /** Constant lookup with reference chasing. */
  constValue(name, file = null, depth = 0) {
    if (depth > 6) return undefined;
    const scoped = file && this.fileConsts.get(file);
    let v = scoped && scoped.has(name) ? scoped.get(name) : this.consts.get(name);
    if (v === undefined) {
      // an imported object: `API_PATH.x` where API_PATH is imported under another name
      return undefined;
    }
    if (typeof v === 'string') return v;
    if (v.ref) return this.constValue(v.ref, v.file, depth + 1);
    return this.#evalConstExpr(v.expr, v.file, depth + 1);
  }

  /** `url + "/x"`, `` `${BASE}/x` `` using constants only; unknown parts stay `{name}`. */
  #evalConstExpr(expr, file, depth) {
    let out = '';
    for (let term of splitTopLevel(expr, '+')) {
      term = term.trim();
      const q = /^(['"])([\s\S]*)\1$/.exec(term);
      if (q) { out += q[2]; continue; }
      if (term.startsWith('`') && term.endsWith('`')) {
        out += term.slice(1, -1).replace(/\$\{\s*([A-Za-z_$][\w$.]*)\s*\}/g, (_, id) => this.constValue(id, file, depth + 1) ?? `{${id.split('.').pop()}}`);
        continue;
      }
      const v = /^[A-Za-z_$][\w$.]*$/.test(term) ? this.constValue(term, file, depth + 1) : undefined;
      out += v ?? `{${term.split('.').pop()}}`;
    }
    return out;
  }

  /** Field names for a type, following `extends` one or two levels and unwrapping generics/arrays. */
  typeFields(typeName, depth = 0) {
    if (!typeName || depth > 2) return [];
    let t = typeName.trim().replace(/\[\]$/, '').replace(/^Array<(.+)>$/, '$1').replace(/^Promise<(.+)>$/, '$1');
    const generic = /^([A-Za-z_$][\w$.]*)<(.+)>$/.exec(t);
    const entry = this.types.get(generic ? generic[1] : t);
    if (!entry) return generic ? this.typeFields(generic[2], depth + 1) : [];
    const own = entry.fields.map(f => f.name);
    const inherited = entry.parents.flatMap(p => this.typeFields(p, depth + 1));
    return [...new Set([...own, ...inherited])];
  }

  /**
   * A sample value shaped like `typeName`: interfaces/classes/type literals become objects with every field,
   * primitives become placeholders, arrays hold one element. Unknown types give null. Depth-limited.
   */
  sampleOf(typeName, depth = 0) {
    let t = (typeName || '').trim().replace(/\s*\|\s*(undefined|null)\b/g, '').trim();
    if (!t || depth > 4) return null;
    if (/\|/.test(t)) t = t.split('|')[0].trim();                        // union: first member
    const lit = /^(['"`])(.*)\1$/.exec(t);
    if (lit) return lit[2];
    if (/\[\]$/.test(t)) return [this.sampleOf(t.slice(0, -2), depth + 1)];
    const arr = /^(?:Array|ReadonlyArray)<(.+)>$/.exec(t);
    if (arr) return [this.sampleOf(arr[1], depth + 1)];
    if (/^(string|String)$/.test(t)) return 'string';
    if (/^(number|Number|bigint)$/.test(t)) return 0;
    if (/^(boolean|Boolean)$/.test(t)) return false;
    if (/^(Date)$/.test(t)) return '2026-01-01T00:00:00Z';
    if (/^(any|unknown|object|Object)$/.test(t)) return {};
    if (/^Record<\s*string\s*,/.test(t)) return {};
    const inline = /^\{([\s\S]*)\}$/.exec(t);
    const generic = /^([A-Za-z_$][\w$.]*)<(.+)>$/.exec(t);
    const entry = inline ? null : this.types.get(generic ? generic[1] : t);
    if (!entry && !inline) return generic ? this.sampleOf(generic[2], depth + 1) : null;
    const out = {};
    const fields = inline ? parseTypeMembers(inline[1], false) : entry.fields;
    for (const p of entry ? entry.parents : []) {
      const base = this.sampleOf(p, depth + 1);
      if (base && typeof base === 'object' && !Array.isArray(base)) Object.assign(out, base);
    }
    for (const f of fields) out[f.name] = f.type ? this.sampleOf(f.type, depth + 1) : null;
    return out;
  }

  /**
   * Realistic fake data shaped like `typeName`, for mocking an API when no stub exists. Leaf values are picked
   * from the field name (names, phones, dates, amounts, statuses…); arrays get 3 varied items. Never real data.
   */
  fakeOf(typeName, key = '', depth = 0, i = 0) {
    let t = (typeName || '').trim().replace(/\s*\|\s*(undefined|null)\b/g, '').trim();
    if (depth > 5) return null;
    const lits = [...t.matchAll(/^(['"])(.*?)\1$|(?:^|\|)\s*(['"])(.*?)\3/g)].map(m => m[2] ?? m[4]);
    if (lits.length) return lits[i % lits.length];
    if (/\|/.test(t)) t = t.split('|')[0].trim();
    const arr = /\[\]$/.test(t) ? t.slice(0, -2) : (/^(?:Array|ReadonlyArray)<(.+)>$/.exec(t) || [])[1];
    if (arr) return [0, 1, 2].map(n => this.fakeOf(arr, key, depth + 1, n));
    if (!t || /^(string|String)$/.test(t)) return fakeString(key, i);
    if (/^(number|Number|bigint)$/.test(t)) return fakeNumber(key, i);
    if (/^(boolean|Boolean)$/.test(t)) return i % 2 === 0;
    if (/^Date$/.test(t)) return fakeString('date', i);
    if (/^(any|unknown|object|Object)$/.test(t) || /^Record</.test(t)) return {};
    const inline = /^\{([\s\S]*)\}$/.exec(t);
    const generic = /^([A-Za-z_$][\w$.]*)<(.+)>$/.exec(t);
    const entry = inline ? null : this.types.get(generic ? generic[1] : t);
    if (!entry && !inline) {
      if (generic) return this.fakeOf(generic[2], key, depth + 1, i);
      const enumVals = [...this.consts.entries()].filter(([k, v]) => k.startsWith(t + '.') && typeof v === 'string').map(([, v]) => v);
      return enumVals.length ? enumVals[i % enumVals.length] : fakeString(key, i);
    }
    const out = {};
    for (const p of entry ? entry.parents : []) {
      const base = this.fakeOf(p, key, depth + 1, i);
      if (base && typeof base === 'object' && !Array.isArray(base)) Object.assign(out, base);
    }
    const fields = inline ? parseTypeMembers(inline[1], false) : entry.fields;
    for (const f of fields) out[f.name] = f.type ? this.fakeOf(f.type, f.name, depth + 1, i) : fakeString(f.name, i);
    return out;
  }

  /** Flattened translation table for the preferred language. */
  loadLocales(lang) {
    const jsonFiles = walk(this.root, ['.json']).filter(f =>
      /[\\/](locales?|i18n|lang|langs|languages|translations?|assets)[\\/]/i.test(f) &&
      !/package|tsconfig|angular\.json|manifest/i.test(path.basename(f)));
    const score = f => {
      const n = f.toLowerCase();
      const want = lang.toLowerCase();
      if (new RegExp(`[\\\\/]${want}([-_][a-z]+)?(\\.json|[\\\\/])`).test(n)) return 3;
      if (/[\\/]en([-_][a-z]+)?(\.json|[\\/])/.test(n)) return 2;
      if (/[\\/][a-z]{2}([-_][a-z]{2})?(\.json|[\\/])/.test(n)) return 1;
      return 0;
    };
    const best = Math.max(0, ...jsonFiles.map(score));
    const table = new Map();
    if (best === 0) return table;
    for (const f of jsonFiles.filter(x => score(x) === best)) {
      const data = readJsonLoose(f); if (!data || typeof data !== 'object') continue;
      // namespace files (locales/th/common.json) are addressed as `common.key` or `common:key`
      const ns = path.basename(f, '.json');
      const isNs = !/^[a-z]{2}([-_][a-z]{2})?$/i.test(ns);
      const flat = (obj, pre) => {
        for (const [k, v] of Object.entries(obj)) {
          const key = pre ? `${pre}.${k}` : k;
          if (v && typeof v === 'object') flat(v, key);
          else if (typeof v === 'string') {
            table.set(key, v);
            if (isNs) { table.set(`${ns}.${key}`, v); table.set(`${ns}:${key}`, v); }
          }
        }
      };
      flat(data, '');
    }
    return table;
  }
}

function parseTypeMembers(body, isClass) {
  const fields = [];
  let depth = 0, line = '';
  const flush = () => {
    const m = /^\s*(?:(?:public|private|protected|readonly|declare)\s+)*['"]?([A-Za-z_$][\w$-]*)['"]?\s*(\?)?\s*[:!]\s*([^;,]*)/.exec(line);
    if (m && !/\(/.test(line.split(':')[0])) fields.push({ name: m[1], optional: !!m[2], type: m[3].trim() });
    else if (isClass) {
      const p = /^\s*(?:(?:public|private|protected|readonly)\s+)*([A-Za-z_$][\w$]*)\s*(\?)?\s*=/.exec(line);
      if (p) fields.push({ name: p[1], optional: !!p[2], type: '' });
    }
    line = '';
  };
  for (const c of body) {
    if (c === '{' || c === '(' || c === '[' || c === '<') depth++;
    if (c === '}' || c === ')' || c === ']' || c === '>') depth--;
    if (depth === 0 && (c === ';' || c === '\n' || c === ',')) { flush(); continue; }
    if (depth >= 0) line += c;
  }
  flush();
  return fields.filter(f => !/^(constructor|get|set|static)$/.test(f.name));
}


// ── Fake leaf values for mocks — obviously sample data, never copied from anywhere real ──
const FIRST = ['สมชาย', 'สมหญิง', 'ประยุทธ', 'มาลี', 'วิชัย', 'สุดา'];
const LAST = ['ใจดี', 'รักษ์ไทย', 'มีสุข', 'ศรีสุข', 'บุญมา', 'แสงทอง'];
function fakeString(key, i) {
  const k = String(key).toLowerCase();
  if (/firstname|givenname/.test(k)) return FIRST[i % FIRST.length];
  if (/lastname|surname|familyname/.test(k)) return LAST[i % LAST.length];
  if (/middlename/.test(k)) return '';
  if (/(full|staff|customer|member|user|officer|person|contact|owner)name|displayname/.test(k)) return `${FIRST[i % FIRST.length]} ${LAST[i % LAST.length]}`;
  if (/org|company|branch|store|shop|unit|hospital|school|agency/.test(k) && /name|desc/.test(k)) return `หน่วยงานตัวอย่าง ${i + 1}`;
  if (/mobile|phone|tel/.test(k)) return `08${String(10000000 + i * 1111111).slice(0, 8)}`;
  if (/email/.test(k)) return `user${i + 1}@example.com`;
  if (/identifier|citizen|idcard|nationalid/.test(k)) return `1${String(100000000000 + i * 111111111111).slice(0, 12)}`;
  if (/(date|dtm|time|at)$|birth|dob/.test(k)) return new Date(Date.UTC(2026, 0, 10 + i * 3, 9, 30)).toISOString();
  if (/url|link|href|image|img|avatar|icon|photo/.test(k)) return 'https://example.com/sample.png';
  if (/address|detail$/.test(k)) return `${10 + i}/1 หมู่ ${i + 1} ถนนตัวอย่าง`;
  if (/province|district|subdistrict/.test(k)) return ['กรุงเทพมหานคร', 'เชียงใหม่', 'ขอนแก่น'][i % 3];
  if (/status|state|result|level|type|category|group|code$/.test(k) && !/desc|name|title/.test(k)) return ['ACTIVE', 'PENDING', 'DONE'][i % 3];
  if (/(^|[^a-z])id$|id$|code|no$|number|ref/.test(k)) return String(100001 + i);
  if (/title|header|subject/.test(k)) return `หัวข้อตัวอย่าง ${i + 1}`;
  if (/^name$/.test(k)) return `ตัวอย่าง ${i + 1}`;
  if (/desc|detail|message|note|remark|content|text|suggest/.test(k)) return `ข้อความตัวอย่างสำหรับ ${key || 'รายการ'} ${i + 1}`;
  if (/age/.test(k)) return `${65 + i * 4} ปี`;
  return `${key || 'value'} ${i + 1}`;
}
function fakeNumber(key, i) {
  const k = String(key).toLowerCase();
  if (/total|count|record|size|length|qty|quantity/.test(k)) return 3;
  if (/page|index|no$/.test(k)) return i + 1;
  if (/amount|price|fee|balance|cost|salary/.test(k)) return 1500 + i * 250;
  if (/age/.test(k)) return 65 + i * 4;
  if (/score|point|percent|rate/.test(k)) return [72, 85, 64][i % 3];
  if (/weight/.test(k)) return 58 + i * 3;
  if (/height/.test(k)) return 160 + i * 4;
  return i + 1;
}
