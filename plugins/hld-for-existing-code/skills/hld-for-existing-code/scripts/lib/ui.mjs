// UI outline from JSX or an Angular template: the notable elements in document order, and which
// element triggers which handler. Web pages have no fixed coordinates, so the wireframe is a stack.
import { matchClose, skipString } from './source.mjs';

const KINDS = [
  ['loading', t => /(Spinner|Loading|Loader|Skeleton|Progress\w*)$/.test(t) || /^(mat-spinner|mat-progress-\w+|p-progressspinner|ion-spinner|p-skeleton)$/.test(t)],
  ['heading', t => /^h[1-3]$/.test(t) || /(^|\.)(Title|Heading|Header|PageTitle|NavBar|NavigationBar|Toolbar)$/.test(t) || /^(mat-toolbar|ion-title|p-toolbar)$/.test(t)],
  ['button', t => t === 'button' || /Button|Btn$|^(Fab|IconButton)$/.test(t) || /^(p-button|ion-button|mat-button|mat-raised-button|nz-button)$/.test(t)],
  ['link', t => t === 'a' || /(^|\.)(Link|NavLink|RouterLink)$/.test(t)],
  ['input', t => /^(input|textarea|select)$/.test(t) || /(Input|TextField|TextArea|Select|Dropdown|Checkbox|Radio|Switch|Toggle|DatePicker|Calendar|NumericFormat|NumberFormat|PatternFormat|Otp|Pin|Autocomplete|Combobox|Upload|FileInput)$/.test(t) || /^(mat-form-field|mat-select|p-dropdown|p-calendar|p-inputnumber|p-checkbox|p-radiobutton|ion-input|ion-select|nz-input|p-autocomplete|p-fileupload)$/.test(t)],
  ['image', t => /^(img|picture|svg|video)$/.test(t) || /(^|\.)(Image|Img|Logo\w*|Lottie\w*|Avatar|Illustration|Banner|Carousel|QRCode)$/.test(t) || /^(p-image|ion-img|lottie-player)$/.test(t)],
  ['list', t => /^(ul|ol|table)$/.test(t) || /(List|Table|DataTable|Grid|Accordion|Tabs)$/.test(t) || /^(mat-table|p-table|mat-list|ion-list|p-accordion|mat-tab-group|p-tabview)$/.test(t)],
  ['text', t => /^(p|label|span|small|strong|h[4-6]|li|td|th)$/.test(t) || /(Text|Typography|Label|Paragraph|Caption|Description)$/.test(t)],
];

const LABEL_ATTRS = ['label', 'title', 'text', 'placeholder', 'aria-label', 'ariaLabel', 'alt', 'header', 'buttonText', 'name'];

function kindOf(tag) {
  for (const [k, test] of KINDS) if (test(tag)) return k;
  return null;
}

