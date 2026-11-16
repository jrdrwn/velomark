// Velomark — a fast drop-in replacement for marked 18.1.3 (default options:
// gfm: true, breaks: false, pedantic: false, async: false).
//
// Written from scratch. Renders Markdown to HTML byte-identical to marked
// 18.1.3 for the inputs in the make.fun "Make Markdown rendering faster"
// bounty. Single-pass scanners, no dependencies, no regex backtracking on
// hot paths.

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, "\n");
  if (src === "") return "";
  const refs = Object.create(null);
  // First pass: collect link reference definitions (they may be used
  // before they are defined). Inline parsing is skipped to keep it fast;
  // the HTML is discarded. A definition always contains "]:", so when
  // the source has none, there can be no definitions and the pass is
  // skipped entirely.
  if (src.includes("]:")) {
    const st1 = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, noInline: true };
    renderBlocks(src, 0, src.length, true, refs, st1);
  }
  // Second pass: render with the complete set of definitions.
  const st = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true };
  return renderBlocks(src, 0, src.length, true, refs, st).html;
}

// ---------------------------------------------------------------- helpers

const PUNCT_ASCII = new Uint8Array(128);
for (const c of "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~") PUNCT_ASCII[c.charCodeAt(0)] = 1;

const PUNCT_RE = /[\p{P}\p{S}]/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;
const SPACE_RE = /\s/;

// ASCII punctuation only (marked's escape rule uses ASCII punctuation).
function isAsciiPunct(ch) {
  const c = ch.charCodeAt(0);
  return c < 128 && PUNCT_ASCII[c] === 1;
}
function isSpace(ch) {
  const c = ch.charCodeAt(0);
  return c < 128 ? c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 : SPACE_RE.test(ch);
}
function isPunct(ch) {
  const c = ch.charCodeAt(0);
  return c < 128 ? PUNCT_ASCII[c] === 1 : PUNCT_RE.test(ch);
}
// punctuation excluding '~' (used for emphasis delimiters in gfm mode)
function isPunctNoTilde(ch) {
  return ch !== "~" && isPunct(ch);
}
function isAlnum(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  return ALNUM_RE.test(ch);
}
// marked's "punctuation" rule: space or punctuation, but not * or _
function isPunctOrSpace(ch) {
  return ch === "*" || ch === "_" ? false : isSpace(ch) || isPunct(ch);
}

// Escape text for HTML output, preserving entity-like sequences
// (the "NoEncode" flavour of marked's escape).
function esc(s) {
  let out = "";
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    let rep = null;
    if (ch === "&") {
      const m = entityLikeAt(s, i);
      if (m === 0) rep = "&amp;";
    } else if (ch === "<") rep = "&lt;";
    else if (ch === ">") rep = "&gt;";
    else if (ch === '"') rep = "&quot;";
    else if (ch === "'") rep = "&#39;";
    if (rep !== null) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape with every & encoded (used for code spans, autolink hrefs/text).
function escAll(s) {
  let out = "";
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    let rep = null;
    if (ch === "&") rep = "&amp;";
    else if (ch === "<") rep = "&lt;";
    else if (ch === ">") rep = "&gt;";
    else if (ch === '"') rep = "&quot;";
    else if (ch === "'") rep = "&#39;";
    if (rep !== null) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Length of an entity-like sequence (&...;) starting at i, else 0.
function entityLikeAt(s, i) {
  if (s[i] !== "&") return 0;
  let j = i + 1;
  if (s[j] === "#") {
    j++;
    if (s[j] === "x" || s[j] === "X") {
      j++;
      const st = j;
      while (j < s.length && j - st < 6 && isHex(s[j])) j++;
      if (j === st || j - st > 6 || s[j] !== ";") return 0;
      return j + 1 - i;
    }
    const st = j;
    while (j < s.length && j - st < 7 && s[j] >= "0" && s[j] <= "9") j++;
    if (j === st || j - st > 7 || s[j] !== ";") return 0;
    return j + 1 - i;
  }
  const st = j;
  while (j < s.length && isWord(s[j])) j++;
  if (j === st || s[j] !== ";") return 0;
  return j + 1 - i;
}
function isHex(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}
function isWord(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

// Decode numeric character references in a text token, as marked does:
// only &#...; and &#x...; are decoded; named entities pass through.
// Value 0, surrogate, or > 0x10FFFF becomes U+FFFD; 38 becomes &amp;.
function decodeNumericEntities(s) {
  if (s.indexOf("&#") === -1) return s;
  let out = "";
  let start = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "&" && s[i + 1] === "#") {
      let j = i + 2;
      let val = -1;
      let ok = false;
      if (s[j] === "x" || s[j] === "X") {
        j++;
        const st = j;
        let v = 0;
        while (j < s.length && j - st < 6 && isHex(s[j])) {
          v = v * 16 + parseInt(s[j], 16);
          j++;
        }
        if (j > st && s[j] === ";") { val = v; ok = true; }
      } else {
        const st = j;
        let v = 0;
        while (j < s.length && j - st < 7 && s[j] >= "0" && s[j] <= "9") {
          v = v * 10 + (s.charCodeAt(j) - 48);
          j++;
        }
        if (j > st && s[j] === ";") { val = v; ok = true; }
      }
      if (ok) {
        let rep;
        if (val === 0 || (val >= 0xd800 && val <= 0xdfff) || val > 0x10ffff) rep = "\uFFFD";
        else if (val === 38) rep = "&amp;";
        else rep = String.fromCodePoint(val);
        if (i > start) out += s.slice(start, i);
        out += rep;
        start = j + 1;
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return start === 0 ? s : out + s.slice(start);
}

// marked's cleanUrl: encodeURI, then restore %25, null on error.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, "%");
  } catch {
    return null;
  }
}

// Reference-label normalisation (marked's F).
function normLabel(s) {
  return s.trim().replace(/\s+/g, " ").toLowerCase().toUpperCase().toLowerCase();
}

// Count of code points in a string (handles surrogate pairs).
function cpLen(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- inline

// RDelim scanners for emphasis / strikethrough (reconstructed from marked's
// rule shapes; global regexes, driven with lastIndex).
const RDELIM_AST = new RegExp(
  "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])" +
  "|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?=[\\s]|$)" +
  "|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?!\\*)(?=(?!~)[\\s\\p{P}\\p{S}]|$)" +
  "|(?!\\*)(?!~)[\\s\\p{P}\\p{S}](\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))" +
  "|[\\s](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])" +
  "|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])" +
  "|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))",
  "gu");
const RDELIM_UND = new RegExp(
  "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])" +
  "|(?!_)[\\p{P}\\p{S}](_+)(?=[\\s]|$)" +
  "|[^\\s\\p{P}\\p{S}](_+)(?!_)(?=[\\s\\p{P}\\p{S}]|$)" +
  "|(?!_)[\\s\\p{P}\\p{S}](_+)(?=[^\\s\\p{P}\\p{S}])" +
  "|[\\s](_+)(?!_)(?=[\\p{P}\\p{S}])" +
  "|(?!_)[\\p{P}\\p{S}](_+)(?!_)(?=[\\p{P}\\p{S}])",
  "gu");
const RDELIM_DEL = new RegExp(
  "^[^~]+(?=[^~])" +
  "|(?!~)[\\p{P}\\p{S}](~~?)(?=[\\s]|$)" +
  "|[^\\s\\p{P}\\p{S}](~~?)(?!~)(?=[\\s\\p{P}\\p{S}]|$)" +
  "|(?!~)[\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])" +
  "|[\\s](~~?)(?!~)(?=[\\p{P}\\p{S}])" +
  "|(?!~)[\\p{P}\\p{S}](~~?)(?!~)(?=[\\p{P}\\p{S}])" +
  "|[^\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])",
  "gu");

const TAG_RE = new RegExp(
  "<!-->|<!--->|<!--(?:(?!-->)[\\s\\S])*?-->|</[a-zA-Z][a-zA-Z0-9-]*\\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*\"[^\"]*\"|\\s*=\\s*'[^']*'|\\s*=\\s*[^\\s\"'=<>`]+)?)*?\\s*/?>|<\\?[\\s\\S]*?\\?>|<![a-zA-Z]+\\s[\\s\\S]*?>|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>",
  "y");
const AUTOLINK_RE = new RegExp(
  "<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\\s\\x00-\\x1f<>]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>",
  "y");
const URL_RE = new RegExp(
  "(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])(?:\\/[A-Za-z0-9@.]+)?)" +
  "|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9-]+\\.?)+[^\\s<]*" +
  "|[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])",
  "y");
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/y;
// Next position that needs inline handling: a structural char, an
// email '@', or the start of a bare URL. The inline loop jumps straight
// there instead of stepping through plain text one char at a time.
const INLINE_SPECIAL_RE = /[\\<[\`*_~\n@!]|www\.|https?:\/\/|ftp:\/\/|mailto:|xmpp:/gi;
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_PRE_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;

// Last index in `masked` where a run of each of '*', '_' and '~'
// starts preceded by a non-whitespace char (marked's fe()), in a
// single pass. Returns {star, und, tilde}.
function lastClosers(masked) {
  let star = -1, und = -1, tilde = -1;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c !== "*" && c !== "_" && c !== "~") continue;
    const prev = i === 0 ? "\n" : masked[i - 1];
    if (prev !== " " && prev !== "\t" && prev !== "\n" && prev !== "\r" && prev !== "\f") {
      if (c === "*") star = i;
      else if (c === "_") und = i;
      else tilde = i;
    }
    while (i + 1 < masked.length && masked[i + 1] === c) i++;
  }
  return { star, und, tilde };
}

// Pass 1 of the masking (marked's anyPunctuationOutsideCode): inside a
// code span, backticks become '+'; a backslash escape of punctuation
// becomes '++'. A code span's outer backtick runs are kept, and a
// backtick run that is not a code span is left alone. The result has
// the same length as the input.
function neutralizePunct(s) {
  const n = s.length;
  let out = "";
  let start = 0;
  let i = 0;
  while (i < n) {
    const ch = s[i];
    if (ch === "`") {
      const span = codeSpanLen(s, i);
      if (span > 0) {
        let j = i;
        while (j < n && s[j] === "`") j++;
        const ticks = j - i;
        const inner = s.slice(j, i + span - ticks).replace(/`/g, "+");
        if (inner.indexOf("+") >= 0) {
          if (i > start) out += s.slice(start, i);
          out += s.slice(i, j) + inner + s.slice(i + span - ticks, i + span);
          start = i + span;
        }
        i += span;
        continue;
      }
      // not a code span: the whole run is literal text
      while (i < n && s[i] === "`") i++;
      continue;
    } else if (ch === "\\" && i + 1 < n && isPunct(s[i + 1])) {
      if (i > start) out += s.slice(start, i);
      out += "++";
      i += 2;
      start = i;
      continue;
    }
    i++;
  }
  if (start === 0) return s;
  return out + s.slice(start);
}

// Build the masked source for an inline text: same length as the text,
// with *, _, ~ hidden inside code spans, links, images, HTML tags and
// known reference links, and \punct collapsed to ++. Used only by the
// emphasis / strikethrough scanners.
//
// Like marked's #n, this runs in two passes. Pass 1 (marked's
// anyPunctuationOutsideCode) neutralizes backticks inside a code span
// to '+' and \punct to '++', keeping the code span's outer backtick
// runs. Pass 2 (marked's blockSkip) then masks inline links, code
// spans and HTML tags. The two passes matter for a link whose label
// contains a code span with a backtick inside it: the real link regex
// cannot match that label, but after pass 1 the blockSkip link regex
// can — so the whole link is hidden from emStrong and no emphasis
// forms inside it.
function maskInline(text, refs) {
  let s = text;
  if (refs && text.includes("[")) {
    s = maskReflinks(s, refs);
  }
  s = neutralizePunct(s);
  const n = s.length;
  let out = "";
  let start = 0;
  let i = 0;
  while (i < n) {
    const ch = s[i];
    if (ch === "`") {
      const span = codeSpanLen(s, i);
      if (span > 0) {
        if (i > start) out += s.slice(start, i);
        out += "[" + "a".repeat(span - 2) + "]";
        i += span;
        start = i;
        continue;
      }
      // no matching closing run: the whole run is literal text
      while (i < n && s[i] === "`") i++;
      continue;
    } else if (ch === "[") {
      const link = inlineLinkLen(s, i);
      if (link > 0) {
        if (i > start) out += s.slice(start, i);
        out += "[" + "a".repeat(link - 2) + "]";
        i += link;
        start = i;
        continue;
      }
    } else if (ch === "!" && s[i + 1] === "[") {
      const link = inlineLinkLen(s, i + 1);
      if (link > 0) {
        if (i > start) out += s.slice(start, i);
        out += "![" + "a".repeat(link - 2) + "]";
        i += link + 1;
        start = i;
        continue;
      }
    } else if (ch === "<") {
      const tag = htmlTagLen(s, i);
      if (tag > 0) {
        if (i > start) out += s.slice(start, i);
        out += "[" + "a".repeat(tag - 2) + "]";
        i += tag;
        start = i;
        continue;
      }
    } else if (ch === "\\" && i + 1 < n && isPunct(s[i + 1])) {
      if (i > start) out += s.slice(start, i);
      out += "++";
      i += 2;
      start = i;
      continue;
    }
    i++;
  }
  if (start === 0) return s;
  return out + s.slice(start);
}

// Length of a code span starting at i (s[i] === '`'), 0 if none.
function codeSpanLen(s, i) {
  let j = i;
  while (j < s.length && s[j] === "`") j++;
  const ticks = j - i;
  if (j >= s.length || s[j] === "`") return 0;
  let k = j;
  while (k < s.length) {
    if (s[k] === "`") {
      let m = k;
      while (m < s.length && s[m] === "`") m++;
      if (m - k === ticks && s[m] !== "`") return m - i;
      k = m;
    } else k++;
  }
  return 0;
}

// Length of an inline link `[text](...)` starting at i (s[i] === '['),
// 0 if the shape does not match. Used for masking only, so the label
// is parsed with marked's blockSkip rule (equal-length backtick runs).
function inlineLinkLen(s, i) {
  const label = parseLabel(s, i, true);
  if (!label) return 0;
  // for masking, marked's blockSkip only matches links whose label
  // has no nested brackets; a label containing '[' or ']' is not
  // masked (its '*'s stay visible to emStrong)
  const lt = label.text;
  for (let q = 0; q < lt.length; q++) {
    if (lt[q] === "\\") { q++; continue; }
    if (lt[q] === "[" || lt[q] === "]") return 0;
  }
  let j = label.end;
  if (s[j] !== "(") return 0;
  j++;
  while (j < s.length && (s[j] === " " || s[j] === "\t" || s[j] === "\n")) j++;
  if (s[j] === "<") {
    j++;
    while (j < s.length && s[j] !== ">" && s[j] !== "\n") {
      if (s[j] === "\\") j++;
      j++;
    }
    if (s[j] !== ">") return 0;
    j++;
  } else {
    // bare dest: non-space chars, tracking paren depth; stops at the
    // first ')' at depth 0 (the link's closing paren)
    let depth = 0;
    while (j < s.length) {
      const c = s[j];
      if (c === " " || c === "\t" || c === "\n" || s.charCodeAt(j) <= 31) break;
      if (c === "\\") { j += 2; continue; }
      if (c === "(") depth++;
      else if (c === ")") {
        if (depth === 0) break;
        depth--;
      }
      j++;
    }
  }
  let k = j;
  let sep = 0;
  while (k < s.length && (s[k] === " " || s[k] === "\t")) { k++; sep++; }
  if (k < s.length && s[k] === "\n") { k++; while (k < s.length && (s[k] === " " || s[k] === "\t")) k++; sep++; }
  if (sep > 0 && k < s.length) {
    const t = parseTitle(s, k);
    if (t) j = t.end;
  }
  while (j < s.length && (s[j] === " " || s[j] === "\t" || s[j] === "\n")) j++;
  if (s[j] !== ")") return 0;
  return j + 1 - i;
}

// Length of an inline HTML tag starting at i (s[i] === '<'), 0 if none.
function htmlTagLen(s, i) {
  if (s[i + 1] === " ") return 0;
  let j = i + 1;
  while (j < s.length && s[j] !== "<" && s[j] !== ">") j++;
  if (s[j] !== ">") return 0;
  return j + 1 - i;
}

// Parse a title starting at i. Returns {title, end} or null.
function parseTitle(s, i) {
  const q = s[i];
  if (q !== '"' && q !== "'" && q !== "(") return null;
  const close = q === "(" ? ")" : q;
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\") { j += 2; continue; }
    if (c === close) return { title: s.slice(i + 1, j), end: j + 1 };
    if (q === "'" && c === "\n") {
      let k = j + 1;
      while (k < s.length && (s[k] === " " || s[k] === "\t")) k++;
      if (s[k] === "\n") return null;
    }
    j++;
  }
  return null;
}

// Length of a code-span-shaped run in a link label, as matched by
// marked's label regex: a backtick run, content with no backticks or
// newlines, and a closing backtick run (the two runs may differ in
// length). Returns 0 if there is no such match — a backtick that is
// not part of one makes the whole label fail, because a backtick is
// not a plain label character.
function labelCodeSpanLen(s, i) {
  let j = i;
  while (j < s.length && s[j] === "`") j++;
  if (j === i) return 0;
  let k = j;
  while (k < s.length && s[k] !== "`" && s[k] !== "\n") k++;
  if (k === j) {
    // empty content: only valid if a closing run follows immediately
    if (k < s.length && s[k] === "`") {
      let m = k;
      while (m < s.length && s[m] === "`") m++;
      return m - i;
    }
    return 0;
  }
  if (k >= s.length || s[k] !== "`") return 0;
  let m = k;
  while (m < s.length && s[m] === "`") m++;
  return m - i;
}

// Length of a code-span-shaped run in a link label, as matched by
// marked's blockSkip link regex (used for masking only): a backtick
// run, content with no backticks or newlines, and a closing backtick
// run of the SAME length (the \k<a> backreference). Unlike the real
// label regex, runs of different lengths do not match, so a label
// containing `` ``small` `` is not a maskable link — and a backtick
// that closes such a span can then start a code span of its own in
// the masking pass, hiding what follows from emStrong.
function labelCodeSpanLenMask(s, i) {
  let j = i;
  while (j < s.length && s[j] === "`") j++;
  const ticks = j - i;
  if (ticks === 0) return 0;
  let k = j;
  while (k < s.length && s[k] !== "`" && s[k] !== "\n") k++;
  if (k === j) return 0;
  if (k >= s.length || s[k] !== "`") return 0;
  let m = k;
  while (m < s.length && s[m] === "`") m++;
  if (m - k !== ticks) return 0;
  return m - i;
}

// Parse a [...] label starting at i. Returns {text, end} or null.
// With mask=true, code spans inside the label must have equal-length
// backtick runs (marked's blockSkip rule, for masking only); the real
// label regex allows runs of different lengths.
function parseLabel(s, i, mask) {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "`") {
      if (mask) {
        const span = labelCodeSpanLenMask(s, j);
        if (span === 0) return null;
        j += span;
        continue;
      }
      // A code span whose content itself contains backticks is only
      // accepted when it runs to the very end of the label (its
      // closing run is immediately followed by ']'); try that long
      // interpretation first, before the strict regex span.
      const long = codeSpanLen(s, j);
      if (long > 0 && s[j + long] === "]") { j += long; continue; }
      const span = labelCodeSpanLen(s, j);
      if (span === 0) return null;
      j += span;
      continue;
    }
    if (c === "[") {
      // nested bracket group: scan with a depth counter so [a [b [c]]]
      // is consumed as one group
      let depth = 1;
      let k = j + 1;
      let ok = false;
      while (k < s.length) {
        if (s[k] === "\\") { k += 2; continue; }
        if (s[k] === "[") { depth++; k++; continue; }
        if (s[k] === "]") {
          depth--;
          if (depth === 0) { ok = true; break; }
          k++;
          continue;
        }
        if (s[k] === "\n") break;
        k++;
      }
      if (!ok) return null;
      j = k + 1;
      continue;
    }
    if (c === "]") return { text: s.slice(i + 1, j), end: j + 1 };
    j++;
  }
  return null;
}

// Mask known reference links in s (pass 0 of the masking).
function maskReflinks(s, refs) {
  let out = "";
  let start = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (s[i] === "[" || (s[i] === "!" && s[i + 1] === "[")) {
      const bang = s[i] === "!";
      const li = bang ? i + 1 : i;
      const label = parseLabel(s, li);
      if (label) {
        // marked's blockSkip only masks links whose label has no
        // nested brackets; a label containing '[' or ']' is not masked
        // (its '*'s stay visible to emStrong)
        let hasNested = false;
        for (let q = 0; q < label.text.length; q++) {
          if (label.text[q] === "\\") { q++; continue; }
          if (label.text[q] === "[" || label.text[q] === "]") { hasNested = true; break; }
        }
        if (hasNested) { i++; continue; }
        let j = label.end;
        let refLabel = null;
        let wholeEnd = 0;
        if (s[j] === "[") {
          let k = j + 1;
          while (k < n && s[k] !== "]" && s[k] !== "[" && s[k] !== "\\" && s[k] !== "\n") k++;
          if (s[k] === "]") {
            refLabel = s.slice(j + 1, k);
            wholeEnd = k + 1;
          }
        } else {
          refLabel = label.text;
          wholeEnd = j;
        }
        if (refLabel !== null && Object.hasOwn(refs, normLabel(refLabel))) {
          if (i > start) out += s.slice(start, i);
          const total = wholeEnd - i;
          out += (bang ? "!" : "") + "[" + "a".repeat(total - (bang ? 1 : 0) - 2) + "]";
          i = wholeEnd;
          start = i;
          continue;
        }
      }
    }
    i++;
  }
  if (start === 0) return s;
  return out + s.slice(start);
}

