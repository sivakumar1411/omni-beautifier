/**
 * Click a bracket, select the block.
 *
 * The formatted pane knows more about the text than it lets on: every
 * `{`, `[`, `(` has a partner somewhere further down, and the span between
 * them is exactly the unit you usually want to grab — a JSON object, a Java
 * method body, a SQL sub-query. This module finds those pairs and makes them
 * clickable.
 *
 * Matching is done on the text, not the DOM, with per-language rules for
 * strings and comments so that a brace inside "not a { brace" or `/* { *\/`
 * cannot throw the count off. Markup is a special case: `<` and `>` are not
 * really brackets, so XML/HTML/SVG match *tags* instead, which means clicking
 * a tag name selects the whole element.
 *
 * Public surface:
 *   Brackets.profileFor(langId)      the syntax rules for a language
 *   Brackets.analyse(text, profile)  the pair table
 *   Brackets.paint(code, text, lang) wrap the clickable bits, arm the pairs
 *   Brackets.install(opts)           wire the listeners once
 *   Brackets.clear()                 forget the current pane
 */
(function (global) {
  const B = {};

  /** Past this many pairs the DOM cost stops being worth it. */
  const MAX_PAIRS = 40000;

  /* ------------------------------------------------------------------
     Syntax profiles

     brackets  pairs to match, as open/close characters
     line      line-comment openers
     block     [open, close] comment delimiters
     quotes    string delimiters
     escape    backslash escapes inside strings
     doubled   a doubled delimiter is an escaped delimiter ('' in SQL)
     triple    ''' and """ start a multi-line string (Python)
     urlGuard  '//' is only a comment when not preceded by ':' — so that
               url(http://x) keeps its parenthesis
     markup    match tags instead of brackets
     ------------------------------------------------------------------ */

  const PROFILES = {
    markup: { markup: true },

    json: {
      brackets: '{}[]', quotes: '"', escape: true,
      line: ['//'], block: [['/*', '*/']]
    },
    sql: {
      brackets: '()', quotes: '\'"`', escape: true, doubled: true,
      line: ['--', '#'], block: [['/*', '*/']]
    },
    clike: {
      brackets: '()[]{}', quotes: '\'"`', escape: true,
      line: ['//'], block: [['/*', '*/']]
    },
    css: {
      brackets: '()[]{}', quotes: '\'"', escape: true,
      line: ['//'], block: [['/*', '*/']], urlGuard: true
    },
    hash: {
      brackets: '()[]{}', quotes: '\'"', escape: true, line: ['#']
    },
    python: {
      brackets: '()[]{}', quotes: '\'"', escape: true, triple: true, line: ['#']
    },
    yaml: {
      // Parentheses are prose in YAML, not structure; only flow collections match.
      brackets: '[]{}', quotes: '\'"', escape: true, line: ['#']
    },
    ini: {
      brackets: '[]{}', quotes: '\'"', escape: true, line: ['#', ';']
    },
    // SOQL uses () for sub-queries and IN lists, and {} for the SOSL search
    // term. Square brackets belong to the Apex around it, not the query.
    soql: {
      brackets: '(){}', quotes: '\'"', escape: true,
      line: ['--'], block: [['/*', '*/']]
    },
    plain: {
      brackets: '()[]{}'
    }
  };

  const BY_LANG = {
    xml: 'markup', svg: 'markup', html: 'markup',
    // Salesforce: Apex is C-like (its inline SOQL sits in [square brackets],
    // which the clike profile already pairs), LWC templates and Visualforce
    // are markup, and LWC modules are ordinary JavaScript.
    apex: 'clike', soql: 'soql', lwcjs: 'clike',
    lwchtml: 'markup', visualforce: 'markup',
    json: 'json',
    sql: 'sql',
    javascript: 'clike', typescript: 'clike', java: 'clike', c: 'clike',
    cpp: 'clike', csharp: 'clike', kotlin: 'clike', go: 'clike', rust: 'clike',
    php: 'clike', swift: 'clike', scala: 'clike', dart: 'clike',
    css: 'css', scss: 'css', less: 'css',
    graphql: 'hash', bash: 'hash', ruby: 'hash',
    python: 'python',
    yaml: 'yaml',
    ini: 'ini',
    markdown: 'plain', plaintext: 'plain', csv: 'plain', diff: 'plain'
  };

  B.profileFor = function (langId) {
    const name = BY_LANG[langId];
    return name ? PROFILES[name] : null;
  };

  /* ------------------------------------------------------------------
     Bracket matching
     ------------------------------------------------------------------ */

  const OPPOSITE = { '(': ')', '[': ']', '{': '}' };

  const startsWith = (text, i, s) => text.startsWith(s, i);

  /** Skip a quoted string opened at `i`; returns the index just past it. */
  function skipString(text, i, p) {
    const n = text.length;
    const q = text[i];

    if (p.triple && (q === '"' || q === "'") && startsWith(text, i, q + q + q)) {
      const close = text.indexOf(q + q + q, i + 3);
      return close < 0 ? n : close + 3;
    }

    i++;
    while (i < n) {
      const c = text[i];
      if (p.escape && c === '\\' && q !== '`') { i += 2; continue; }
      if (c === q) {
        if (p.doubled && text[i + 1] === q) { i += 2; continue; }
        return i + 1;
      }
      // An unterminated string should not swallow the rest of the document.
      if (c === '\n' && !p.triple && q !== '`') return i;
      i++;
    }
    return n;
  }

  /** Skip whatever comment starts at `i`, or return -1 if none does. */
  function skipComment(text, i, p) {
    const n = text.length;
    if (p.block) {
      for (let k = 0; k < p.block.length; k++) {
        const open = p.block[k][0];
        const close = p.block[k][1];
        if (startsWith(text, i, open)) {
          const at = text.indexOf(close, i + open.length);
          return at < 0 ? n : at + close.length;
        }
      }
    }
    if (p.line) {
      for (let k = 0; k < p.line.length; k++) {
        const open = p.line[k];
        if (!startsWith(text, i, open)) continue;
        // url(http://…) is not a comment.
        if (p.urlGuard && open === '//' && text[i - 1] === ':') continue;
        const at = text.indexOf('\n', i);
        return at < 0 ? n : at;
      }
    }
    return -1;
  }

  /**
   * Find every balanced bracket pair in `text`.
   *
   * A closing bracket that does not match the innermost open one is left
   * unpaired rather than force-popping the stack, so one stray brace degrades
   * to "that bracket is not clickable" instead of scrambling everything after
   * it. Unclosed opens are likewise just dropped.
   */
  function matchBrackets(text, p) {
    const n = text.length;
    const set = p.brackets;
    const pairs = [];
    const stack = [];
    let i = 0;

    while (i < n) {
      const c = text[i];

      const past = skipComment(text, i, p);
      if (past >= 0) { i = past; continue; }

      if (p.quotes && p.quotes.indexOf(c) >= 0) { i = skipString(text, i, p); continue; }

      if (set.indexOf(c) >= 0) {
        if (OPPOSITE[c]) {
          stack.push({ ch: c, at: i });
        } else {
          const top = stack[stack.length - 1];
          if (top && OPPOSITE[top.ch] === c) {
            stack.pop();
            pairs.push({
              sel: [top.at, i + 1],
              inner: [top.at + 1, i],
              marks: [[top.at, top.at + 1], [i, i + 1]],
              kind: top.ch
            });
          }
        }
      }
      i++;
    }
    return pairs;
  }

  /* ------------------------------------------------------------------
     Markup: match tags, not angle brackets
     ------------------------------------------------------------------ */

  const VOID_TAGS = ('area base br col embed hr img input link meta param source track wbr'
    + ' command keygen basefont bgsound frame isindex').split(' ');
  const RAW_TAGS = ['script', 'style'];

  const isNameChar = (c) => !!c && /[A-Za-z0-9_:.\-]/.test(c);

  function readName(text, i) {
    let name = '';
    while (i < text.length && isNameChar(text[i])) name += text[i++];
    return name;
  }

  /** The index of the `>` that ends the tag opened at `i`, skipping quoted attributes. */
  function tagEnd(text, i) {
    const n = text.length;
    let k = i;
    while (k < n) {
      const c = text[k];
      if (c === '"' || c === "'") {
        const close = text.indexOf(c, k + 1);
        if (close < 0) return -1;
        k = close + 1;
        continue;
      }
      if (c === '>') return k;
      k++;
    }
    return -1;
  }

  function matchTags(text) {
    const n = text.length;
    const pairs = [];
    const stack = [];
    let i = 0;

    while (i < n) {
      if (text[i] !== '<') { i++; continue; }

      if (startsWith(text, i, '<!--')) {
        const at = text.indexOf('-->', i + 4);
        i = at < 0 ? n : at + 3;
        continue;
      }
      if (startsWith(text, i, '<![CDATA[')) {
        const at = text.indexOf(']]>', i + 9);
        i = at < 0 ? n : at + 3;
        continue;
      }
      if (startsWith(text, i, '<?')) {
        const at = text.indexOf('?>', i + 2);
        i = at < 0 ? n : at + 2;
        continue;
      }
      if (startsWith(text, i, '<!')) {
        const at = tagEnd(text, i + 2);
        i = at < 0 ? n : at + 1;
        continue;
      }

      // Closing tag: unwind to the nearest open tag of the same name. Anything
      // skipped on the way was never closed (legal in HTML) and is discarded.
      if (text[i + 1] === '/') {
        const name = readName(text, i + 2);
        const gt = tagEnd(text, i + 2);
        if (gt < 0) { i = n; continue; }
        const lower = name.toLowerCase();
        let found = -1;
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s].lower === lower) { found = s; break; }
        }
        if (found >= 0) {
          const open = stack[found];
          stack.length = found;
          pairs.push({
            sel: [open.start, gt + 1],
            inner: [open.gt + 1, i],
            marks: [[open.start, open.nameEnd], [i, i + 2 + name.length]],
            kind: 'tag'
          });
        }
        i = gt + 1;
        continue;
      }

      const name = readName(text, i + 1);
      if (!name) { i++; continue; }
      const gt = tagEnd(text, i + 1);
      if (gt < 0) { i = n; continue; }

      const lower = name.toLowerCase();
      const selfClosing = text[gt - 1] === '/' || VOID_TAGS.indexOf(lower) >= 0;

      if (selfClosing) { i = gt + 1; continue; }

      const entry = { lower: lower, start: i, nameEnd: i + 1 + name.length, gt: gt };

      // <script>/<style> hold raw text, where a stray '<' is not a tag.
      if (RAW_TAGS.indexOf(lower) >= 0) {
        const closeAt = text.toLowerCase().indexOf('</' + lower, gt + 1);
        if (closeAt >= 0) {
          const closeGt = tagEnd(text, closeAt + 2);
          if (closeGt >= 0) {
            pairs.push({
              sel: [entry.start, closeGt + 1],
              inner: [gt + 1, closeAt],
              marks: [[entry.start, entry.nameEnd], [closeAt, closeAt + 2 + lower.length]],
              kind: 'tag'
            });
            i = closeGt + 1;
            continue;
          }
        }
        i = gt + 1;
        continue;
      }

      stack.push(entry);
      i = gt + 1;
    }
    return pairs;
  }

  /**
   * The pair table for `text` under `profile`, innermost-last.
   * @returns {Array<{sel: number[], inner: number[], marks: number[][], kind: string}>}
   */
  B.analyse = function (text, profile) {
    if (!profile) return [];
    const pairs = profile.markup ? matchTags(text) : matchBrackets(text, profile);
    return pairs.length > MAX_PAIRS ? [] : pairs;
  };

  /* ------------------------------------------------------------------
     Painting: wrap the clickable characters
     ------------------------------------------------------------------ */

  /**
   * Wrap each range in `marks` in its own span, splitting text nodes as
   * needed. `marks` must be sorted by start and must not overlap.
   */
  function wrapRanges(codeEl, marks) {
    if (!marks.length) return;
    const walker = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let nd = walker.nextNode(); nd; nd = walker.nextNode()) nodes.push(nd);

    let mi = 0;
    let offset = 0;

    for (let ni = 0; ni < nodes.length; ni++) {
      const node = nodes[ni];
      const s = node.nodeValue;
      const base = offset;
      const stop = base + s.length;
      offset = stop;
      if (!s.length) continue;

      while (mi < marks.length && marks[mi].end <= base) mi++;
      if (mi >= marks.length || marks[mi].start >= stop) continue;

      const frag = document.createDocumentFragment();
      let cursor = base;
      let k = mi;

      while (k < marks.length && marks[k].start < stop) {
        const m = marks[k];
        const a = Math.max(m.start, base);
        const b = Math.min(m.end, stop);
        if (a > cursor) frag.appendChild(document.createTextNode(s.slice(cursor - base, a - base)));
        const span = document.createElement('span');
        span.className = 'bk';
        span.dataset.bk = String(m.pair);
        span.textContent = s.slice(a - base, b - base);
        frag.appendChild(span);
        cursor = b;
        // A mark that runs past this node continues in the next one.
        if (m.end > stop) break;
        k++;
      }
      if (cursor < stop) frag.appendChild(document.createTextNode(s.slice(cursor - base)));

      node.parentNode.replaceChild(frag, node);
      mi = k;
    }
  }

  /* ------------------------------------------------------------------
     Live state for the pane
     ------------------------------------------------------------------ */

  let live = null;   // { code, gutter, text, pairs, lineStarts }
  let hot = null;    // pair id currently under the pointer
  let held = null;   // pair id currently selected

  function lineStartsOf(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    return starts;
  }

  /** 1-based line number containing `offset`. */
  function lineAt(starts, offset) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  }

  /**
   * Match the brackets in the freshly highlighted pane and make them
   * clickable. Safe to call for any language; a no-op where there is nothing
   * to match.
   *
   * @returns {{pairs: number}} how many pairs are armed
   */
  B.paint = function (codeEl, text, langId, gutterEl) {
    B.clear();
    const profile = B.profileFor(langId);
    if (!profile || !text) return { pairs: 0 };

    const pairs = B.analyse(text, profile);
    if (!pairs.length) return { pairs: 0 };

    const marks = [];
    pairs.forEach((pair, id) => {
      pair.marks.forEach((m) => marks.push({ start: m[0], end: m[1], pair: id }));
    });
    marks.sort((a, b) => a.start - b.start);

    wrapRanges(codeEl, marks);

    live = {
      code: codeEl,
      gutter: gutterEl || null,
      text: text,
      pairs: pairs,
      lineStarts: lineStartsOf(text)
    };
    return { pairs: pairs.length };
  };

  B.clear = function () {
    live = null;
    hot = null;
    held = null;
  };

  /* ------------------------------------------------------------------
     Interaction
     ------------------------------------------------------------------ */

  function spansFor(id) {
    if (!live) return [];
    return live.code.querySelectorAll('.bk[data-bk="' + id + '"]');
  }

  function setFlag(id, cls, on) {
    spansFor(id).forEach((el) => el.classList.toggle(cls, on));
  }

  function markGutter(from, to) {
    if (!live || !live.gutter) return;
    const rows = live.gutter.children;
    for (let i = 0; i < rows.length; i++) {
      const line = i + 1;
      rows[i].classList.toggle('in-block', from > 0 && line >= from && line <= to);
    }
  }

  /** Put the browser's own selection over [start, end) of the pane text. */
  function selectRange(codeEl, start, end) {
    const a = locate(codeEl, start, false);
    const b = locate(codeEl, end, true);
    if (!a || !b) return false;
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    const sel = global.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  /** Map a character offset in the pane text back to a DOM position. */
  function locate(codeEl, offset, atEnd) {
    const walker = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
    let acc = 0;
    let last = null;
    for (let nd = walker.nextNode(); nd; nd = walker.nextNode()) {
      const len = nd.nodeValue.length;
      if (atEnd ? offset <= acc + len : offset < acc + len) {
        return { node: nd, offset: offset - acc };
      }
      acc += len;
      last = nd;
    }
    return last ? { node: last, offset: last.nodeValue.length } : null;
  }

  /**
   * Select the block belonging to `id`. `innerOnly` trims to the contents,
   * without the brackets or tags themselves.
   */
  B.select = function (id, innerOnly) {
    if (!live) return null;
    const pair = live.pairs[id];
    if (!pair) return null;

    let from = pair.sel[0];
    let to = pair.sel[1];
    if (innerOnly) {
      from = pair.inner[0];
      to = pair.inner[1];
      // Trim the blank line the formatter leaves after an opening bracket.
      while (from < to && /\s/.test(live.text[from])) from++;
      while (to > from && /\s/.test(live.text[to - 1])) to--;
    }
    if (to <= from) return null;
    if (!selectRange(live.code, from, to)) return null;

    if (held !== null) setFlag(held, 'bk-on', false);
    held = id;
    setFlag(id, 'bk-on', true);

    const first = lineAt(live.lineStarts, pair.sel[0]);
    const last = lineAt(live.lineStarts, pair.sel[1] - 1);
    markGutter(first, last);

    return {
      lines: last - first + 1,
      chars: to - from,
      kind: pair.kind,
      from: first,
      to: last
    };
  };

  B.release = function () {
    if (!live) return;
    if (held !== null) setFlag(held, 'bk-on', false);
    held = null;
    markGutter(0, 0);
  };

  /**
   * Wire the pane once. `onSelect` is handed the result of a successful
   * click-select, or null when a click clears one.
   */
  B.install = function (opts) {
    const code = opts.code;
    let downX = 0;
    let downY = 0;

    code.addEventListener('mousedown', (e) => { downX = e.clientX; downY = e.clientY; });

    code.addEventListener('mouseover', (e) => {
      const span = e.target.closest && e.target.closest('.bk');
      const id = span ? span.dataset.bk : null;
      if (id === hot) return;
      if (hot !== null) setFlag(hot, 'bk-hot', false);
      hot = id;
      if (id !== null) {
        setFlag(id, 'bk-hot', true);
        if (!span.title) {
          span.title = 'Click to select this block · Alt-click for the contents only';
        }
      }
    });

    code.addEventListener('mouseleave', () => {
      if (hot !== null) setFlag(hot, 'bk-hot', false);
      hot = null;
    });

    code.addEventListener('click', (e) => {
      if (!live) return;
      // A drag is the user selecting text by hand; leave it alone.
      if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) return;
      if (e.shiftKey || e.metaKey || e.ctrlKey) return;

      const span = e.target.closest && e.target.closest('.bk');
      if (!span) {
        B.release();
        if (opts.onSelect) opts.onSelect(null);
        return;
      }
      e.preventDefault();
      const result = B.select(Number(span.dataset.bk), e.altKey);
      if (opts.onSelect) opts.onSelect(result);
    });
  };

  B.MAX_PAIRS = MAX_PAIRS;
  global.Brackets = B;
})(window);