/** Resolves `t("a.b")`, `'a.b' | translate`, `i18n.t('x')`, `$t('x')` or a literal to display text. */
export function makeTextResolver(locales) {
  // `isExpr`: the value is code (`[title]="x.y"`, `title={x.y}`) — only a translation key or a
  // string literal inside it is displayable; a bare property path is not text.
  return (raw, isExpr = false) => {
    if (!raw) return '';
    let s = raw.trim();
    const key = /(?:\bt|\$t|translate\.instant|i18n\.t|intl\.formatMessage)\s*\(\s*['"`]([^'"`]+)['"`]/.exec(s)
      || /['"`]([^'"`]+)['"`]\s*\|\s*translate/.exec(s)
      || /\bid\s*:\s*['"]([^'"]+)['"]/.exec(s);
    if (key) return locales.get(key[1]) || key[1];
    const lit = /^(['"`])([\s\S]*)\1$/.exec(s);
    if (lit) return lit[2];
    if (/^\{[\s\S]*\}$/.test(s) || isExpr) return '';        // an expression we cannot show
    return s.replace(/\{\{[\s\S]*?\}\}/g, '').replace(/\s+/g, ' ').trim();
  };
}

/** Parses JSX attributes starting at k (just after the tag name) up to `>` or `/>`. */
function jsxAttrs(src, k) {
  const attrs = {};
  while (k < src.length) {
    while (/\s/.test(src[k])) k++;
    if (src[k] === '/' && src[k + 1] === '>') return { attrs, end: k + 2, selfClosing: true };
    if (src[k] === '>') return { attrs, end: k + 1, selfClosing: false };
    if (src[k] === '{') { const e = matchClose(src, k); if (e < 0) break; k = e + 1; continue; }   // {...spread}
    const m = /^([A-Za-z_$][\w$:.-]*)/.exec(src.slice(k, k + 80));
    if (!m) { k++; continue; }
    const name = m[1]; k += name.length;
    while (/\s/.test(src[k])) k++;
    if (src[k] !== '=') { attrs[name] = 'true'; continue; }
    k++; while (/\s/.test(src[k])) k++;
    if (src[k] === '"' || src[k] === "'") { const e = skipString(src, k); attrs[name] = src.slice(k, e); k = e; continue; }
    if (src[k] === '{') { const e = matchClose(src, k); if (e < 0) break; attrs[name] = src.slice(k + 1, e).trim(); k = e + 1; continue; }
  }
  return { attrs, end: k, selfClosing: true };
}

/** Plain text directly inside an element (until the next tag), for JSX. */
function jsxText(src, k) {
  const next = src.indexOf('<', k);
  const chunk = src.slice(k, next < 0 ? k + 200 : next);
  const expr = /\{([^{}]*\bt\s*\([^{}]*|[^{}]*['"`][^{}]*)\}/.exec(chunk);
  const text = chunk.replace(/\{[^{}]*\}/g, ' ').replace(/\{[\s\S]*$/, ' ').replace(/\s+/g, ' ').trim();
  return { text, expr: expr ? expr[1] : '' };
}

/**
 * JSX outline. Returns { elements: [{kind,label,tag}], bindings: [{event, handler|inline, tag, label, index}] }
 */
export function jsxOutline(src, resolve) {
  const elements = [];
  const bindings = [];
  const re = /<([A-Za-z][\w.]*)(?=[\s/>])/g;
  let m;
  while ((m = re.exec(src))) {
    // `a < b`, `useState<T>`, `Array<string>` — a JSX tag follows an expression boundary, not an identifier
    let j = m.index - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    const prev = src[j];
    if (prev && /[\w$)\].]/.test(prev) && !/return$|=>$/.test(src.slice(Math.max(0, j - 6), j + 1))) continue;
    const tag = m[1];
    const { attrs, end, selfClosing } = jsxAttrs(src, m.index + m[0].length);
    // Keep scanning inside the attributes: `endIcon={<ButtonIcon onClick={close} />}` is real UI
    re.lastIndex = m.index + m[0].length;
    let kind = kindOf(tag);
    if (!kind && /^[A-Z]/.test(tag) && (attrs.title || attrs.heading)) kind = 'heading';
    let label = '';
    for (const a of LABEL_ATTRS) if (attrs[a]) { label = resolve(attrs[a], !/^['"]/.test(attrs[a])); if (label) break; }
    if (!label && !selfClosing) {
      const close = kind === 'button' || kind === 'link' ? src.indexOf(`</${tag}>`, end) : -1;
      if (close > 0 && close - end < 1500) {
        const inner = src.slice(end, close);
        const key = /\{\s*(t\s*\([^)]*\))\s*\}/.exec(inner);
        label = inner.replace(/<[^>]*>/g, ' ').replace(/\{[^{}]*\}/g, ' ').replace(/\s+/g, ' ').trim() || (key ? resolve(key[1]) : '');
      } else {
        const t = jsxText(src, end);
        label = t.text || resolve(t.expr);
      }
    }
    if (tag === 'Link' || tag === 'a') label = label || attrs.href || '';
    // a `.map(` right before the element marks a repeated row
    const repeated = /\.map\s*\(\s*(?:\([^)]*\)|[\w$]+)\s*=>\s*\(?\s*$/.test(src.slice(Math.max(0, m.index - 80), m.index));
    if (kind === 'list' && !attrs.title && !attrs.label) label = '';
    const idx = kind || repeated ? elements.push({ kind: repeated && kind !== 'button' ? 'list' : kind, label: clean(label), tag }) - 1 : -1;

    for (const [name, value] of Object.entries(attrs)) {
      if (!/^on[A-Z]/.test(name) || name === 'onChange' && kind === 'input') continue;
      if (/^(onChange|onBlur|onFocus|onKey\w+|onMouse\w+|onScroll|onLoad|onError|onAnimation\w+|onTransition\w+)$/.test(name) && !/submit|next|save|confirm/i.test(value)) continue;
      const ident = /^(?:this\.|props\.)?([A-Za-z_$][\w$]*)$/.exec(value);
      const callOnly = /^\(\)\s*=>\s*([A-Za-z_$][\w$]*)\s*\(\s*\)$/.exec(value);
      bindings.push({ event: name, tag, label: clean(label), element: idx,
        handler: ident ? ident[1] : callOnly ? callOnly[1] : null, inline: ident || callOnly ? null : value });
    }
    if (/^(Link|a|NavLink)$/.test(tag) && attrs.href) bindings.push({ event: 'href', tag, label: clean(label), element: idx, href: attrs.href });
  }
  return { elements: tidy(elements), bindings };
}

/** Angular template outline, same shape as jsxOutline. */
export function templateOutline(html, resolve) {
  const elements = [];
  const bindings = [];
  const re = /<([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let m;
  const ctrl = /@for\s*\(/g;
  const loopStarts = [...html.matchAll(ctrl)].map(x => x.index);
  while ((m = re.exec(html))) {
    const tag = m[1];
    const attrs = {};
    for (const a of m[2].matchAll(/([^\s=]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attrs[a[1]] = a[3] ?? a[4] ?? a[5] ?? 'true';
    }
    let kind = kindOf(tag);
    if (!kind && ('mat-button' in attrs || 'mat-raised-button' in attrs || 'mat-flat-button' in attrs || 'pButton' in attrs)) kind = 'button';
    if (!kind && ('routerLink' in attrs || '[routerLink]' in attrs)) kind = 'link';
    // Project components (`app-staff-form`) are whole sections of the page — show them as blocks
    if (!kind && tag.includes('-') && !/^(ng-|router-outlet|p-toast|p-confirm|p-dialog|mat-icon|ion-icon|p-card|mat-card|ion-card|ion-content)/.test(tag)) kind = 'component';
    const repeated = '*ngFor' in attrs || loopStarts.some(s => s < m.index && m.index - s < 200 && !html.slice(s, m.index).includes('}\n'));
    let label = '';
    for (const a of LABEL_ATTRS) {
      if (attrs[a]) { label = resolve(attrs[a]); if (label) break; }   // `label="{{ 'k' | translate }}"` or plain text
      if (attrs[`[${a}]`]) { label = resolve(attrs[`[${a}]`], true); if (label) break; }
    }
    if (!label && !m[3]) {
      // Buttons and links: all text inside, through nested icons/spans. Others: text before the next tag.
      const from = m.index + m[0].length;
      const close = kind === 'button' || kind === 'link' ? html.indexOf(`</${tag}>`, from) : -1;
      const next = html.indexOf('<', from);
      const chunk = html.slice(from, close > 0 && close - from < 1500 ? close : next < 0 ? undefined : next).replace(/<[^>]*>/g, ' ');
      const tr = /\{\{\s*(['"][^'"]+['"]\s*\|\s*translate[^}]*)\}\}/.exec(chunk);
      label = tr ? resolve(tr[1]) : chunk.replace(/\{\{[\s\S]*?\}\}/g, ' ').replace(/\s+/g, ' ').trim();
    }
    if (kind === 'component' && !label) label = tag.replace(/^[a-z]+-/, '').replace(/-/g, ' ');
    const idx = kind || repeated ? elements.push({ kind: repeated && kind !== 'button' ? 'list' : kind, label: clean(label), tag }) - 1 : -1;
    for (const [name, value] of Object.entries(attrs)) {
      const ev = /^\(([\w.]+)\)$/.exec(name);
      // Any output binding counts (custom @Output()s like `(onSubmitEmitter)`), minus typing/focus noise
      if (ev && !/^(ngModelChange|input|keyup|keydown|keypress|blur|focus|focusin|focusout|mouse\w+|scroll|paste|load|error|window:\w+|document:\w+)/.test(ev[1])) {
        const stmt = value.split(';').map(x => x.trim()).filter(x => x && !x.startsWith('$event')).join('; ');
        const call = /^\s*([A-Za-z_$][\w$]*)\s*\(/.exec(stmt);
        bindings.push({ event: ev[1], tag, label: clean(label), element: idx, handler: call ? call[1] : null, inline: call ? null : stmt });
      }
      if (name === 'routerLink' || name === '[routerLink]') bindings.push({ event: 'routerLink', tag, label: clean(label), element: idx, href: name === 'routerLink' ? `'${value}'` : value });
      if (tag === 'a' && name === 'href' && /^https?:/.test(value)) bindings.push({ event: 'href', tag, label: clean(label), element: idx, href: `'${value}'` });
    }
  }
  return { elements: tidy(elements), bindings };
}

function clean(s) {
  s = (s || '').replace(/@(for|if|else if|else|switch|case|default|defer|empty|placeholder)\b[^{]*\{|^\}|\}$|\}\s*@/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const q = /^(['"`])([\s\S]*)\1$/.exec(s);             // strip only a matching pair of quotes
  return (q ? q[2] : s).trim().slice(0, 60);
}

/** Drops unlabeled text, merges runs of identical rows, caps the outline. */
function tidy(elements) {
  const out = [];
  for (const e of elements) {
    if ((e.kind === 'text' || e.kind === 'heading' || e.kind === 'link') && !e.label) continue;
    // Unicode-aware: Thai is not `\w`, so `\W` would treat every Thai label as punctuation
    if (e.kind === 'text' && /^[\p{P}\p{S}\p{N}\s_]*$/u.test(e.label)) continue;
    const prev = out[out.length - 1];
    if (prev && prev.kind === e.kind && prev.label === e.label) continue;
    if (prev && e.kind === 'text' && prev.label === e.label) continue;      // the button's own caption span
    if (e.kind === 'list' && prev && prev.kind === 'list') continue;
    out.push(e);
  }
  return out.slice(0, 18);
}