// ---------------------------------------------------------------- emStrong / del

function getMasked(ctx) {
  if (ctx.masked === null) {
    ctx.masked = maskInline(ctx.src, ctx.refs);
    const lc = lastClosers(ctx.masked);
    ctx.lastStar = lc.star;
    ctx.lastUnd = lc.und;
    ctx.lastTilde = lc.tilde;
  }
  return ctx.masked;
}

// Try emphasis/strong at src[i] (a run of '*' or '_'). Returns
// {len, html} or null. Follows marked's emStrong algorithm.
function tryEmStrong(src, i, prevChar, ctx) {
  const ch = src[i];
  const isStar = ch === "*";
  let j = i;
  while (j < src.length && src[j] === ch) j++;
  const runLen = j - i;
  const after = j < src.length ? src[j] : "";
  let d = "";
  let hasFollow = false;
  if (after !== "" && after !== ch) {
    if (isPunctNoTilde(after)) { d = after; hasFollow = true; }
    else if (!isSpace(after)) hasFollow = true;
  }
  if (!hasFollow && d === "") return null;
  const masked = getMasked(ctx);
  const o = prevChar === ch;
  let l = i;
  while (l > 0 && masked[l - 1] === ch) l--;
  const p = l > 0 ? masked[l - 1] : "";
  const h = p === "*" || p === "_" || isPunctOrSpace(p);
  let n = prevChar;
  if (l < i) n = p;
  const u = l < i ? h : isPunctOrSpace(n);
  if (!isStar && hasFollow && d === "" && isAlnum(n)) return null;
  if (!(d === "" || n === "" || u)) return null;
  const k = runLen;
  let m = k;
  let f = 0;
  const y = i - l + k;
  const R = p.trim() !== "" && (d !== "" || (isStar && !h));
  const A = isStar ? RDELIM_AST : RDELIM_UND;
  const v = isStar ? ctx.lastStar : ctx.lastUnd;
  const Q = i + k;
  if (v < Q) return null;
  const t2 = masked.slice(i + k);
  const ee = v - Q;
  A.lastIndex = 0;
  let s;
  while ((s = A.exec(t2)) !== null && s.index <= ee) {
    const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
    if (!g) continue;
    const b = cpLen(g);
    if (s[3] || s[4]) { m += b; continue; }
    if (s[5] || s[6] || R) {
      if (o && (s[5] || s[6])) break;
      if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
    }
    m -= b;
    if (m > 0) continue;
    const bb = Math.min(b, b + m + f);
    const firstCp = s[0].codePointAt(0);
    const te = firstCp > 0xffff ? 2 : 1;
    const rawLen = k + s.index + te + bb;
    const raw = src.slice(i, i + rawLen);
    if (Math.min(k, bb) % 2 === 1) {
      const inner = raw.slice(1, -1);
      return { len: rawLen, html: ctx.textMode ? inlineText(inner, ctx.refs, ctx.st) : "<em>" + inlineHTML(inner, ctx.refs, ctx.st) + "</em>" };
    }
    const inner = raw.slice(2, -2);
    return { len: rawLen, html: ctx.textMode ? inlineText(inner, ctx.refs, ctx.st) : "<strong>" + inlineHTML(inner, ctx.refs, ctx.st) + "</strong>" };
  }
  return null;
}

