// Copyright (c) Meta Platforms, Inc. and affiliates.

/**
 * @file A small, forgiving HTML reader for `astryx experimental export
 * --reverse`: enough for rendered markup, plus the helpers that ask it which
 * Astryx component an element came from. Its scanner also finds the parts of
 * a rendered file that a reverse compares.
 *
 * @position foundation/render — used by rebuild.mjs, markup-edits.mjs,
 * source-block.mjs and the render subject
 */

/** @typedef {{tag: string, attrs: Record<string, string>, children: Node[]}} ElementNode */
/** @typedef {ElementNode | {text: string}} Node */

export const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'source', 'track', 'wbr',
]);

/** @param {string} s */
export const decode = s =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&amp;/g, '&');

/**
 * Elements whose content is raw text up to their own end tag, as a browser's
 * tokenizer reads them: a tag or a comment opener in it is text.
 */
export const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'iframe', 'xmp', 'noembed', 'noframes']);

/**
 * One piece of an HTML document, by its place in the text. `raw` is the
 * content of a raw-text element.
 * @typedef {{kind: 'text' | 'raw' | 'comment' | 'cdata' | 'doctype', start: number, end: number}
 *   | {kind: 'end', tag: string, start: number, end: number}
 *   | {kind: 'start', tag: string, attrs: Array<[string, string]>, spans: Array<[number, number]>, selfClosing: boolean, start: number, end: number}} HtmlToken
 */

const SPACE = /[\t\n\f\r ]/;
const LETTER = /[a-zA-Z]/;
const DOCTYPE = /<!doctype/iy;

/**
 * The tag whose name starts at `i`, read as a browser reads it: an attribute
 * value is quoted or runs to a space or `>`, and a `/` just before `>` makes
 * the tag self-closing. `spans` holds where each attribute is, from its name
 * to the end of its value.
 * @param {string} html
 * @param {number} i the first letter of the name
 * @returns {{tag: string, attrs: Array<[string, string]>, spans: Array<[number, number]>, selfClosing: boolean, end: number} | 'open'}
 *   'open' when no `>` ends the tag, so the rest of the document is text
 */
export function readTag(html, i) {
  const n = html.length;
  const nameStart = i;
  // A browser reads a tag name up to white space, `/` or `>`.
  while (i < n && !SPACE.test(html[i]) && html[i] !== '/' && html[i] !== '>') i++;
  if (i >= n) return 'open';
  const tag = html.slice(nameStart, i).toLowerCase();
  /** @type {Array<[string, string]>} */
  const attrs = [];
  /** @type {Array<[number, number]>} */
  const spans = [];
  let selfClosing = false;
  while (i < n && html[i] !== '>') {
    if (SPACE.test(html[i])) {
      i++;
      continue;
    }
    if (html[i] === '/') {
      selfClosing = html[i + 1] === '>';
      i++;
      continue;
    }
    const nameAt = i++;
    while (i < n && !SPACE.test(html[i]) && html[i] !== '/' && html[i] !== '>' && html[i] !== '=') i++;
    const name = html.slice(nameAt, i).toLowerCase();
    let j = i;
    while (j < n && SPACE.test(html[j])) j++;
    let value = '';
    if (html[j] === '=') {
      j++;
      while (j < n && SPACE.test(html[j])) j++;
      const quote = html[j];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, j + 1);
        if (close < 0) return 'open';
        value = html.slice(j + 1, close);
        i = close + 1;
      } else {
        const from = j;
        while (j < n && !SPACE.test(html[j]) && html[j] !== '>') j++;
        value = html.slice(from, j);
        i = j;
      }
    }
    attrs.push([name, value]);
    spans.push([nameAt, i]);
  }
  return i >= n ? 'open' : {tag, attrs, spans, selfClosing, end: i + 1};
}

/**
 * Where the end tag of a raw-text element `tag` starts at or after `from`:
 * `</tag` followed by whitespace, `/` or `>`, in any case; else the end. A
 * longer name (`</textareas>`) ends nothing.
 * @param {string} html
 * @param {string} tag
 * @param {number} from
 * @returns {number}
 */
