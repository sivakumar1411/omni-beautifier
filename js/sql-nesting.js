/**
 * Sub-query depth colouring for SQL.
 *
 * highlight.js is a flat tokeniser: every keyword in a statement gets the same
 * colour whether it belongs to the outer statement or to a sub-query five
 * levels down. On a nested UPDATE ... (SELECT ...) that is exactly the
 * information you need and exactly the information you cannot see.
 *
 * This module adds it back. It scans the formatted SQL once, works out a
 * *query* depth for every character, then re-labels the highlighted DOM so
 * each depth carries its own colour.
 *
 * The important distinction: only a parenthesis that actually opens a query
 * counts towards depth. `WHERE ((a = 1) AND (b = 2))` is one query, not three,
 * so its keywords stay in the outer colour; those grouping parens instead get
 * matched rainbow colours of their own so you can still pair them up.
 */
(function (global) {
  const N = {};

  /** How many distinct colours the palettes define before cycling. */
  const CYCLE = 5;
  const ring = (d) => ((d - 1) % CYCLE) + 1;

  const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  const isWordChar = (c) => /[A-Za-z_]/.test(c);

  /** Skip whitespace and comments starting at `i`; returns the next real index. */
  function skipFluff(text, i) {
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (isSpace(c)) { i++; continue; }
      if (c === '-' && text[i + 1] === '-') {
        while (i < n && text[i] !== '\n') i++;
        continue;
      }
      if (c === '#') {
        while (i < n && text[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && text[i + 1] === '*') {
        i += 2;
        while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      break;
    }
    return i;
  }

  /** Words that, right after `(`, mean "a query starts here". */
  const QUERY_STARTERS = /^(SELECT|WITH)$/i;

  /** Does the parenthesis at `open` introduce a sub-query? */
  function opensQuery(text, open) {
    let i = skipFluff(text, open + 1);
    let word = '';
    while (i < text.length && isWordChar(text[i])) word += text[i++];
    return QUERY_STARTERS.test(word);
  }

  /**
   * Walk the text once and record, per character:
   *   depth      — how many sub-queries deep this character sits (0 = outer)
   *   paren      — the literal nesting level of a `(` / `)` character
   *   queryParen — set on the `(` and `)` that bracket a sub-query
   *
   * Strings and comments are skipped over so a `(` inside 'text (here)' or a
   * `--` comment cannot throw the depth off.
   */
  N.analyse = function (text) {
    const n = text.length;
    const depth = new Int16Array(n);
    const paren = new Int16Array(n);
    const queryParen = new Uint8Array(n);

    const stack = [];
    let q = 0;
    let p = 0;
    let maxDepth = 0;
    let subqueries = 0;
    let i = 0;

    // Everything skipped wholesale still belongs to the depth it sits in.
    const claim = (from, to) => { for (let k = from; k < to && k < n; k++) depth[k] = q; };

    while (i < n) {
      const c = text[i];

      if (c === '-' && text[i + 1] === '-') {
        const start = i;
        while (i < n && text[i] !== '\n') i++;
        claim(start, i);
        continue;
      }
      if (c === '#') {
        const start = i;
        while (i < n && text[i] !== '\n') i++;
        claim(start, i);
        continue;
      }
      if (c === '/' && text[i + 1] === '*') {
        const start = i;
        i += 2;
        while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i = Math.min(n, i + 2);
        claim(start, i);
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        const start = i;
        i++;
        while (i < n) {
          if (text[i] === '\\' && c !== '`') { i += 2; continue; }
          if (text[i] === c) {
            // A doubled quote is an escaped quote, not the end of the literal.
            if (text[i + 1] === c) { i += 2; continue; }
            i++;
            break;
          }
          i++;
        }
        claim(start, i);
        continue;
      }

      if (c === '(') {
        const isQuery = opensQuery(text, i);
        p++;
        if (isQuery) {
          q++;
          subqueries++;
          if (q > maxDepth) maxDepth = q;
        }
        stack.push({ isQuery: isQuery, q: q, p: p });
        depth[i] = q;
        paren[i] = p;
        if (isQuery) queryParen[i] = 1;
        i++;
        continue;
      }

      if (c === ')') {
        const top = stack.pop();
        if (top) {
          depth[i] = top.q;
          paren[i] = top.p;
          if (top.isQuery) { queryParen[i] = 1; q--; }
          p--;
        } else {
          depth[i] = q;
          paren[i] = 0;
        }
        i++;
        continue;
      }

      depth[i] = q;
      i++;
    }

    return { depth: depth, paren: paren, queryParen: queryParen, maxDepth: maxDepth, subqueries: subqueries };
  };

  /** The class a single character should carry, or null for "leave it alone". */
  function classFor(info, idx, ch) {
    if (ch === '(' || ch === ')') {
      if (info.queryParen[idx]) return 'sqlq-' + ring(info.depth[idx]) + ' sql-qparen';
      const p = info.paren[idx];
      return p > 0 ? 'sqlp-' + ring(p) : null;
    }
    const d = info.depth[idx];
    return d > 0 ? 'sqlq-' + ring(d) : null;
  }

  /**
   * Re-label an already-highlighted <code> element by sub-query depth.
   *
   * `codeEl.textContent` must still equal `text` — highlight.js only wraps
   * text, never rewrites it, so walking the text nodes in order gives us the
   * original character offsets back.
   *
   * @returns {{maxDepth: number, subqueries: number}} what the scan found
   */
  N.paint = function (codeEl, text) {
    const info = N.analyse(text);
    if (!info.maxDepth) return { maxDepth: 0, subqueries: 0 };

    const walker = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) textNodes.push(node);

    let offset = 0;
    textNodes.forEach((node) => {
      const s = node.nodeValue;
      const base = offset;
      offset += s.length;
      if (!s.length) return;

      const frag = document.createDocumentFragment();
      let runStart = 0;
      let runClass = classFor(info, base, s[0]);

      const flush = (end) => {
        const piece = s.slice(runStart, end);
        if (!piece) return;
        if (runClass === null) {
          frag.appendChild(document.createTextNode(piece));
        } else {
          const span = document.createElement('span');
          span.className = runClass;
          span.textContent = piece;
          frag.appendChild(span);
        }
      };

      for (let k = 1; k < s.length; k++) {
        const cls = classFor(info, base + k, s[k]);
        if (cls !== runClass) {
          flush(k);
          runStart = k;
          runClass = cls;
        }
      }
      flush(s.length);

      node.parentNode.replaceChild(frag, node);
    });

    return { maxDepth: info.maxDepth, subqueries: info.subqueries };
  };

  N.CYCLE = CYCLE;
  global.SqlNesting = N;
})(window);