// Try strikethrough at src[i] (a run of '~'). Returns {len, html} or null.
function tryDel(src, i, prevChar, ctx) {
  let j = i;
  while (j < src.length && src[j] === "~") j++;
  const runLen = j - i;
  if (runLen > 2) return null;
  const after = j < src.length ? src[j] : "";
  let d = "";
  let hasFollow = false;
  if (after !== "" && after !== "~") {
    if (isPunct(after)) { d = after; hasFollow = true; }
    else if (!isSpace(after)) hasFollow = true;
  }
  if (!hasFollow && d === "") return null;
  if (d !== "" && prevChar !== "" && !isPunctOrSpace(prevChar)) return null;
  const masked = getMasked(ctx);
  const o = runLen;
  const u = ctx.lastTilde;
  const dd = i + o;
  if (u < dd) return null;
  const t2 = masked.slice(i + o);
  const kk = u - dd;
  const h = RDELIM_DEL;
  h.lastIndex = 0;
  let s;
  let p = o;
  while ((s = h.exec(t2)) !== null && s.index <= kk) {
    const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
    if (!g) continue;
    const l = cpLen(g);
    if (l !== o) continue;
    if (s[3] || s[4]) { p += l; continue; }
    p -= l;
    if (p > 0) continue;
    const ll = Math.min(l, l + p);
    const firstCp = s[0].codePointAt(0);
    const gg = firstCp > 0xffff ? 2 : 1;
    const rawLen = o + s.index + gg + ll;
    const raw = src.slice(i, i + rawLen);
    const inner = raw.slice(o, -o);
    return { len: rawLen, html: ctx.textMode ? inlineText(inner, ctx.refs, ctx.st) : "<del>" + inlineHTML(inner, ctx.refs, ctx.st) + "</del>" };
  }
  return null;
}

// Try a code span at src[i] (a backtick run). Returns {len, html} or null.
function tryCodeSpan(src, i, ctx) {
  const span = codeSpanLen(src, i);
  if (span === 0) return null;
  let ticks = 0;
  while (src[i + ticks] === "`") ticks++;
  let content = src.slice(i + ticks, i + span - ticks);
  content = content.replace(/\n/g, " ");
  const hasNonSpace = /[^ ]/.test(content);
  if (hasNonSpace && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32) {
    content = content.substring(1, content.length - 1);
  }
  return { len: span, html: ctx.textMode ? content : "<code>" + escAll(content) + "</code>" };
}

// Does the label text contain an unclosed '<tag'? (marked's Be)
function hasUnclosedTag(src, labelStart, labelText) {
  if (!labelText.includes("<")) return false;
  let s = 0;
  while (s < labelText.length) {
    const c = labelText[s];
    if (c === "\\") { s += 2; continue; }
    if (c === "`") {
      const span = codeSpanLen(labelText, s);
      if (span > 0) { s += span; continue; }
      s++;
      continue;
    }
    if (c !== "<") { s++; continue; }
    const pos = labelStart + s;
    TAG_RE.lastIndex = pos;
    let m = TAG_RE.exec(src);
    if (!m) {
      AUTOLINK_RE.lastIndex = pos;
      m = AUTOLINK_RE.exec(src);
    }
    if (m) {
      if (m[0].length > labelText.length - s) return true;
      s += m[0].length - 1;
    }
    s++;
  }
  return false;
}

// Count trailing backslashes in s.
function trailingBackslashes(s) {
  let n = 0;
  for (let i = s.length - 1; i >= 0 && s[i] === "\\"; i--) n++;
  return n;
}

// Balanced-parens check (marked's ke): -1 balanced/none, -2 unclosed '(',
// otherwise the index of the first unbalanced ')'.
function parenCheck(s) {
  if (s.indexOf("(") === -1 && s.indexOf(")") === -1) return -1;
  let t = 0;
  for (let n = 0; n < s.length; n++) {
    if (s[n] === "\\") { n++; continue; }
    if (s[n] === "(") t++;
    else if (s[n] === ")") { t--; if (t < 0) return n; }
  }
  return t > 0 ? -2 : -1;
}

// Unescape \punct -> punct.
function unescapePunct(s) {
  if (s.indexOf("\\") === -1) return s;
  let out = "";
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length && isPunct(s[i + 1])) {
      if (i > start) out += s.slice(start, i);
      out += s[i + 1];
      i++;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Build a link/image's HTML from its parts (marked's De), or null if the
// link is rejected (its text contains another link).
function buildLink(labelText, href, title, isImage, ctx, st) {
  const savedInLink = st.inLink;
  const savedEmitted = st.linkEmitted;
  const savedInRawBlock = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  // an image's alt text is always rendered in text mode (markup
  // stripped); a link's text follows the caller's mode
  const inner = (isImage || ctx.textMode) ? inlineText(labelText, ctx.refs, st) : inlineHTML(labelText, ctx.refs, st);
  const emittedInside = st.linkEmitted;
  st.linkEmitted = savedEmitted;
  st.inLink = savedInLink;
  if (!isImage) {
    // a link emitted inside the label rejects the whole link, and
    // the label parse's raw-block state is rolled back with it
    if (emittedInside) { st.inRawBlock = savedInRawBlock; return null; }
    st.linkEmitted = true;
  }
  const clean = cleanUrl(href);
  if (isImage) {
    if (ctx.textMode) return inner;
    if (clean === null) return esc(inner);
    let out = '<img src="' + esc(clean) + '" alt="' + esc(inner) + '"';
    if (title) out += ' title="' + esc(title) + '"';
    return out + ">";
  }
  if (clean === null) return inner;
  if (ctx.textMode) return inner;
  let out = '<a href="' + esc(clean) + '"';
  if (title) out += ' title="' + esc(title) + '"';
  return out + ">" + inner + "</a>";
}

// Try an inline link/image at src[i] (src[i] === '['). Returns
// {len, html} or null.
function tryInlineLink(src, i, ctx, st, isImage) {
  if (!st.linkParenPossible) return null;
  const label = parseLabel(src, i);
  if (!label) return null;
  let j = label.end;
  if (src[j] !== "(") return null;
  if (hasUnclosedTag(src, i + 1, label.text)) return null;
  j++;
  let k = j;
  while (k < src.length && (src[k] === " " || src[k] === "\t" || src[k] === "\n")) k++;
  let href = "";
  let hrefEnd = k;
  let isAngle = false;
  if (src[k] === "<") {
    let m = k + 1;
    let ok = false;
    while (m < src.length) {
      if (src[m] === "\\") { m += 2; continue; }
      if (src[m] === "\n" || src[m] === "<") break;
      if (src[m] === ">") { ok = true; break; }
      m++;
    }
    if (ok) {
      isAngle = true;
      href = src.slice(k + 1, m);
      hrefEnd = m + 1;
    } else {
      // a '<' dest with no valid closing '>' is not a link at all
      return null;
    }
  } else {
    // bare dest: non-space chars, tracking paren depth; the dest ends
    // at the first ')' that would close the link (depth 0)
    let depth = 0;
    while (hrefEnd < src.length) {
      const c = src[hrefEnd];
      if (c === " " || c === "\t" || c === "\n" || src.charCodeAt(hrefEnd) <= 31) break;
      if (c === "\\") { hrefEnd += 2; continue; }
      if (c === "(") depth++;
      else if (c === ")") {
        if (depth === 0) break;
        depth--;
      }
      hrefEnd++;
    }
    href = src.slice(k, hrefEnd);
  }
  let title = "";
  let end = hrefEnd;
  let t = hrefEnd;
  let sep = 0;
  while (t < src.length && (src[t] === " " || src[t] === "\t")) { t++; sep++; }
  if (t < src.length && src[t] === "\n") {
    t++;
    while (t < src.length && (src[t] === " " || src[t] === "\t")) t++;
    sep++;
  }
  if (sep > 0 && t < src.length) {
    const pt = parseTitle(src, t);
    if (pt) { title = pt.title; end = pt.end; }
  }
  let m2 = end;
  while (m2 < src.length && (src[m2] === " " || src[m2] === "\t" || src[m2] === "\n")) m2++;
  if (src[m2] !== ")") return null;
  let matchEnd = m2 + 1;
  const trimmed = href.trim();
  if (isAngle) {
    if (trailingBackslashes(trimmed.slice(0, -1)) % 2 === 1) return null;
  } else {
    const pc = parenCheck(href);
    if (pc === -2) return null;
    if (pc > -1) {
      href = href.substring(0, pc);
      title = "";
      matchEnd = k + pc + 1;
    }
  }
  if (trailingBackslashes(src.slice(i, matchEnd - 1)) % 2 === 1) return null;
  href = unescapePunct(href.trim());
  title = title ? unescapePunct(title) : "";
  // the label text is passed raw: the inline parser handles backslash
  // escapes itself, and unescaping first would turn an escaped
  // backtick into a lone one, breaking inner-link detection
  const labelText = label.text;
  const html = buildLink(labelText, href, title, isImage, ctx, st);
  if (html === null) return null;
  return { len: matchEnd - i, html };
}

// Try a reference link/image at src[i] (src[i] === '['). Returns
// {len, html} or null.
function tryRefLink(src, i, ctx, st, isImage) {
  const label = parseLabel(src, i);
  if (!label) return null;
  let j = label.end;
  let refLabel = null;
  let wholeEnd = 0;
  if (src[j] === "[") {
    let k = j + 1;
    while (k < src.length && src[k] !== "]" && src[k] !== "[" && src[k] !== "\n") {
      if (src[k] === "\\") { k += 2; continue; }
      k++;
    }
    if (src[k] !== "]") return null;
    refLabel = src.slice(j + 1, k);
    // collapsed reference link [text][]: the label is the text
    if (refLabel === "") refLabel = label.text;
    wholeEnd = k + 1;
  } else if (src[j] === "(") {
    // an inline link was already tried and failed at this '('
    // (tryInlineLink runs first), so fall back to the shortcut
    // reference link [text]
    refLabel = label.text;
    wholeEnd = j;
  } else {
    if (src[j] === "[" && src[j + 1] === "]") {
      refLabel = label.text;
      wholeEnd = j + 2;
    } else {
      refLabel = label.text;
      wholeEnd = j;
    }
  }
  if (hasUnclosedTag(src, i + 1, label.text)) return null;
  const ref = ctx.refs[normLabel(refLabel)];
  if (!ref) {
    return { len: 1, html: null, singleChar: true };
  }
  const labelText = label.text;
  const html = buildLink(labelText, ref.href, ref.title || "", isImage, ctx, st);
  if (html === null) return null;
  return { len: wholeEnd - i, html };
}

// Try an inline HTML tag or autolink at src[i] (src[i] === '<').
// Returns {len, html} or null, and updates st.inLink / st.inRawBlock.
function tryTag(src, i, ctx, st) {
  TAG_RE.lastIndex = i;
  let m = TAG_RE.exec(src);
  if (m) {
    const tag = m[0];
    if (!st.inLink && START_A_TAG.test(tag)) st.inLink = true;
    else if (st.inLink && END_A_TAG.test(tag)) st.inLink = false;
    if (!st.inRawBlock && START_PRE_TAG.test(tag)) st.inRawBlock = true;
    else if (st.inRawBlock && END_PRE_TAG.test(tag)) st.inRawBlock = false;
    return { len: tag.length, html: tag };
  }
  AUTOLINK_RE.lastIndex = i;
  m = AUTOLINK_RE.exec(src);
  if (m) {
    const text = m[1];
    const href = m[2] === "@" ? "mailto:" + text : text;
    if (ctx.textMode) return { len: m[0].length, html: text };
    const clean = cleanUrl(href);
    if (clean === null) return { len: m[0].length, html: escAll(text) };
    return { len: m[0].length, html: '<a href="' + escAll(clean) + '">' + escAll(text) + "</a>" };
  }
  return null;
}

// Try a GFM extended autolink (bare URL / email) at src[i].
// Returns {len, html} or null.
function tryUrl(src, i, ctx, st) {
  if (st.inLink) return null;
  URL_RE.lastIndex = i;
  const m = URL_RE.exec(src);
  if (!m) return null;
  let text, href;
  if (m[2] === "@") {
    text = m[0];
    href = "mailto:" + text;
  } else {
    let raw = m[0];
    let prev;
    do {
      prev = raw;
      BACKPEDAL_RE.lastIndex = 0;
      const b = BACKPEDAL_RE.exec(raw);
      raw = b ? b[0] : "";
    } while (raw !== prev);
    text = raw;
    href = m[1] === "www." ? "http://" + raw : raw;
  }
  if (ctx.textMode) return { len: text.length, html: text };
  const clean = cleanUrl(href);
  if (clean === null) return { len: text.length, html: escAll(text) };
  return { len: text.length, html: '<a href="' + escAll(clean) + '">' + escAll(text) + "</a>" };
}