function endTagAt(html, tag, from) {
  const end = new RegExp(`</${tag}(?=[\\t\\n\\f\\r />])`, 'gi');
  end.lastIndex = from;
  return end.exec(html)?.index ?? html.length;
}

/**
 * Where a script's text ends, as the HTML tokenizer's script data states
 * read it: after `<!--` the text is escaped, and an escaped `<script` opens a
 * double-escaped run that only its own `</script` closes, so the `</script>`
 * inside it ends nothing; `-->` returns to plain script data.
 * @param {string} html
 * @param {number} from
 * @returns {number}
 */
function scriptEnd(html, from) {
  const piece = /<!--|-->|<\/?script(?=[\t\n\f\r />])/gi;
  piece.lastIndex = from;
  /** @type {'data' | 'escaped' | 'double'} */
  let state = 'data';
  for (let m = piece.exec(html); m; m = piece.exec(html)) {
    const found = m[0].toLowerCase();
    if (found === '<!--') {
      if (state === 'data') state = 'escaped';
      // `<!-->` and `<!--->` close at once.
      if (state === 'escaped' && /^-?>/.test(html.slice(m.index + 4, m.index + 6))) state = 'data';
    } else if (found === '-->') {
      if (state !== 'data') state = 'data';
    } else if (found === '</script') {
      if (state === 'double') state = 'escaped';
      else return m.index;
    } else if (state === 'escaped') {
      state = 'double';
    }
  }
  return html.length;
}

/**
 * Split an HTML document into its pieces, in order, as a browser does for
 * the markup a render writes. A comment ends at the first `-->` after its
 * `<!--` (so `<!-->` and `<!--->` are whole comments), or at the end. A bogus
 * comment (`<?…`, a `<!` that starts no comment or doctype, or `</` before a
 * character that is not a letter) is a comment to the next `>`; inside
 * `<svg>` or `<math>`, `<![CDATA[` is a `cdata` piece to `]]>`. The content
 * of a raw-text element up to its end tag is one `raw` piece, so a tag or a
 * comment in a stylesheet is text; `<plaintext>` makes the rest of the
 * document one `raw` piece. A `<` that starts no tag is
 * text, and a tag that no `>` ends makes the rest text. Each character is
 * read a fixed number of times, so the time grows with the document's length.
 * @param {string} html
 * @returns {Generator<HtmlToken>}
 */
export function* scanHtml(html) {
  const n = html.length;
  let at = 0;
  let text = 0;
  // Inside <svg> or <math>, `<![CDATA[` opens a CDATA section to `]]>`. An
  // end tag closes only a root of its own name that is open, as the tree
  // builder reads it: a stray `</svg>` in <math> stays in MathML.
  /** @type {string[]} */
  const foreign = [];
  while (at < n) {
    const lt = html.indexOf('<', at);
    if (lt < 0) break;
    const next = html[lt + 1] ?? '';
    /** @type {HtmlToken | null} */
    let token = null;
    DOCTYPE.lastIndex = lt;
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 2);
      token = {kind: 'comment', start: lt, end: close < 0 ? n : close + 3};
    } else if (foreign.length > 0 && html.startsWith('<![CDATA[', lt)) {
      const close = html.indexOf(']]>', lt + 9);
      token = {kind: 'cdata', start: lt, end: close < 0 ? n : close + 3};
    } else if (DOCTYPE.test(html)) {
      const close = html.indexOf('>', lt);
      if (close < 0) break;
      token = {kind: 'doctype', start: lt, end: close + 1};
    } else if (next === '?' || next === '!' || (next === '/' && !LETTER.test(html[lt + 2] ?? '') && lt + 2 < n)) {
      const close = html.indexOf('>', lt + 2);
      token = {kind: 'comment', start: lt, end: close < 0 ? n : close + 1};
    } else if (LETTER.test(next) || (next === '/' && LETTER.test(html[lt + 2] ?? ''))) {
      const closing = next === '/';
      const read = readTag(html, lt + (closing ? 2 : 1));
      if (read === 'open') break;
      token = closing
        ? {kind: 'end', tag: read.tag, start: lt, end: read.end}
        : {
            kind: 'start',
            tag: read.tag,
            attrs: read.attrs,
            spans: read.spans,
            // A browser honours `/>` only in svg or math (and on their roots).
            selfClosing: read.selfClosing && (foreign.length > 0 || read.tag === 'svg' || read.tag === 'math'),
            start: lt,
            end: read.end,
          };
    }
    if (!token) {
      at = lt + 1;
      continue;
    }
    if (lt > text) yield {kind: 'text', start: text, end: lt};
    yield token;
    at = text = token.end;
    if ((token.kind === 'start' || token.kind === 'end') && (token.tag === 'svg' || token.tag === 'math')) {
      if (token.kind === 'start' && !token.selfClosing) foreign.push(token.tag);
      else if (token.kind === 'end' && foreign.includes(token.tag)) foreign.length = foreign.lastIndexOf(token.tag);
    }
    if (token.kind === 'start' && token.tag === 'plaintext') {
      if (at < n) yield {kind: 'raw', start: at, end: n};
      return;
    }
    // A self-closing raw-text element (an SVG `<title />`) holds nothing.
    if (token.kind === 'start' && RAW_TEXT.has(token.tag) && !token.selfClosing) {
      const stop = token.tag === 'script' ? scriptEnd(html, at) : endTagAt(html, token.tag, at);
      yield {kind: 'raw', start: at, end: stop};
      at = text = stop;
    }
  }
  if (n > text) yield {kind: 'text', start: text, end: n};
}