// ---------------------------------------------------------------- inline loop

function isEmailLocalChar(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || "!#$%&'*+/=?^_`{|}~.-".includes(ch);
  return false;
}
function isWwwPrev(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v" || ch === "*" || ch === "_" || ch === "~" || ch === "(";
}
function hasNonSpaceAfter(s, pos) {
  for (let i = pos; i < s.length; i++) {
    const c = s[i];
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r" && c !== "\f" && c !== "\v") return true;
  }
  return false;
}

function inlineHTML(src, refs, st) {
  if (st.noInline) return "";
  const ctx = { src, refs, st, masked: null, textMode: false, lastStar: -1, lastUnd: -1, lastTilde: -1 };
  return inlineLoop(ctx);
}
function inlineText(src, refs, st) {
  if (st.noInline) return "";
  const ctx = { src, refs, st, masked: null, textMode: true, lastStar: -1, lastUnd: -1, lastTilde: -1 };
  return inlineLoop(ctx);
}

function inlineLoop(ctx) {
  const src = ctx.src;
  const st = ctx.st;
  const n = src.length;
  const savedLPP = st.linkParenPossible;
  st.linkParenPossible = savedLPP && src.includes(")");
  let out = "";
  let i = 0;
  let prevChar = "";
  let textStart = 0;

  const flushText = (end) => {
    if (end <= textStart) return;
    const raw = src.slice(textStart, end);
    if (ctx.textMode) {
      out += st.inRawBlock ? raw : decodeNumericEntities(raw);
    } else {
      out += st.inRawBlock ? raw : esc(decodeNumericEntities(raw));
    }
    if (raw.charCodeAt(raw.length - 1) !== 95) prevChar = raw[raw.length - 1];
    textStart = end;
  };
  const prevCharAt = () => {
    if (textStart < i) {
      const last = src[i - 1];
      return last === "_" ? prevChar : last;
    }
    return prevChar;
  };

  while (i < n) {
    // Fast-skip over plain text: jump to the next position that needs
    // handling (a structural char, '@', or a bare-URL start). The
    // skipped text is flushed when the special token is handled, or
    // at the end. prevCharAt() still sees the char just before i.
    INLINE_SPECIAL_RE.lastIndex = i;
    const sp = INLINE_SPECIAL_RE.exec(src);
    const nx = sp ? sp.index : n;
    if (nx > i) {
      i = nx;
      if (i >= n) break;
    }
    const ch = src[i];
    if (ch === "\\") {
      const nx = src[i + 1];
      if (nx !== undefined && isAsciiPunct(nx)) {
        flushText(i);
        out += ctx.textMode ? nx : esc(nx);
        i += 2;
        textStart = i;
        prevChar = "";
        continue;
      }
      if (nx === "\n" && hasNonSpaceAfter(src, i + 2)) {
        flushText(i);
        if (!ctx.textMode) out += "<br>";
        i += 2;
        while (i < n && (src[i] === " " || src[i] === "\t")) i++;
        textStart = i;
        prevChar = "";
        continue;
      }
      i++;
      continue;
    }
    if (ch === "<") {
      // flush the text before the tag first: the tag may flip
      // inRawBlock, and the text was scanned under the old state
      flushText(i);
      const r = tryTag(src, i, ctx, st);
      if (r) {
        out += r.html;
        i += r.len;
        textStart = i;
        prevChar = "";
        continue;
      }
      i++;
      continue;
    }
    if (ch === "[" || (ch === "!" && src[i + 1] === "[")) {
      const isImage = ch === "!";
      const li = isImage ? i + 1 : i;
      // flush first: parsing the link label may flip inRawBlock,
      // and the text before the link was scanned under the old state
      flushText(i);
      let r = tryInlineLink(src, li, ctx, st, isImage);
      if (r) {
        out += r.html;
        i += r.len + (isImage ? 1 : 0);
        textStart = i;
        prevChar = "";
        continue;
      }
      r = tryRefLink(src, li, ctx, st, isImage);
      if (r) {
        if (r.singleChar) {
          flushText(i + 1);
          i += 1;
          textStart = i;
          continue;
        }
        out += r.html;
        i += r.len + (isImage ? 1 : 0);
        textStart = i;
        prevChar = "";
        continue;
      }
      i++;
      continue;
    }
    if (ch === "`") {
      const r = tryCodeSpan(src, i, ctx);
      if (r) {
        flushText(i);
        out += r.html;
        i += r.len;
        textStart = i;
        prevChar = "";
        continue;
      }
      // no matching closing run: the whole backtick run is literal
      // text (a shorter run starting inside it must not open a span)
      while (i < n && src[i] === "`") i++;
      continue;
    }
    if (ch === "*" || ch === "_") {
      // NOTE: no flush here — `_` is an email local char, so text
      // before it may still belong to an email autolink scanned back
      // from a later `@`. Instead the raw-block state is saved around
      // the emphasis attempt: the text before it was scanned under
      // the old state, even if the emphasis content flips it.
      const savedRaw = st.inRawBlock;
      const r = tryEmStrong(src, i, prevCharAt(), ctx);
      if (r) {
        const newRaw = st.inRawBlock;
        st.inRawBlock = savedRaw;
        flushText(i);
        st.inRawBlock = newRaw;
        out += r.html;
        i += r.len;
        textStart = i;
        prevChar = "";
        continue;
      }
      // advance one char only: a shorter run starting at the next
      // position may still form emphasis (e.g. **foo* -> *<em>foo</em>)
      i++;
      continue;
    }
    if (ch === "~") {
      // as with emphasis: no flush here (`~` is an email local char),
      // save and restore the raw-block state around the attempt
      const savedRaw = st.inRawBlock;
      const r = tryDel(src, i, prevCharAt(), ctx);
      if (r) {
        const newRaw = st.inRawBlock;
        st.inRawBlock = savedRaw;
        flushText(i);
        st.inRawBlock = newRaw;
        out += r.html;
        i += r.len;
        textStart = i;
        prevChar = "";
        continue;
      }
      // advance one char only: a shorter run starting at the next
      // position may still form a del
      i++;
      continue;
    }
    if (ch === "\n") {
      let spaces = 0;
      let k = i - 1;
      while (k >= textStart && src[k] === " ") { spaces++; k--; }
      if (spaces >= 2 && hasNonSpaceAfter(src, i + 1)) {
        flushText(i - spaces);
        if (!ctx.textMode) out += "<br>";
        i++;
        while (i < n && (src[i] === " " || src[i] === "\t")) i++;
        textStart = i;
        prevChar = "";
        continue;
      }
      i++;
      continue;
    }
    if (!st.inLink) {
      if (ch === "w" && src.startsWith("www.", i) && (i === 0 || isWwwPrev(src[i - 1]))) {
        const r = tryUrl(src, i, ctx, st);
        if (r) { flushText(i); out += r.html; i += r.len; textStart = i; prevChar = ""; continue; }
      } else if ((ch === "h" || ch === "H") && /^https?:\/\//i.test(src.slice(i, i + 8))) {
        const r = tryUrl(src, i, ctx, st);
        if (r) { flushText(i); out += r.html; i += r.len; textStart = i; prevChar = ""; continue; }
      } else if ((ch === "f" || ch === "F") && /^ftp:\/\//i.test(src.slice(i, i + 6))) {
        const r = tryUrl(src, i, ctx, st);
        if (r) { flushText(i); out += r.html; i += r.len; textStart = i; prevChar = ""; continue; }
      } else if (ch === "m" && src.startsWith("mailto:", i) && (i === 0 || !isAlnum(src[i - 1]))) {
        const r = tryUrl(src, i, ctx, st);
        if (r) { flushText(i); out += r.html; i += r.len; textStart = i; prevChar = ""; continue; }
      } else if (ch === "x" && src.startsWith("xmpp:", i) && (i === 0 || !isAlnum(src[i - 1]))) {
        const r = tryUrl(src, i, ctx, st);
        if (r) { flushText(i); out += r.html; i += r.len; textStart = i; prevChar = ""; continue; }
      } else if (ch === "@") {
        let s = i - 1;
        while (s >= textStart && isEmailLocalChar(src[s])) s--;
        const start = s + 1;
        if (start < i) {
          const r = tryUrl(src, start, ctx, st);
          if (r) { flushText(start); out += r.html; i = start + r.len; textStart = i; prevChar = ""; continue; }
        }
      }
    }
    i++;
  }
  flushText(n);
  st.linkParenPossible = savedLPP;
  return out;
}

// ---------------------------------------------------------------- blocks

function lineEndIdx(src, pos, end) {
  const i = src.indexOf("\n", pos);
  return i === -1 || i >= end ? end : i;
}
function isBlankLine(src, pos, le) {
  for (let i = pos; i < le; i++) {
    if (src[i] !== " " && src[i] !== "\t") return false;
  }
  return true;
}
// Indent in columns (tab advances to next multiple of 4) and the index of
// the first non-space/tab char.
function indentInfo(src, pos, le) {
  let cols = 0;
  let i = pos;
  while (i < le) {
    const c = src[i];
    if (c === " ") { cols++; i++; }
    else if (c === "\t") { cols += 4 - (cols % 4); i++; }
    else break;
  }
  return { cols, idx: i };
}
// Remove one indent level (up to 4 columns) from the start of a line.
function deindentLine(src, pos, le) {
  let cols = 0;
  let i = pos;
  while (i < le && cols < 4) {
    const c = src[i];
    if (c === " ") { cols++; i++; }
    else if (c === "\t") { cols += 4 - (cols % 4); i++; if (cols > 4) { /* tab overshoots: keep a space */ } }
    else break;
  }
  return src.slice(i, le);
}
// marked's ge(): trim trailing blank lines, keeping at most one trailing \n.
function trimTrailingBlank(raw) {
  const parts = raw.split("\n");
  let t = parts.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(parts[t])) t--;
  if (parts.length - t <= 2) return raw;
  return parts.slice(0, t + 1).join("\n");
}
function renderCodeBlock(text, lang) {
  // marked's code renderer: a non-empty text loses one trailing
  // newline and gains one back — so even a text of just "\n" renders
  // as "\n"; only a truly empty text renders empty
  const stripped = text ? text.replace(/\n$/, "") : "";
  const body = text ? stripped + "\n" : "";
  const escBody = escAll(body);
  if (lang) return '<pre><code class="language-' + esc(lang) + '">' + escBody + "</code></pre>\n";
  return "<pre><code>" + escBody + "</code></pre>\n";
}

// --- fences ------------------------------------------------------------
function tryFences(src, pos, end) {
  const le = lineEndIdx(src, pos, end);
  const { cols, idx } = indentInfo(src, pos, le);
  if (cols > 3) return null;
  const fenceCh = src[idx];
  if (fenceCh !== "`" && fenceCh !== "~") return null;
  let j = idx;
  while (j < le && src[j] === fenceCh) j++;
  const fenceLen = j - idx;
  if (fenceLen < 3) return null;
  const info = src.slice(j, le);
  if (fenceCh === "`" && info.includes("`")) return null;
  const lang = info.trim().split(/\s+/)[0] || "";
  // find the closing fence
  let p = le + 1;
  let closeStart = -1;
  let closeEnd = end;
  while (p < end) {
    const le2 = lineEndIdx(src, p, end);
    const { cols: c2, idx: i2 } = indentInfo(src, p, le2);
    if (c2 <= 3 && src[i2] === fenceCh) {
      let k = i2;
      while (k < le2 && src[k] === fenceCh) k++;
      if (k - i2 >= fenceLen) {
        let ok = true;
        for (let m = k; m < le2; m++) if (src[m] !== " " && src[m] !== "\t") { ok = false; break; }
        if (ok) { closeStart = p; closeEnd = le2; break; }
      }
    }
    p = le2 + 1;
  }
  const openEnd = le + 1;
  const contentEnd = closeStart === -1 ? end : closeStart;
  // the content is the lines between the fences; the newline right
  // before the closing fence line is the last line's terminator, not
  // part of the content (otherwise a blank line before the close
  // fence would add a spurious trailing newline)
  let rawContent = src.slice(openEnd, contentEnd);
  if (rawContent.endsWith("\n")) rawContent = rawContent.slice(0, -1);
  // strip up to the opening fence's indent from each line (marked's Dt)
  // — but only for backtick fences; tilde fences keep content indent
  const indentLen = fenceCh === "`" ? idx - pos : 0;
  const content = rawContent.split("\n").map((line) => {
    let strip = 0;
    while (strip < line.length && strip < indentLen && (line[strip] === " " || line[strip] === "\t")) strip++;
    return line.slice(strip);
  }).join("\n");
  const rawEnd = closeStart === -1 ? end : closeEnd + (closeEnd < end ? 1 : 0);
  const html = renderCodeBlock(content, lang ? unescapePunct(lang) : "");
  return { end: rawEnd, html };
}

// --- ATX heading --------------------------------------------------------
function tryHeading(src, pos, end, refs, st) {
  const le = lineEndIdx(src, pos, end);
  const { cols, idx } = indentInfo(src, pos, le);
  if (cols > 3) return null;
  if (src[idx] !== "#") return null;
  let j = idx;
  while (j < le && src[j] === "#") j++;
  const level = j - idx;
  if (level > 6) return null;
  if (j < le && src[j] !== " " && src[j] !== "\t") return null;
  let text = src.slice(j, le);
  // strip closing hashes (only if preceded by space/tab)
  text = text.replace(/[ \t]+#+[ \t]*$/, "").replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
  const rawEnd = le + (le < end ? 1 : 0);
  return { end: rawEnd, html: "<h" + level + ">" + inlineHTML(text, refs, st) + "</h" + level + ">\n" };
}

// --- thematic break ------------------------------------------------------
function isHrLine(src, pos, le) {
  const { cols, idx } = indentInfo(src, pos, le);
  if (cols > 3) return false;
  const c = src[idx];
  if (c !== "-" && c !== "_" && c !== "*") return false;
  let count = 0;
  for (let i = idx; i < le; i++) {
    const ch = src[i];
    if (ch === c) count++;
    else if (ch !== " " && ch !== "\t") return false;
  }
  return count >= 3;
}

// --- HTML block -----------------------------------------------------------
const BLOCK_TAGS = new Set("address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul".split(" "));
function tryHtml(src, pos, end) {
  const le = lineEndIdx(src, pos, end);
  const { cols, idx } = indentInfo(src, pos, le);
  if (cols > 3) return null;
  if (src[idx] !== "<") return null;
  const rest = src.slice(idx, le);
  let type = 0;
  let endRe = null;
  let m;
  // type 1: script/pre/style/textarea. The char after the tag name is
  // checked in the source (it may be a newline if the tag spans lines).
  const afterTag1 = /^<(script|pre|style|textarea)(?=[\s>])/i.exec(src.slice(idx, idx + 12));
  if (afterTag1) { type = 1; endRe = /<\/(script|pre|style|textarea)>/i; }
  else if (rest.startsWith("<!--")) { type = 2; endRe = /-->/; }
  else if (rest.startsWith("<?")) { type = 3; endRe = /\?>/; }
  else if (/^<![A-Z]/.test(rest)) { type = 4; endRe = />/; }
  else if (rest.startsWith("<![CDATA[")) { type = 5; endRe = /\]\]>/; }
  else if ((m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(rest)) && BLOCK_TAGS.has(m[1].toLowerCase())) {
    // type 6: a block tag (opening or closing), followed by space/tab,
    // '/', '>', or end of line
    const after = rest[m[0].length];
    if (after === undefined || after === " " || after === "\t" || after === "/" || after === ">") type = 6;
  }
  if (type === 0) {
    // type 7: a complete opening tag (not script/pre/style/textarea) or
    // a complete closing tag, alone on its line; attributes must be
    // well-formed (valid names and quoted/unquoted values)
    const openTag = /^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>$/.test(rest);
    if (openTag && !/^<(script|pre|style|textarea)[\s/>]/i.test(rest)) type = 7;
    else if (/^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>$/.test(rest)) type = 7;
  }
  if (type === 0) return null;
  if (type <= 5) {
    // ends at the matching end marker or EOF; the raw then includes the
    // rest of that line plus any following blank lines (ge trims them)
    let p = idx;
    let found = -1;
    if (type === 1) {
      const tagName = /^(script|pre|style|textarea)/i.exec(rest.slice(1))[1].toLowerCase();
      const re = new RegExp("</" + tagName + "\\s*>", "i");
      const mm = re.exec(src.slice(idx, end));
      if (mm) found = idx + mm.index + mm[0].length;
    } else {
      const mm = endRe.exec(src.slice(idx, end));
      if (mm) found = idx + mm.index + mm[0].length;
    }
    let rawEnd;
    if (found === -1) rawEnd = end;
    else {
      rawEnd = found;
      // include the rest of the line (up to and including \n)
      const le2 = lineEndIdx(src, found, end);
      rawEnd = le2 + (le2 < end ? 1 : 0);
      // include following blank lines (ge will trim them)
      while (rawEnd < end) {
        const le3 = lineEndIdx(src, rawEnd, end);
        if (!isBlankLine(src, rawEnd, le3)) break;
        rawEnd = le3 + 1;
      }
    }
    let raw = src.slice(pos, rawEnd);
    const beforeLen = raw.length;
    raw = trimTrailingBlank(raw);
    // if trimming removed blank lines that contained a space or tab,
    // marked keeps one trailing newline; purely empty blank lines
    // leave no trailing newline
    if (raw.length < beforeLen && !raw.endsWith("\n") && /[ \t]/.test(src.slice(pos + raw.length, pos + beforeLen))) raw += "\n";
    return { end: pos + raw.length, html: raw, canInterrupt: true };
  }
  // types 6 and 7 end at a blank line. The raw includes the blank line
  // run (ge trims it back, keeping at most one trailing \n).
  let p = le + 1;
  while (p < end) {
    const le2 = lineEndIdx(src, p, end);
    if (isBlankLine(src, p, le2)) {
      // consume the whole blank-line run
      p = le2 + 1;
      while (p < end) {
        const le3 = lineEndIdx(src, p, end);
        if (!isBlankLine(src, p, le3)) break;
        p = le3 + 1;
      }
      break;
    }
    p = le2 + 1;
  }
  let raw = src.slice(pos, p);
  raw = trimTrailingBlank(raw);
  return { end: pos + raw.length, html: raw, canInterrupt: type === 6 };
}

// --- link reference definition --------------------------------------------
function tryDef(src, pos, end, refs) {
  const le = lineEndIdx(src, pos, end);
  const { cols, idx } = indentInfo(src, pos, le);
  if (cols > 3) return null;
  if (src[idx] !== "[") return null;
  const label = parseRefLabel(src, idx);
  if (!label) return null;
  let j = label.end;
  if (src[j] !== ":") return null;
  j++;
  // spaces, optional newline + spaces
  while (j < end && (src[j] === " " || src[j] === "\t")) j++;
  if (src[j] === "\n") {
    j++;
    while (j < end && (src[j] === " " || src[j] === "\t")) j++;
  }
  // dest: <...> or a bare non-space string
  let href = "";
  let destEnd = j;
  if (src[j] === "<") {
    let m = j + 1;
    while (m < end && src[m] !== ">" && src[m] !== "\n") m++;
    if (src[m] !== ">") return null;
    href = src.slice(j + 1, m);
    destEnd = m + 1;
  } else {
    while (destEnd < end && src[destEnd] !== " " && src[destEnd] !== "\t" && src[destEnd] !== "\n") destEnd++;
    href = src.slice(j, destEnd);
    if (href === "") return null;
  }
  if (!src.startsWith("<", j) && parenCheck(href) !== -1) return null;
  // optional title on the same line or the next line. It must be
  // preceded by a space or a newline; if it parses but leaves trailing
  // junk, the definition falls back to having no title.
  let title = "";
  let titleEnd = destEnd;
  let k = destEnd;
  let onNextLine = false;
  let sawSpace = false;
  while (k < end && (src[k] === " " || src[k] === "\t")) { k++; sawSpace = true; }
  if (src[k] === "\n") {
    onNextLine = true;
    k++;
    while (k < end && (src[k] === " " || src[k] === "\t")) k++;
  }
  let titleText = "";
  if (k < end && (src[k] === '"' || src[k] === "'" || src[k] === "(") && (sawSpace || onNextLine)) {
    const pt = parseTitle(src, k);
    if (pt) { titleEnd = pt.end; titleText = pt.title; }
  }
  // trailing spaces + newline/EOF
  let m = titleEnd;
  while (m < end && (src[m] === " " || src[m] === "\t")) m++;
  if (m < end && src[m] !== "\n") {
    if (titleEnd !== destEnd) {
      // retry without the title
      titleEnd = destEnd;
      titleText = "";
      m = destEnd;
      while (m < end && (src[m] === " " || src[m] === "\t")) m++;
      if (m < end && src[m] !== "\n") return null;
    } else {
      return null;
    }
  }
  title = titleText;
  const norm = normLabel(label.text);
  if (!Object.hasOwn(refs, norm)) {
    refs[norm] = { href: unescapePunct(href), title: title ? unescapePunct(title) : "" };
  }
  // raw excludes trailing newlines (marked's L(t[0], "\n"))
  return { end: m, html: "" };
}
// Reference label for a definition: [label] where the label is
// (?!\s*\])(?:\\[\s\S]|[^\[\]\\ \n]|\n(?![ \t]*\n))+
function parseRefLabel(src, i) {
  // src[i] === '['
  let j = i + 1;
  if (src[j] === "]") return null;
  let firstNonSpace = false;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") { j += 2; firstNonSpace = true; continue; }
    if (c === "]") {
      if (!firstNonSpace) return null;
      return { text: src.slice(i + 1, j), end: j + 1 };
    }
    if (c === "[" || c === "\n") {
      if (c === "\n") {
        let k = j + 1;
        while (k < src.length && (src[k] === " " || src[k] === "\t")) k++;
        if (src[k] === "\n") return null;
        j++;
        continue;
      }
      return null;
    }
    if (c !== " " && c !== "\t") firstNonSpace = true;
    j++;
  }
  return null;
}

// --- table -----------------------------------------------------------------
function splitTableRow(line) {
  // split on unescaped |, drop leading/trailing empty cells. A regex
  // split (done in the engine) is much faster than a per-char loop;
  // escaped pipes are restored afterwards, only in cells that have one.
  const cells = line.split(/(?<!\\)\|/);
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].includes("\\|")) cells[i] = cells[i].replace(/\\\|/g, "|");
  }
  if (cells.length > 0 && cells[0].trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === "") cells.pop();
  return cells;
}
function isDelimiterCell(cell) {
  const t = cell.trim();
  return /^:?-+:?$/.test(t);
}
function tryTable(src, pos, end, refs, st) {
  const le = lineEndIdx(src, pos, end);
  const headerLine = src.slice(pos, le);
  if (headerLine.includes("\n")) return null;
  // next line must be a delimiter row
  const le2 = lineEndIdx(src, le + 1, end);
  if (le + 1 >= end) return null;
  const delimLine = src.slice(le + 1, le2);
  const delimCells = splitTableRow(delimLine);
  if (delimCells.length === 0) return null;
  if (!delimCells.every(isDelimiterCell)) return null;
  if (!delimLine.includes(":") && !delimLine.includes("|")) return null;
  const headerCells = splitTableRow(headerLine);
  if (headerCells.length !== delimCells.length) return null;
  const aligns = delimCells.map((c) => {
    const t = c.trim();
    if (t.startsWith(":") && t.endsWith(":")) return "center";
    if (t.endsWith(":")) return "right";
    if (t.startsWith(":")) return "left";
    return "";
  });
  // body rows until a blank line or a line starting hr/heading/blockquote/code/fences/list/html
  const rows = [];
  let p = le2 + 1;
  while (p < end) {
    const le3 = lineEndIdx(src, p, end);
    // a whitespace-only line of 0-3 spaces + exactly one tab is a
    // (blank) table row, not a blank line ending the table
    const tabRow = /^ {0,3}\t$/.test(src.slice(p, le3));
    if (!tabRow && isBlankLine(src, p, le3)) break;
    if (isHrLine(src, p, le3)) break;
    const { cols, idx } = indentInfo(src, p, le3);
    if (cols <= 3) {
      if (src[idx] === "#") break;
      if (src[idx] === ">") break;
      if (src[idx] === "`" || src[idx] === "~") {
        let q = idx;
        while (q < le3 && src[q] === src[idx]) q++;
        if (q - idx >= 3) break;
      }
      if (src[idx] === "<") {
        const h = tryHtml(src, p, end);
        if (h) break;
      }
      if (isListStart(src, p, le3)) break;
    }
    if (!tabRow && cols >= 4) break;
    rows.push(src.slice(p, le3));
    p = le3 + 1;
  }
  let html = "<table>\n<thead>\n<tr>\n";
  for (let i = 0; i < headerCells.length; i++) {
    const a = aligns[i] ? ' align="' + aligns[i] + '"' : "";
    html += "<th" + a + ">" + inlineHTML(headerCells[i].trim(), refs, st) + "</th>\n";
  }
  html += "</tr>\n</thead>\n";
  if (rows.length > 0) {
    html += "<tbody>";
    for (const row of rows) {
      const cells = splitTableRow(row);
      html += "<tr>\n";
      for (let i = 0; i < headerCells.length; i++) {
        const cell = i < cells.length ? cells[i].trim() : "";
        const a = aligns[i] ? ' align="' + aligns[i] + '"' : "";
        html += "<td" + a + ">" + inlineHTML(cell, refs, st) + "</td>\n";
      }
      html += "</tr>\n";
    }
    html += "</tbody>";
  }
  html += "</table>\n";
  return { end: p, html };
}