/**
 * A small, forgiving HTML parser: enough for rendered markup.
 * @param {string} html
 * @returns {ElementNode}
 */
export function parseHtml(html) {
  /** @type {ElementNode} */
  const root = {tag: '#root', attrs: {}, children: []};
  /** @type {ElementNode[]} */
  const stack = [root];
  for (const token of scanHtml(html)) {
    const top = stack[stack.length - 1];
    if (token.kind === 'text') {
      top.children.push({text: decode(html.slice(token.start, token.end))});
    } else if (token.kind === 'raw') {
      top.children.push({text: html.slice(token.start, token.end)});
    } else if (token.kind === 'end') {
      const at = stack.map(n => n.tag).lastIndexOf(token.tag);
      if (at > 0) stack.length = at;
    } else if (token.kind === 'start') {
      /** @type {Record<string, string>} */
      const attrs = {};
      for (const [name, value] of token.attrs) attrs[name] = decode(value);
      /** @type {ElementNode} */
      const node = {tag: token.tag, attrs, children: []};
      top.children.push(node);
      if (!token.selfClosing && (RAW_TEXT.has(token.tag) || !VOID.has(token.tag))) stack.push(node);
    }
  }
  return root;
}

/** @param {Node} n @returns {n is ElementNode} */
export const isEl = n => 'tag' in n;

/** Elements whose children React refuses or treats as a value. */
export const FORM_TAGS = new Set(['input', 'textarea', 'select']);

/**
 * Whether an element draws one of `tags` itself, not inside another Astryx
 * component it contains.
 * @param {ElementNode} n @param {Set<string>} tags @returns {boolean}
 */
export const hasTag = (n, tags) =>
  tags.has(n.tag) ||
  n.children.some(c => isEl(c) && !astryxClass(c) && hasTag(c, tags));

/** @param {ElementNode} n @param {string} tag @returns {ElementNode | undefined} */
export function find(n, tag) {
  for (const c of n.children) {
    if (!isEl(c)) continue;
    if (c.tag === tag) return c;
    const f = find(c, tag);
    if (f) return f;
  }
  return undefined;
}

/** @param {Node} n @returns {string} */
export const textOf = n =>
  isEl(n)
    ? n.tag === 'script' || n.tag === 'style'
      ? ''
      : n.children.map(textOf).join('')
    : n.text;

/** @param {ElementNode} n */
export const astryxClass = n =>
  (n.attrs.class ?? '')
    .split(/\s+/)
    .find(c => /^astryx-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c))
    ?.slice('astryx-'.length);

/**
 * Whether markup was rendered from Astryx components.
 * @param {string} html
 */
export const isAstryxMarkup = html => /\sclass="(?:[^"]*\s)?astryx-[a-z0-9]/.test(html);