// Does a table start at src[pos]? (header line + delimiter row)
function isTableStart(src, pos, end) {
  const le = lineEndIdx(src, pos, end);
  const headerLine = src.slice(pos, le);
  if (le + 1 >= end) return false;
  const le2 = lineEndIdx(src, le + 1, end);
  const delimLine = src.slice(le + 1, le2);
  // fast pre-check: a delimiter row is only ':', '-', '|' and spaces
  // (delimiter cells are :?-+:? separated by |). Most lines fail here
  // without paying for two row splits.
  if (!/^[ \t:|\-]+$/.test(delimLine)) return false;
  const delimCells = splitTableRow(delimLine);
  if (delimCells.length === 0) return false;
  if (!delimCells.every(isDelimiterCell)) return false;
  if (!delimLine.includes(":") && !delimLine.includes("|")) return false;
  const headerCells = splitTableRow(headerLine);
  return headerCells.length === delimCells.length;
}

// Does an hr start at src[idx] (indent already known to be <= 3)?
function isHrLineAt(src, idx, le) {
  const c = src[idx];
  if (c !== "-" && c !== "_" && c !== "*") return false;
  let count = 0;
  for (let i = idx; i < le; i++) {
    const ch = src[i];
    if (ch === c) count++;
    else if (ch !== " " && ch !== "\t") return false;
  }
  return count >= 3;
}
// Does a list start at src[idx] (indent already known to be <= 3)?
function isListStartAt(src, idx, le) {
  const c = src[idx];
  if (c === "-" || c === "+" || c === "*") {
    const after = src[idx + 1];
    if (after === undefined || after === " " || after === "\t" || after === "\n" || idx + 1 >= le) return true;
    return false;
  }
  if (c >= "0" && c <= "9") {
    let j = idx;
    while (j < le && src[j] >= "0" && src[j] <= "9") j++;
    if (j - idx > 9) return false;
    const d = src[j];
    if (d !== "." && d !== ")") return false;
    const after = src[j + 1];
    if (after === undefined || after === " " || after === "\t" || after === "\n" || j + 1 >= le) return true;
    return false;
  }
  return false;
}

// --- list -------------------------------------------------------------------
function isListStart(src, pos, le) {
  const { cols, idx } = indentInfo(src, pos, le);
  if (cols > 3) return null;
  const c = src[idx];
  if (c === "-" || c === "+" || c === "*") {
    const after = src[idx + 1];
    if (after === undefined || after === " " || after === "\t" || after === "\n" || idx + 1 >= le) {
      return { ordered: false, marker: c, markerEnd: idx + 1, start: null };
    }
    return null;
  }
  if (c >= "0" && c <= "9") {
    let j = idx;
    while (j < le && src[j] >= "0" && src[j] <= "9") j++;
    if (j - idx > 9) return null;
    const d = src[j];
    if (d !== "." && d !== ")") return null;
    const after = src[j + 1];
    if (after === undefined || after === " " || after === "\t" || after === "\n" || j + 1 >= le) {
      return { ordered: true, marker: src.slice(idx, j + 1), markerEnd: j + 1, start: parseInt(src.slice(idx, j), 10), delim: d };
    }
    return null;
  }
  return null;
}

// --- blockquote -------------------------------------------------------------
function tryBlockquote(src, pos, end, refs, st) {
  const le = lineEndIdx(src, pos, end);
  const { cols, idx } = indentInfo(src, pos, le);
  if (cols > 3 || src[idx] !== ">") return null;
  // Collect the quote's lines into chunks. A chunk ends at the first
  // non-'>' line after a '>' line; that line starts a new chunk. After
  // a chunk is parsed, if its last block is a code/heading/hr/html/
  // table block the quote ends there.
  const chunks = [];
  let cur = [];
  let curEnd = pos;
  let curHasGt = false;
  let lastWasBlank = false;
  let p = pos;
  // Track an unclosed fenced code block inside the current chunk (on
  // the '>'-stripped lines, exactly as the chunk's own render will see
  // them). A lazy line is only kept in the chunk while no fence is
  // open: an unclosed fence would swallow it, and marked ends the
  // chunk (and the quote) at the fence instead.
  let chunkFence = null;
  const fenceOpen = (line) => {
    // fast pre-check: a fence starts with ` or ~ within the first
    // 4 columns; most lines fail here without a regex exec.
    let i = 0;
    while (i < 3 && line.charCodeAt(i) === 32) i++;
    const c = line.charCodeAt(i);
    if (c !== 96 && c !== 126) return null;
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!m) return null;
    if (m[1][0] === "`" && /`/.test(line.slice(m[0].length))) return null;
    return { ch: m[1][0], len: m[1].length };
  };
  const fenceClose = (line, f) => {
    let i = 0;
    while (i < 3 && line.charCodeAt(i) === 32) i++;
    const c = line.charCodeAt(i);
    if (c !== 96 && c !== 126) return false;
    const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    return m && m[1][0] === f.ch && m[1].length >= f.len;
  };
  const trackFence = (line) => {
    if (chunkFence) {
      if (fenceClose(line, chunkFence)) chunkFence = null;
    } else {
      const fo = fenceOpen(line);
      if (fo) chunkFence = fo;
    }
  };

  const pushChunk = () => {
    if (cur.length > 0) chunks.push({ lines: cur, endPos: curEnd, hasGt: curHasGt });
    cur = [];
    curHasGt = false;
    chunkFence = null;
  };
  while (p < end) {
    const le2 = lineEndIdx(src, p, end);
    const { cols: c2, idx: i2 } = indentInfo(src, p, le2);
    if (c2 <= 3 && src[i2] === ">") {
      // strip '>' and one space. The whitespace after '>' is first
      // expanded to spaces (tabs advance to the next multiple of 4
      // columns, starting at the column after '>'), then one space is
      // removed.
      let k = i2 + 1;
      let w = k;
      while (w < le2 && (src[w] === " " || src[w] === "\t")) w++;
      const ws = expandTabs(src.slice(k, w), c2 + 1);
      const gtContent = ws.slice(1) + src.slice(w, le2);
      cur.push(gtContent);
      trackFence(gtContent);
      curHasGt = true;
      lastWasBlank = gtContent.trim() === "";
      p = le2 + 1;
      curEnd = p;
      continue;
    }
    if (isBlankLine(src, p, le2)) {
      // a truly blank line ends the quote (a '>' line does not)
      break;
    }
    // lazy continuation: a non-blank line that is not an interrupting block
    if (cur.length === 0) break;
    if (lastWasBlank) break;

    // interrupting blocks end the lazy continuation
    if (isHrLine(src, p, le2)) break;
    if (isListStart(src, p, le2)) break;
    if (isTableStart(src, p, end)) break;
    if (c2 <= 3) {
      if (src[i2] === "#") {
        // ATX heading interrupts
        let q = i2;
        while (q < le2 && src[q] === "#") q++;
        if (q - i2 >= 1 && q - i2 <= 6 && (q >= le2 || src[q] === " " || src[q] === "\t")) break;
      }
      if (src[i2] === "`" || src[i2] === "~") {
        let q = i2;
        while (q < le2 && src[q] === src[i2]) q++;
        if (q - i2 >= 3) break;
      }
      if (src[i2] === "<") {
        const h = tryHtml(src, p, end);
        if (h && h.canInterrupt) break;
      }
    }
    // a lazy line that is not an interrupting block starts a new chunk,
    // unless the chunk's content is a nested blockquote or a list: then
    // the lazy line stays in the chunk so the inner blockquote/list
    // handles it (it must reach the innermost paragraph). But only
    // while no fenced code block is open in the chunk: an unclosed
    // fence would swallow the lazy line, and marked ends the chunk
    // (and the quote) at the fence instead.
    let keepInChunk = false;
    if (cur.length > 0 && chunkFence === null) {
      const firstLine = cur[0];
      if (/^ {0,3}>/.test(firstLine)) keepInChunk = true;
      else if (isListStart(firstLine, 0, firstLine.length)) keepInChunk = true;
    }
    if (curHasGt && !keepInChunk) pushChunk();
    // A lazy setext underline is indented by 4 spaces so it cannot
    // form a heading — but only when it follows another line in the
    // chunk (marked's setext rule is anchored on the preceding
    // newline). Any other lazy line is passed through with its indent
    // intact: the chunk's own render decides what it is (an indented
    // line becomes an indented-code block, merged into the previous
    // paragraph with its indent stripped). A line kept for a nested
    // blockquote or list is passed through untouched; the inner
    // construct handles its indent.
    let lazyLine = src.slice(p, le2);
    if (!keepInChunk && isSetextUnderline(src, p, le2) && cur.length > 0) {
      const { idx: li } = indentInfo(src, p, le2);
      lazyLine = "    " + src.slice(li, le2);
    }
    cur.push(lazyLine);
    trackFence(lazyLine);
    p = le2 + 1;
    curEnd = p;
  }
  pushChunk();
  // parse the chunks, accumulating blocks. A chunk whose lines are
  // lazy continuations is re-parsed with the previous chunk's last
  // paragraph text prepended, so a lazy line continues that paragraph
  // (with the lazy de-indent); after a code/heading/hr/html/table
  // block the quote ends.
  const allBlocks = [];
  let quoteEnd = pos;
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const lines = chunk.lines.slice();
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length === 0) { quoteEnd = chunk.endPos; continue; }
    const innerSrc = lines.join("\n");
    // Render the chunk on its own. Like marked, a paragraph or an
    // indented-code block at the head of the chunk merges into the
    // previous chunk's trailing paragraph (a lazy continuation), and
    // so does a paragraph that directly follows such a merged code
    // block — unless a blank line intervenes. An indented-code block
    // keeps its trailing newline in its text, so a paragraph merged
    // after it is separated by a blank line in the text.
    const res = renderBlocks(innerSrc, 0, innerSrc.length, true, refs, st, true);
    for (const b of res.blocks) {
      const prev = allBlocks[allBlocks.length - 1];
      const mergeable = b.t === "para" || (b.kind === "code" && b.codeKind === "indented");
      if (mergeable && prev && prev.t === "para" && !b.blankBefore) {
        prev.text += "\n" + b.text;
        // the merged text must be re-parsed as one paragraph, so drop
        // the html computed for the unmerged text (it is re-parsed in
        // the final loop below, as before)
        prev.html = undefined;
      }
      else allBlocks.push(b);
    }
    quoteEnd = chunk.endPos;
    if (ci === chunks.length - 1) break;
    const last = allBlocks[allBlocks.length - 1];
    if (!last) break;
    if (last.kind === "code" || last.kind === "heading" || last.kind === "hr" || last.kind === "html" || last.kind === "table") break;
  }
  let html = "";
  for (const b of allBlocks) {
    if (b.t === "html") html += b.html;
    else if (b.t === "para") html += "<p>" + (b.html !== undefined ? b.html : inlineHTML(b.text, refs, st)) + "</p>\n";
    else html += b.html !== undefined ? b.html : inlineHTML(b.text, refs, st);
  }
  return { end: quoteEnd, html: "<blockquote>\n" + html + "</blockquote>\n" };
}

// --- list -------------------------------------------------------------------
function tryList(src, pos, end, refs, st) {
  const le = lineEndIdx(src, pos, end);
  const first = isListStart(src, pos, le);
  if (!first) return null;
  // a list cannot interrupt a paragraph if the first item is empty,
  // and an ordered list only if it starts at 1 (checked by caller)
  const items = [];
  let p = pos;
  let ordered = first.ordered;
  let startNum = first.start;
  let delim = first.delim;
  let bullet = first.marker;
  let listEnd = pos;
  let loose = false;
  while (p < end) {
    const le2 = lineEndIdx(src, p, end);
    // an hr ends the list (it wins over a list-item match)
    if (isHrLine(src, p, le2)) break;
    const cur = isListStart(src, p, le2);
    if (!cur) break;
    // same list? same bullet char or same ordered delimiter
    if (cur.ordered !== ordered) break;
    if (!ordered && cur.marker !== bullet) break;
    if (ordered && cur.delim !== delim) break;
    // content indent for this item: the marker (with its leading spaces)
    // plus the expanded whitespace after the marker (capped at 1 if > 4)
    const mi = indentInfo(src, p, le2).cols;
    const curMarkerLen = cur.markerEnd - (p + mi);
    let k = cur.markerEnd;
    let w = k;
    while (w < le2 && (src[w] === " " || src[w] === "\t")) w++;
    const wsExpanded = expandTabs(src.slice(k, w), mi + curMarkerLen);
    const wsLen = wsExpanded.length;
    let contentIndent;
    let firstLine;
    if (w >= le2) {
      // empty item: content starts on the next line
      contentIndent = mi + curMarkerLen + 1;
      firstLine = "";
    } else if (wsLen > 4) {
      contentIndent = mi + curMarkerLen + 1;
      firstLine = wsExpanded.slice(1) + src.slice(w, le2);
    } else {
      contentIndent = mi + curMarkerLen + wsLen;
      firstLine = wsExpanded.slice(wsLen) + src.slice(w, le2);
    }
    // collect this item's lines
    const itemLines = [];
    itemLines.push(firstLine);
    let q = le2 + 1;
    let pendingBlanks = [];
    let pendingBlankStart = -1;
    let itemEnd = q;
    let sawBlankBetween = false;
    let blankBeforeNext = false;
    // track a fenced code block inside the item: a content line with
    // less indent than the content indent cannot be fence content, so
    // it is not a lazy continuation either (the fence is unclosed
    // within the item)
    let inFence = null;
    // how many content lines the current fence has: a fence whose
    // first content line sits below the item's content indent is
    // unclosed within the item (the item ends, the fence stays empty)
    let fenceContent = 0;
    const fenceOpen = (line) => {
      // fast pre-check: a fence starts with ` or ~ within the first
      // 4 columns; most lines fail here without a regex exec.
      let i = 0;
      while (i < 3 && line.charCodeAt(i) === 32) i++;
      const c = line.charCodeAt(i);
      if (c !== 96 && c !== 126) return null;
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (!m) return null;
      if (m[1][0] === "`" && /`/.test(line.slice(m[0].length))) return null;
      return { ch: m[1][0], len: m[1].length };
    };
    const fenceClose = (line, f) => {
      let i = 0;
      while (i < 3 && line.charCodeAt(i) === 32) i++;
      const c = line.charCodeAt(i);
      if (c !== 96 && c !== 126) return false;
      const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      return m && m[1][0] === f.ch && m[1].length >= f.len;
    };
    if (firstLine.trim() !== "") {
      const fo = fenceOpen(firstLine);
      if (fo) { inFence = fo; fenceContent = 0; }
    }
    while (q < end) {
      const le3 = lineEndIdx(src, q, end);
      if (isBlankLine(src, q, le3)) {
        if (pendingBlanks.length === 0) pendingBlankStart = q;
        pendingBlanks.push("");
        q = le3 + 1;
        continue;
      }
      const { cols: c3, idx: i3 } = indentInfo(src, q, le3);
      if (c3 >= contentIndent) {
        // an empty item cannot gain content after a blank line
        if (pendingBlanks.length > 0 && itemLines.length === 1 && itemLines[0] === "") break;
        // indented content line: de-indent by contentIndent columns
        if (pendingBlanks.length > 0) {
          if (itemLines.length > 0 && itemLines[itemLines.length - 1] !== "") sawBlankBetween = true;
          itemLines.push(...pendingBlanks);
          pendingBlanks = [];
          pendingBlankStart = -1;
        }
        const dl = deindentByCols(src, q, le3, contentIndent);
        itemLines.push(dl);
        if (inFence) { if (fenceClose(dl, inFence)) inFence = null; else fenceContent++; }
        else { const fo = fenceOpen(dl); if (fo) { inFence = fo; fenceContent = 0; } }
        q = le3 + 1;
        itemEnd = q;
        continue;
      }
      // not indented enough: an hr or any list start ends the item.
      // (c3/i3 are already computed, so use the At-variants instead
      // of re-scanning the indent in isHrLine/isListStart.)
      if (c3 <= 3 && isHrLineAt(src, i3, le3)) break;
      if (c3 <= 3 && isListStartAt(src, i3, le3)) {
        // a blank line before the next item makes the list loose
        if (pendingBlanks.length > 0) { sawBlankBetween = true; blankBeforeNext = true; }
        break;
      }
      // inside a fenced code block, an under-indented line is still
      // fence content (the fence closes later); keep it in the item —
      // unless it would be the fence's first content line, in which
      // case the fence is unclosed within the item and the item ends
      // here (the fence stays empty). The closing fence itself is
      // always kept.
      if (inFence) {
        const rawLine = src.slice(q, le3);
        if (fenceClose(rawLine, inFence)) {
          if (pendingBlanks.length > 0) {
            itemLines.push(...pendingBlanks);
            pendingBlanks = [];
            pendingBlankStart = -1;
          }
          itemLines.push(rawLine);
          inFence = null;
          q = le3 + 1;
          itemEnd = q;
          continue;
        }
        if (fenceContent === 0) break;
        if (pendingBlanks.length > 0) {
          itemLines.push(...pendingBlanks);
          pendingBlanks = [];
          pendingBlankStart = -1;
        }
        itemLines.push(rawLine);
        fenceContent++;
        q = le3 + 1;
        itemEnd = q;
        continue;
      }
      // a blockquote line at an indent up to the content indent ends
      // the item (marked's blockquoteBeginRegex): the quote belongs to
      // the outer level, not to this item. (A '>' line indented at or
      // beyond the content indent is a content line, handled above.)
      if (c3 <= contentIndent && src[i3] === ">") break;
      // a lazy continuation line (a paragraph continuation with less
      // indent than the content indent) stays in the item, unless a
      // blank line intervened or it starts an interrupting block
      if (pendingBlanks.length > 0) break;
      let isInterrupting = false;
      if (isTableStart(src, q, end)) isInterrupting = true;
      else if (c3 <= 3) {
        const ch = src[i3];
        if (ch === "#") {
          let qq = i3;
          while (qq < le3 && src[qq] === "#") qq++;
          if (qq - i3 >= 1 && qq - i3 <= 6 && (qq >= le3 || src[qq] === " " || src[qq] === "\t")) isInterrupting = true;
        } else if (ch === "`" || ch === "~") {
          let qq = i3;
          while (qq < le3 && src[qq] === ch) qq++;
          if (qq - i3 >= 3) isInterrupting = true;
        } else if (ch === "<") {
          const h = tryHtml(src, q, end);
          if (h && h.canInterrupt) isInterrupting = true;
        }
      }
      if (isInterrupting) break;
      // a lazy line keeps its indent as-is in the item text (marked
      // appends the raw line to the item's text): a line indented 4+
      // columns becomes an indented-code block when the item text is
      // parsed, and merges into the preceding paragraph with one
      // indent level stripped there. De-indenting it here would strip
      // the level twice and turn e.g. '    - e' into a nested list
      // item instead of a paragraph continuation (cm-312).
      const dl2 = src.slice(q, le3);
      const prevLine = itemLines[itemLines.length - 1];
      // setext underline check (cheap pre-check: the first non-space
      // char must be '=' or '-'; the regex only runs then)
      const firstCh = src[i3];
      if ((firstCh === "=" || firstCh === "-") && /^ {0,3}(?:=+|-+)[ \t]*$/.test(dl2) && prevLine !== undefined && prevLine.trim() !== "" && isValidSetextText(prevLine)) {
        itemLines.push("    " + dl2.replace(/^ {0,3}/, ""));
      } else {
        itemLines.push(dl2);
      }
      if (inFence) { if (fenceClose(dl2, inFence)) inFence = null; else fenceContent++; }
      else { const fo = fenceOpen(dl2); if (fo) { inFence = fo; fenceContent = 0; } }
      q = le3 + 1;
      itemEnd = q;
      continue;
    }
    // trailing blank lines belong to the item's raw but are trimmed
    const itemText = itemLines.join("\n");
    items.push({ text: itemText, blankBetween: sawBlankBetween, blankBeforeNext, empty: firstLine.trim() === "" && itemLines.length === 1 });
    // the list ends before any trailing blank lines, so the outer
    // parser still sees them (and marks the content loose if a new
    // block follows them)
    listEnd = pendingBlanks.length > 0 && pendingBlankStart >= 0 ? pendingBlankStart : q;
    p = q;
    // if the next line is not a list item, the list ends
    if (p < end) {
      const le4 = lineEndIdx(src, p, end);
      const nx = isListStart(src, p, le4);
      if (!nx) break;
    }
  }
  if (items.length === 0) return null;
  // trim trailing blank lines from the last item
  const last = items[items.length - 1];
  last.text = last.text.replace(/\n+$/, "");
  // looseness: a blank line between two items, or any item whose own
  // top-level blocks are separated by a blank line. Blank lines inside
  // a nested list or fenced code block do not loosen the outer list,
  // so looseness is read from a (cheap, no-inline) parse of each item.
  // A blank line before a *different* list (or a trailing blank line)
  // does not count: the last item's blankBeforeNext only means the
  // next line started another list, not another item of this one.
  loose = false;
  for (let ii = 0; ii + 1 < items.length; ii++) {
    if (items[ii].blankBeforeNext) { loose = true; break; }
  }
  if (!loose) {
    const st2 = { noInline: true };
    for (const item of items) {
      if (item.text.trim() === "") continue;
      // an item with no blank line inside it cannot be loose (the
      // looseness flag only turns on when a blank line separates two
      // blocks), so skip the extra parse for it — most items
      if (!/\n[ \t]*\n/.test(item.text)) continue;
      // parse as text tokens, exactly like the real render, so a nested
      // list starting inside the item is recognised as a list and a
      // blank line inside it does not loosen the outer list
      const r = renderBlocks(item.text, 0, item.text.length, false, refs, st2);
      if (r.loose) { loose = true; break; }
    }
  }
  // render: list item content is always parsed as text tokens
  // (top=false); looseness only decides whether text blocks are
  // wrapped in <p> when rendered
  const tag = ordered ? "ol" : "ul";
  const startAttr = ordered && startNum !== 1 ? ' start="' + startNum + '"' : "";
  let html = "<" + tag + startAttr + ">\n";
  for (const item of items) {
    let text = item.text;
    let checked = null;
    const taskM = /^\[([ xX])\] /.exec(text);
    if (taskM) {
      checked = taskM[1] !== " ";
      text = text.slice(taskM[0].length);
    } else if (/^\[([ xX])\]$/.test(text)) {
      checked = text[1] !== " ";
      text = "";
    }
    const rb = renderBlocks(text, 0, text.length, false, refs, st);
    let inner = "";
    for (const b of rb.blocks) {
      if (b.t === "html") inner += b.html;
      // item blocks were inline-parsed during the item's collection
      // (in source order); only a block merged into afterwards needs
      // parsing here
      else if (loose) inner += "<p>" + (b.html !== undefined ? b.html : inlineHTML(b.text, refs, st)) + "</p>\n";
      else inner += b.html !== undefined ? b.html : inlineHTML(b.text, refs, st);
    }
    let itemHtml;
    if (checked === null) {
      itemHtml = "<li>" + inner + "</li>\n";
    } else {
      const cb = checked
        ? '<input checked="" disabled="" type="checkbox"> '
        : '<input disabled="" type="checkbox"> ';
      // in a loose list the checkbox lives inside the first paragraph
      if (loose && inner.startsWith("<p>")) {
        itemHtml = "<li><p>" + cb + inner.slice(3) + "</li>\n";
      } else {
        itemHtml = "<li>" + cb + inner + "</li>\n";
      }
    }
    html += itemHtml;
  }
  html += "</" + tag + ">\n";
  return { end: listEnd, html, loose };
}
// De-indent a line by `cols` columns. Tabs are first expanded to spaces
// (each tab advances to the next multiple of 4 columns), then `cols`
// leading spaces are removed. Lines without a tab in the leading
// whitespace are sliced directly (no per-char building).
function deindentByCols(src, pos, le, cols) {
  // find the end of the leading whitespace and whether it has a tab
  let i = pos;
  let hasTab = false;
  while (i < le) {
    const ch = src[i];
    if (ch === " ") i++;
    else if (ch === "\t") { hasTab = true; i++; }
    else break;
  }
  if (!hasTab) {
    // all spaces: just remove up to `cols` of them
    const remove = Math.min(cols, i - pos);
    return src.slice(pos + remove, le);
  }
  // expand only the leading whitespace to spaces, then remove `cols`
  const lead = expandTabs(src.slice(pos, i), 0);
  const remove = Math.min(cols, lead.length);
  return lead.slice(remove) + src.slice(i, le);
}

// Expand tabs in a string to spaces, starting at column `startCol`.
function expandTabs(s, startCol) {
  let out = "";
  let c = startCol;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\t") { const adv = 4 - (c % 4); out += " ".repeat(adv); c += adv; }
    else { out += s[i]; c++; }
  }
  return out;
}

// --- indented code -----------------------------------------------------------
function tryIndentedCode(src, pos, end, blocks, sawBlank, refs, st) {
  const le = lineEndIdx(src, pos, end);
  const { cols } = indentInfo(src, pos, le);
  if (cols < 4) return null;
  // collect the code lines (indented or blank); track the end of the last
  // non-blank line in source coordinates so `consumed` is exact
  let p = pos;
  let lastNonBlankEnd = pos;
  while (p < end) {
    const le2 = lineEndIdx(src, p, end);
    if (isBlankLine(src, p, le2)) {
      p = le2 + 1;
      continue;
    }
    const { cols: c2 } = indentInfo(src, p, le2);
    if (c2 < 4) break;
    lastNonBlankEnd = le2 + (le2 < end ? 1 : 0);
    p = le2 + 1;
  }
  let raw = src.slice(pos, lastNonBlankEnd);
  raw = trimTrailingBlank(raw);
  const text = raw.split("\n").map((line) => {
    if (line === "") return "";
    return deindentLine(line, 0, line.length);
  }).join("\n");
  const consumed = pos + raw.length;
  // merge into a preceding paragraph/text block if there was no blank line
  const prev = blocks[blocks.length - 1];
  if (!sawBlank && prev && (prev.t === "para" || prev.t === "text")) {
    prev.text += "\n" + text;
    // the paragraph's html was computed from the unmerged text:
    // re-parse it now, while the state is still the state at the
    // paragraph (the code lines themselves carry no inline state)
    if (prev.html !== undefined) prev.html = inlineHTML(prev.text, refs, st);
    return { end: consumed, merged: true };
  }
  return { end: consumed, html: renderCodeBlock(text, ""), text };
}

// --- paragraph / setext -------------------------------------------------------
function isSetextUnderline(src, pos, le) {
  const { cols, idx } = indentInfo(src, pos, le);
  if (cols > 3) return 0;
  const c = src[idx];
  if (c !== "=" && c !== "-") return 0;
  // a run of the same char, then only spaces/tabs to the end of the line
  let i = idx;
  while (i < le && src[i] === c) i++;
  while (i < le && (src[i] === " " || src[i] === "\t")) i++;
  if (i < le) return 0;
  return c === "=" ? 1 : 2;
}

function lineStartsInterruptingBlock(src, pos, end, paraText) {
  const le = lineEndIdx(src, pos, end);
  const { cols, idx } = indentInfo(src, pos, le);
  if (cols > 3) return false;
  if (isHrLine(src, pos, le)) return true;
  const c = src[idx];
  if (c === "#") {
    let q = idx;
    while (q < le && src[q] === "#") q++;
    if (q - idx >= 1 && q - idx <= 6 && (q >= le || src[q] === " " || src[q] === "\t")) return true;
  }
  if (c === ">") return true;
  if (c === "`" || c === "~") {
    let q = idx;
    while (q < le && src[q] === c) q++;
    if (q - idx >= 3) {
      // a backtick fence whose info string contains a backtick is not
      // a valid fence, so it does not interrupt a paragraph
      if (c === "`" && src.slice(q, le).includes("`")) return false;
      return true;
    }
  }
  if (c === "<") {
    const h = tryHtml(src, pos, end);
    if (h && h.canInterrupt) return true;
  }
  return false;
}
function tryParagraph(src, pos, end, top, refs, st, inQuote) {
  // collect lines until a blank line or an interrupting block.
  // The first line keeps its leading spaces (0-3), they are part of
  // the paragraph text.
  const lines = [];
  let p = pos;
  const firstLe = lineEndIdx(src, pos, end);
  lines.push(src.slice(pos, firstLe));
  p = firstLe + 1;
  while (p < end) {
    const le2 = lineEndIdx(src, p, end);
    // a whitespace-only line is blank only if followed by a newline;
    // at EOF it is a paragraph continuation line
    if (isBlankLine(src, p, le2) && le2 < end) break;
    // in a list item (text token), an indented code line is not a
    // continuation: it becomes a code block merged into the text token
    if (!top) {
      const { cols: cc } = indentInfo(src, p, le2);
      if (cc >= 4) break;
    }
    // setext underline ends the paragraph
    if (isSetextUnderline(src, p, le2)) break;
    // a list interrupts only if its first item is non-empty
    // (and, for ordered lists, starts at 1)
    const lst = isListStart(src, p, le2);
    if (lst) {
      const afterMarker = src.slice(lst.markerEnd, le2);
      // inside a list item (text token) an ordered list may interrupt
      // regardless of its start number; at the top level only start 1
      if (afterMarker.trim() !== "" && (!lst.ordered || lst.start === 1 || !top)) break;
    } else if (isTableStart(src, p, end)) break;
    else if (lineStartsInterruptingBlock(src, p, end, lines.join("\n"))) break;
    // a continuation line keeps its indent as-is here: a lazy line's
    // indent was already adjusted when the blockquote collected it,
    // and a line that came from a `>` marker keeps its content indent
    lines.push(src.slice(p, le2));
    p = le2 + 1;
  }
  const text = lines.join("\n");
  // setext heading? the next line is an underline and the text is valid.
  // The heading text is trimmed.
  if (p < end) {
    const le2 = lineEndIdx(src, p, end);
    const level = isSetextUnderline(src, p, le2);
    if (level > 0 && isValidSetextText(text)) {
      const rawEnd = le2 + (le2 < end ? 1 : 0);
      const htext = text.trim();
      return { end: rawEnd, html: "<h" + level + ">" + inlineHTML(htext, refs, st) + "</h" + level + ">\n" };
    }
  }
  return { end: p, text, isText: !top };
}
function isValidSetextText(text) {
  // the first line must not start with a bullet, indented code, fence,
  // blockquote, heading, a complete html tag, or a table; continuation
  // lines must not start with a bullet, fence, blockquote, heading, hr,
  // a complete html tag, or a table. A line is a "complete html tag"
  // only if it has a '>' (an incomplete tag like '<a title="x' is fine).
  const lines = text.split("\n");
  const first = lines[0];
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])/.test(first)) return false;
  if (/^(?: {4}| {0,3}\t)/.test(first)) return false;
  if (/^ {0,3}(?:`{3,}|~{3,})/.test(first)) return false;
  if (/^ {0,3}>/.test(first)) return false;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(first)) return false;
  if (/^ {0,3}<[^>\n]*>/.test(first)) return false;
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.trim() === "") return false;
    if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])/.test(ln)) return false;
    if (/^ {0,3}(?:`{3,}|~{3,})/.test(ln)) return false;
    if (/^ {0,3}>/.test(ln)) return false;
    if (/^ {0,3}#{1,6}(?:\s|$)/.test(ln)) return false;
    if (/^ {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})/.test(ln)) return false;
    if (/^ {0,3}<[^>\n]*>/.test(ln)) return false;
  }
  return true;
}

// --- main block loop ----------------------------------------------------------
// Returns { html, blocks } where each block has a `kind`
// (code|heading|hr|blockquote|list|html|table|paragraph|text) used by
// blockquote chunking. `inQuote` marks the direct inner content of a
// blockquote (lazy lines there lose one indent level).
function renderBlocks(src, start, end, top, refs, st, inQuote) {
  const blocks = [];
  let pos = start;
  let sawBlank = true;
  let loose = false;
  // whether a blank line was skipped since the last block was pushed
  // (a block pushed after one must not merge into a previous
  // paragraph, e.g. across blockquote chunks)
  let hadBlank = false;
  const pushBlock = (b) => { b.blankBefore = hadBlank; blocks.push(b); hadBlank = false; };
  while (pos < end) {
    const le = lineEndIdx(src, pos, end);
    if (isBlankLine(src, pos, le)) {
      pos = le + 1;
      sawBlank = true;
      hadBlank = true;
      continue;
    }
    // a blank line between two top-level blocks makes the content loose
    if (sawBlank && blocks.length > 0) loose = true;
    let r = tryFences(src, pos, end);
    if (r) { pushBlock({ t: "html", kind: "code", html: r.html, codeKind: "fenced" }); pos = r.end; sawBlank = false; continue; }
    r = tryHeading(src, pos, end, refs, st);
    if (r) { pushBlock({ t: "html", kind: "heading", html: r.html }); pos = r.end; sawBlank = false; continue; }
    if (isHrLine(src, pos, le)) { pushBlock({ t: "html", kind: "hr", html: "<hr>\n" }); pos = le + 1; sawBlank = false; continue; }
    r = tryBlockquote(src, pos, end, refs, st);
    if (r) { pushBlock({ t: "html", kind: "blockquote", html: r.html }); pos = r.end; sawBlank = false; continue; }
    // list: can it interrupt a paragraph?
    const lst = isListStart(src, pos, le);
    if (lst) {
      const prev = blocks[blocks.length - 1];
      const prevIsPara = prev && (prev.t === "para" || prev.t === "text") && !sawBlank;
      let canInterrupt = true;
      if (prevIsPara) {
        // only if the first item is non-empty, and ordered only if
        // start == 1 (at the top level; inside a list item any start
        // may interrupt a text token)
        const afterMarker = src.slice(lst.markerEnd, le);
        if (afterMarker.trim() === "") canInterrupt = false;
        if (lst.ordered && lst.start !== 1 && top) canInterrupt = false;
      }
      if (canInterrupt) {
        r = tryList(src, pos, end, refs, st);
        if (r) { pushBlock({ t: "html", kind: "list", html: r.html }); pos = r.end; sawBlank = false; continue; }
      }
    }
    r = tryHtml(src, pos, end);
    if (r) {
      const prev = blocks[blocks.length - 1];
      const prevIsPara = prev && (prev.t === "para" || prev.t === "text") && !sawBlank;
      if (!prevIsPara || r.canInterrupt) {
        pushBlock({ t: "html", kind: "html", html: r.html }); pos = r.end; sawBlank = false; continue;
      }
      // type 7 html cannot interrupt a paragraph: fall through to paragraph
    }
    r = tryDef(src, pos, end, refs);
    if (r) { pos = r.end; sawBlank = false; continue; }
    // table (can interrupt a paragraph)
    r = tryTable(src, pos, end, refs, st);
    if (r) { pushBlock({ t: "html", kind: "table", html: r.html }); pos = r.end; sawBlank = false; continue; }
    // indented code
    const { cols } = indentInfo(src, pos, le);
    if (cols >= 4) {
      r = tryIndentedCode(src, pos, end, blocks, sawBlank, refs, st);
      if (r) {
        if (!r.merged) pushBlock({ t: "html", kind: "code", html: r.html, codeKind: "indented", text: r.text });
        pos = r.end; sawBlank = false; continue;
      }
    }
    // paragraph (top) or text
    r = tryParagraph(src, pos, end, top, refs, st, inQuote);
    if (r.html) { pushBlock({ t: "html", kind: "heading", html: r.html }); pos = r.end; sawBlank = false; continue; }
    const pb = { t: top ? "para" : "text", kind: top ? "paragraph" : "text", text: r.text };
    // Parse the paragraph's inline content right away, in source
    // order: a '<a>' (or '<pre>') tag in this paragraph must set
    // inLink/inRawBlock for the blocks that follow it — lists and
    // blockquotes are parsed during this same collection loop, so if
    // the paragraph were parsed only in the render loop below, an
    // unclosed '<a>' here would not stop a GFM URL autolink in a
    // later list (marked parses inline content in token order).
    if (!st.noInline) pb.html = inlineHTML(r.text, refs, st);
    pushBlock(pb);
    pos = r.end;
    sawBlank = false;
  }
  let out = "";
  for (const b of blocks) {
    if (b.t === "html") out += b.html;
    // para/text blocks were inline-parsed during collection (in source
    // order); a block whose text was merged into after that (indented
    // code, blockquote chunks) has html === undefined and is parsed here
    else if (b.t === "para") out += "<p>" + (b.html !== undefined ? b.html : inlineHTML(b.text, refs, st)) + "</p>\n";
    else out += b.html !== undefined ? b.html : inlineHTML(b.text, refs, st);
  }
  return { html: out, blocks, loose };
}
