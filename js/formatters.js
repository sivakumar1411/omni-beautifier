/**
 * Formatting engines.
 *
 * Every formatter returns { text, error } — never throws — so the UI can show a
 * useful message and an error location instead of a blank pane.
 */
(function (global) {
  const F = {};

  const indentUnit = (opts) => (opts.useTabs ? '\t' : ' '.repeat(opts.indent || 2));

  /* ------------------------------------------------------------------
     JSON
     ------------------------------------------------------------------ */

  function offsetToLineColumn(text, pos) {
    const at = Math.max(0, Math.min(pos, text.length));
    const before = text.slice(0, at);
    return { line: before.split('\n').length, column: at - before.lastIndexOf('\n') };
  }

  /**
   * Find where JSON first stops being valid.
   *
   * V8 used to put "at position N" in its error message but no longer does
   * reliably, so rather than parse the message we re-scan the text ourselves.
   * A minimal recursive-descent walk is enough to point at the offending
   * character, which is the part that actually helps when fixing a payload.
   */
  function findJsonErrorIndex(text) {
    let i = 0;
    const n = text.length;
    const ws = () => { while (i < n && ' \t\r\n'.indexOf(text[i]) !== -1) i++; };
    const fail = () => { throw i; };

    function value() {
      ws();
      if (i >= n) fail();
      const c = text[i];
      if (c === '{') return object();
      if (c === '[') return array();
      if (c === '"') return string();
      if (c === '-' || (c >= '0' && c <= '9')) return number();
      if (text.startsWith('true', i)) { i += 4; return; }
      if (text.startsWith('false', i)) { i += 5; return; }
      if (text.startsWith('null', i)) { i += 4; return; }
      fail();
    }
    function object() {
      i++; ws();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        string(); ws();
        if (text[i] !== ':') fail();
        i++; value(); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return; }
        fail();
      }
    }
    function array() {
      i++; ws();
      if (text[i] === ']') { i++; return; }
      for (;;) {
        value(); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return; }
        fail();
      }
    }
    function string() {
      i++;
      while (i < n) {
        const c = text[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '"') { i++; return; }
        if (c === '\n') fail();
        i++;
      }
      fail();
    }
    function number() {
      const start = i;
      if (text[i] === '-') i++;
      while (i < n && text[i] >= '0' && text[i] <= '9') i++;
      if (text[i] === '.') { i++; while (i < n && text[i] >= '0' && text[i] <= '9') i++; }
      if (text[i] === 'e' || text[i] === 'E') {
        i++;
        if (text[i] === '+' || text[i] === '-') i++;
        while (i < n && text[i] >= '0' && text[i] <= '9') i++;
      }
      if (i === start) fail();
    }

    try {
      value();
      ws();
      if (i < n) return i;   // trailing junk after the root value
      return null;
    } catch (at) {
      return typeof at === 'number' ? at : null;
    }
  }

  /** Best-effort line/column for a JSON.parse failure. */
  function jsonErrorLocation(text, err) {
    const m = /position\s+(\d+)/i.exec((err && err.message) || '');
    if (m) return offsetToLineColumn(text, +m[1]);
    const idx = findJsonErrorIndex(text);
    return idx === null ? null : offsetToLineColumn(text, idx);
  }

  /** Strip comments and trailing commas so JSONC/JSON5-ish input still works. */
  function tolerantJson(text) {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:"'])\/\/[^\n]*/g, '$1')
      .replace(/,(\s*[}\]])/g, '$1');
  }

  F.json = function (text, opts) {
    const raw = text.trim();
    if (!raw) return { text: '', error: null };

    let parsed;
    let relaxed = false;
    try {
      parsed = JSON.parse(raw);
    } catch (strictErr) {
      try {
        parsed = JSON.parse(tolerantJson(raw));
        relaxed = true;
      } catch (_) {
        return {
          text: '',
          error: {
            message: strictErr.message,
            location: jsonErrorLocation(raw, strictErr)
          }
        };
      }
    }
    return {
      text: JSON.stringify(parsed, null, opts.useTabs ? '\t' : (opts.indent || 2)),
      note: relaxed ? 'Comments and trailing commas were removed to parse this.' : null,
      error: null
    };
  };

  F.jsonMinify = function (text) {
    try {
      return { text: JSON.stringify(JSON.parse(tolerantJson(text))), error: null };
    } catch (err) {
      return { text: '', error: { message: err.message, location: jsonErrorLocation(text, err) } };
    }
  };

  /* ------------------------------------------------------------------
     SQL
     ------------------------------------------------------------------ */

  /** Major clauses that start a new line at their current nesting depth. */
  const SQL_BREAK_BEFORE = [
    'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
    'UNION ALL', 'UNION', 'INSERT INTO', 'INSERT', 'UPDATE', 'DELETE FROM', 'DELETE',
    'VALUES', 'SET', 'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN',
    'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'CROSS JOIN', 'JOIN', 'ON', 'AND', 'OR'
  ];

  /** Words that read as calls, so `SUM(` rather than `SUM (`. */
  const SQL_FUNCTIONS = ('COUNT SUM AVG MIN MAX COALESCE CAST IFNULL NULLIF CONCAT SUBSTRING ' +
    'LENGTH ROUND FLOOR CEIL ABS NOW DATE_FORMAT GROUP_CONCAT IF CONVERT TRIM UPPER LOWER').split(' ');

  const SQL_KEYWORDS = ('SELECT FROM WHERE GROUP BY ORDER HAVING LIMIT OFFSET UNION ALL DISTINCT ' +
    'INSERT INTO UPDATE DELETE VALUES SET AS ON AND OR NOT IN IS NULL LIKE BETWEEN EXISTS ' +
    'JOIN LEFT RIGHT INNER OUTER FULL CROSS CASE WHEN THEN ELSE END ASC DESC WITH ' +
    'COUNT SUM AVG MIN MAX COALESCE CAST').split(' ');

  /**
   * Split SQL into tokens without ever failing, keeping strings, quoted
   * identifiers and comments intact as single tokens.
   */
  function tokenizeSql(sql) {
    const tokens = [];
    let i = 0;
    while (i < sql.length) {
      const c = sql[i];

      if (/\s/.test(c)) { i++; continue; }

      if (c === '-' && sql[i + 1] === '-') {
        const end = sql.indexOf('\n', i);
        tokens.push({ t: 'comment', v: sql.slice(i, end === -1 ? sql.length : end) });
        i = end === -1 ? sql.length : end;
        continue;
      }
      if (c === '/' && sql[i + 1] === '*') {
        const end = sql.indexOf('*/', i + 2);
        tokens.push({ t: 'comment', v: sql.slice(i, end === -1 ? sql.length : end + 2) });
        i = end === -1 ? sql.length : end + 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        let j = i + 1;
        while (j < sql.length) {
          if (sql[j] === '\\') { j += 2; continue; }
          if (sql[j] === c) { j++; break; }
          j++;
        }
        tokens.push({ t: 'string', v: sql.slice(i, j) });
        i = j;
        continue;
      }
      if (c === '(' || c === ')' || c === ',' || c === ';') {
        tokens.push({ t: c, v: c });
        i++;
        continue;
      }
      // Identifiers may carry $ and . (CrmIamUser$ZCRM1.USER_ID).
      const word = /^[A-Za-z_][A-Za-z0-9_$.]*/.exec(sql.slice(i));
      if (word) {
        tokens.push({ t: 'word', v: word[0] });
        i += word[0].length;
        continue;
      }
      const op = /^(<=|>=|<>|!=|\|\||=|<|>|\+|-|\*|\/|%|\|)/.exec(sql.slice(i));
      if (op) { tokens.push({ t: 'op', v: op[0] }); i += op[0].length; continue; }

      tokens.push({ t: 'other', v: c });
      i++;
    }
    return tokens;
  }

  /**
   * A SQL layout engine that never throws.
   *
   * sql-formatter parses against a real grammar, which is the right default,
   * but it rejects anything malformed — and query logs, with their values
   * stripped out, are malformed constantly. This walks tokens instead: it
   * indents by parenthesis depth and breaks before major clauses, so even
   * unparseable SQL becomes readable.
   */
  F.sqlLenient = function (text, opts) {
    const unit = indentUnit(opts || {});
    const keywordCase = (opts && opts.keywordCase) || 'upper';
    const tokens = tokenizeSql(text);

    const lines = [];
    let current = '';
    let depth = 0;
    // One entry per open paren: true when it belongs to a function call, so a
    // comma inside COALESCE(a, b) stays inline while a real list still breaks.
    const parenIsCall = [];
    // Indent by the nesting depth the line *started* at. Using the depth at
    // flush time instead makes nesting jump around, because a line often opens
    // or closes parens before it ends.
    let lineDepth = 0;

    const flush = () => {
      if (current.trim()) lines.push(unit.repeat(Math.max(0, lineDepth)) + current.trim());
      current = '';
    };
    const beginLine = () => { if (!current) lineDepth = depth; };
    const add = (v) => {
      beginLine();
      if (current && !/[\s(]$/.test(current)) current += ' ';
      current += v;
    };

    const isKeyword = (word) => SQL_KEYWORDS.indexOf(word.toUpperCase()) !== -1;
    const applyCase = (word) => {
      if (keywordCase === 'preserve' || !isKeyword(word)) return word;
      return keywordCase === 'lower' ? word.toLowerCase() : word.toUpperCase();
    };

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];

      if (tok.t === '(') {
        // A call closes up on its name; a clause keyword keeps its space.
        const prev = tokens[i - 1];
        const attach = prev && prev.t === 'word' &&
          (SQL_FUNCTIONS.indexOf(prev.v.toUpperCase()) !== -1 ||
           SQL_KEYWORDS.indexOf(prev.v.toUpperCase()) === -1);
        beginLine();
        if (current && !attach && !/[\s(]$/.test(current)) current += ' ';
        current += '(';
        parenIsCall.push(!!attach);
        depth++;
        continue;
      }
      if (tok.t === ')') {
        parenIsCall.pop();
        depth = Math.max(0, depth - 1);
        beginLine();
        if (!current) lineDepth = depth;
        current += ')';
        continue;
      }
      if (tok.t === ',') {
        beginLine();
        current += ',';
        // Inside a call the arguments belong together on one line.
        if (!parenIsCall[parenIsCall.length - 1]) flush();
        continue;
      }
      if (tok.t === ';') { beginLine(); current += ';'; flush(); continue; }
      if (tok.t === 'comment' || tok.t === 'string' || tok.t === 'op' || tok.t === 'other') {
        add(tok.v);
        continue;
      }

      // A word: does it open a clause? Two-word clauses are checked first.
      const upper = tok.v.toUpperCase();
      const next = tokens[i + 1];
      const pair = next && next.t === 'word' ? upper + ' ' + next.v.toUpperCase() : null;
      const clause = (pair && SQL_BREAK_BEFORE.indexOf(pair) !== -1) ? pair
        : (SQL_BREAK_BEFORE.indexOf(upper) !== -1 ? upper : null);

      if (clause) {
        flush();
        lineDepth = depth;
        if (clause.indexOf(' ') !== -1) i++;
        current = keywordCase === 'preserve'
          ? (clause.indexOf(' ') !== -1 ? tok.v + ' ' + next.v : tok.v)
          : (keywordCase === 'lower' ? clause.toLowerCase() : clause);
        continue;
      }
      add(applyCase(tok.v));
    }
    flush();

    return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), error: null };
  };

  /**
   * Turn sql-formatter's parser error into something a human can act on.
   *
   * It reports failures by dumping its entire grammar expectation set — many
   * thousands of characters of `asteriskless_free_form_sql$subexpression$1`
   * noise. Only the first sentence carries information.
   */
  function cleanSqlError(err, text) {
    const raw = (err && err.message) || String(err);
    const head = raw.split(/\.\s*Instead, I was expecting/)[0];

    const loc = /at line (\d+) column (\d+)/i.exec(head);
    const tokenRaw = /"raw"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
    const kind = /Unexpected (\w+) token/i.exec(head);

    let message;
    if (loc) {
      const what = tokenRaw ? '"' + tokenRaw[1] + '"' : (kind ? kind[1].toLowerCase().replace(/_/g, ' ') : 'token');
      message = 'This is not valid SQL: unexpected ' + what + '.';
    } else {
      message = 'This could not be parsed as SQL: ' + head.slice(0, 200);
    }

    // Unbalanced parentheses are the usual cause and are worth naming outright,
    // since the parser only ever reports the first symptom.
    let depth = 0;
    let extraClose = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') { depth--; if (depth < 0) { extraClose++; depth = 0; } }
    }
    if (extraClose) message += ' There ' + (extraClose === 1 ? 'is 1 unmatched closing parenthesis' : 'are ' + extraClose + ' unmatched closing parentheses') + '.';
    else if (depth) message += ' There ' + (depth === 1 ? 'is 1 unclosed parenthesis' : 'are ' + depth + ' unclosed parentheses') + '.';

    return {
      message,
      location: loc ? { line: +loc[1], column: +loc[2] } : null
    };
  }

  F.sql = function (text, opts) {
    if (typeof global.sqlFormatter === 'undefined') {
      return { text: '', error: { message: 'The SQL formatter failed to load.' } };
    }
    try {
      return {
        text: global.sqlFormatter.format(text, {
          language: opts.sqlDialect || 'mysql',
          tabWidth: opts.indent || 2,
          useTabs: !!opts.useTabs,
          keywordCase: opts.keywordCase || 'upper',
          linesBetweenQueries: 2
        }),
        error: null
      };
    } catch (err) {
      // Strict parsing failed. Lay it out anyway and explain why it is degraded
      // — an unformattable query log is exactly when you most want to read it.
      const cleaned = cleanSqlError(err, text);
      const lenient = F.sqlLenient(text, opts);
      if (lenient.text) {
        return {
          text: lenient.text,
          error: null,
          warning: {
            message: cleaned.message + ' Laid out on a best-effort basis instead of fully formatted.',
            location: cleaned.location
          }
        };
      }
      return { text: '', error: cleaned };
    }
  };

  F.sqlMinify = function (text) {
    // Collapse whitespace, but never inside quoted strings or identifiers.
    let out = '';
    let quote = null;
    let pendingSpace = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        out += c;
        if (c === quote && text[i - 1] !== '\\') quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        if (pendingSpace) { out += ' '; pendingSpace = false; }
        quote = c;
        out += c;
        continue;
      }
      if (/\s/.test(c)) { if (out) pendingSpace = true; continue; }
      if (pendingSpace) { out += ' '; pendingSpace = false; }
      out += c;
    }
    return { text: out.trim(), error: null };
  };

  /* ------------------------------------------------------------------
     SOQL / SOSL

     sql-formatter has no SOQL dialect and its SQL grammar rejects three things
     that are ordinary SOQL: bind variables (`:accountId`), parameterised date
     literals (`LAST_N_DAYS:30`) and the SOSL search term (`FIND {Acme}`). Its
     `paramTypes` option accepts the binds but then reformats
     `LAST_N_DAYS:30` into `LAST_N_DAYS :30`, which silently changes what the
     query means — worse than failing.

     So the SOQL-only constructs are swapped for opaque identifiers, the query
     is formatted as plain SQL, and the originals are put back verbatim. The
     formatter never sees anything it can misread, and nothing it emits can
     alter a protected token.
     ------------------------------------------------------------------ */

  /** Salesforce syntax that sql-formatter cannot parse, hidden behind tokens. */
  function protectSoql(text) {
    // Derive the token from the input so it cannot collide with real content.
    let tag = 'zsf';
    while (text.indexOf(tag) !== -1) tag += 'z';
    const store = [];
    const stash = (match) => { store.push(match); return tag + (store.length - 1) + tag; };

    let out = text;
    out = out.replace(/\{[^{}]*\}/g, stash);                                 // FIND {Acme*}
    out = out.replace(/\b[A-Za-z_][A-Za-z0-9_]*:-?\d+\b/g, stash);            // LAST_N_DAYS:30
    out = out.replace(/:[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g, stash); // :bindVar
    // SOQL has no CASE expression, so every `Case` is the standard object or
    // one of its fields — but sql-formatter reads it as the start of a CASE.
    out = out.replace(/\bCase\b/g, stash);
    return { text: out, store: store, tag: tag };
  }

  function restoreSoql(text, guard) {
    return text.replace(new RegExp(guard.tag + '(\\d+)' + guard.tag, 'g'),
      (_, i) => guard.store[Number(i)]);
  }

  F.soql = function (text, opts) {
    if (typeof global.sqlFormatter === 'undefined') {
      return { text: '', error: { message: 'The SQL formatter failed to load.' } };
    }
    const guard = protectSoql(text);
    try {
      const formatted = global.sqlFormatter.format(guard.text, {
        // Always standard SQL: the MySQL/T-SQL dialects add grammar SOQL
        // does not have, and SOQL has no dialects of its own.
        language: 'sql',
        tabWidth: opts.indent || 2,
        useTabs: !!opts.useTabs,
        keywordCase: opts.keywordCase || 'upper',
        linesBetweenQueries: 2
      });
      return { text: restoreSoql(formatted, guard), error: null };
    } catch (err) {
      const cleaned = cleanSqlError(err, text);
      const lenient = F.sqlLenient(text, opts);
      if (lenient.text) {
        return {
          text: lenient.text,
          error: null,
          warning: {
            message: cleaned.message.replace('not valid SQL', 'not valid SOQL')
              + ' Laid out on a best-effort basis instead of fully formatted.',
            location: cleaned.location
          }
        };
      }
      return { text: '', error: cleaned };
    }
  };

  /* ------------------------------------------------------------------
     XML
     ------------------------------------------------------------------ */

  /** Validate with DOMParser purely to get a real error message. */
  function xmlError(text) {
    try {
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      const err = doc.getElementsByTagName('parsererror')[0];
      if (!err) return null;
      const msg = err.textContent.replace(/\s+/g, ' ').trim();
      const loc = /line\s+(\d+)[^\d]+column\s+(\d+)/i.exec(msg);
      return {
        message: msg.slice(0, 300),
        location: loc ? { line: +loc[1], column: +loc[2] } : null
      };
    } catch (_) {
      return null;
    }
  }

  /**
   * Tokenise into tags and text, then re-emit with indentation. Tolerant on
   * purpose: malformed markup still gets laid out, with the parser's complaint
   * reported alongside.
   */
  F.xml = function (text, opts, lang) {
    const unit = indentUnit(opts);
    const src = text.trim();
    if (!src) return { text: '', error: null };

    const tokens = src.match(/<[^>]*>|[^<]+/g) || [];
    const rows = [];
    let depth = 0;

    tokens.forEach((tokenRaw) => {
      const token = tokenRaw.trim();
      if (!token) return;

      if (token.charAt(0) === '<') {
        const isClose = /^<\//.test(token);
        const isSelfClose = /\/>$/.test(token);
        const isDecl = /^<[?!]/.test(token);

        if (isClose) depth = Math.max(0, depth - 1);
        rows.push(unit.repeat(depth) + token);
        if (!isClose && !isSelfClose && !isDecl) depth++;
        return;
      }

      // Text node: keep it on one line, attached under its parent.
      const collapsed = token.replace(/\s+/g, ' ').trim();
      if (collapsed) rows.push(unit.repeat(depth) + collapsed);
    });

    // A text node between a tag pair reads better inline: <a>text</a>
    const lines = [];
    for (let i = 0; i < rows.length; i++) {
      const open = rows[i];
      const middle = rows[i + 1];
      const close = rows[i + 2];
      const isOpenTag = /^\s*<[^/!?][^>]*[^/]>$/.test(open);
      const isText = middle !== undefined && !/^\s*</.test(middle);
      const isCloseTag = close !== undefined && /^\s*<\//.test(close);
      if (isOpenTag && isText && isCloseTag) {
        lines.push(open + middle.trim() + close.trim());
        i += 2;
      } else {
        lines.push(open);
      }
    }

    // LWC templates and Visualforce are not well-formed XML by design —
    // `for:each={items}` is an unquoted attribute and `apex:`/`aura:` are
    // namespaces with no declaration. Both are correct, so reporting them
    // would be crying wolf on every paste.
    const warning = lang && lang.lenientMarkup ? null : xmlError(src);
    return { text: lines.join('\n'), error: null, warning: warning };
  };

  F.xmlMinify = function (text) {
    return { text: text.replace(/>\s+</g, '><').trim(), error: null };
  };

  /* ------------------------------------------------------------------
     Prettier
     ------------------------------------------------------------------ */

  F.prettier = function (text, opts, lang) {
    if (typeof global.prettier === 'undefined' || typeof global.prettierPlugins === 'undefined') {
      return Promise.resolve({ text: '', error: { message: 'Prettier failed to load.' } });
    }
    const plugins = (lang.plugins || []).map((p) => global.prettierPlugins[p]).filter(Boolean);
    return global.prettier
      .format(text, {
        parser: lang.parser,
        plugins,
        tabWidth: opts.indent || 2,
        useTabs: !!opts.useTabs,
        printWidth: opts.printWidth || 80
      })
      .then((formatted) => ({ text: formatted, error: null }))
      .catch((err) => ({
        text: '',
        error: {
          message: (err && err.message ? err.message : String(err)).split('\n').slice(0, 6).join('\n'),
          location: err && err.loc && err.loc.start
            ? { line: err.loc.start.line, column: err.loc.start.column }
            : null
        }
      }));
  };

  /* ------------------------------------------------------------------
     Generic brace re-indenter (Java, C-family, Go, PHP …)
     ------------------------------------------------------------------ */

  const OPEN_BLOCK = { block: 1 };
  const CLOSE_BLOCK = { block: -1 };

  /**
   * Walks the source character by character, tracking strings and comments so
   * it never reformats their contents, and breaks lines after `{`, `}` and
   * statement-level `;`. A second pass applies indentation by brace depth.
   *
   * Not language-aware: it will not rewrap long lines or reflow chained calls.
   */
  F.indent = function (text, opts) {
    const unit = indentUnit(opts);
    const src = String(text);

    const pieces = [];
    let line = '';
    let i = 0;
    let paren = 0; // inside (...) a ';' is a for-loop separator, not a statement end

    const pushLine = () => {
      const trimmed = line.trim();
      if (trimmed) pieces.push(trimmed);
      line = '';
    };
    /** Append, collapsing runs of whitespace. */
    const put = (s) => {
      if (/^\s$/.test(s) && /\s$/.test(line)) return;
      line += s;
    };

    while (i < src.length) {
      const c = src[i];
      const next = src[i + 1];

      // line comment
      if (c === '/' && next === '/') {
        const end = src.indexOf('\n', i);
        const stop = end === -1 ? src.length : end;
        line = line.trim() ? line.trim() + ' ' + src.slice(i, stop).trim() : src.slice(i, stop).trim();
        pushLine();
        i = stop + 1;
        continue;
      }
      // hash comment, when it starts the line (shell-ish, and PHP)
      if (c === '#' && line.trim() === '') {
        const end = src.indexOf('\n', i);
        const stop = end === -1 ? src.length : end;
        line = src.slice(i, stop).trim();
        pushLine();
        i = stop + 1;
        continue;
      }
      // block comment — preserved verbatim, on its own lines
      if (c === '/' && next === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end === -1 ? src.length : end + 2;
        pushLine();
        src.slice(i, stop).split('\n').forEach((l) => {
          if (l.trim()) pieces.push(l.trim());
        });
        i = stop;
        continue;
      }
      // string / char literal
      if (c === '"' || c === "'" || c === '`') {
        let j = i + 1;
        while (j < src.length) {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === c) { j++; break; }
          j++;
        }
        put(src.slice(i, j));
        i = j;
        continue;
      }

      if (c === '(') { paren++; put(c); i++; continue; }
      if (c === ')') { paren = Math.max(0, paren - 1); put(c); i++; continue; }

      if (c === '{') {
        // Only add the separating space if the line does not already end in
        // one. Source that is already laid out (`class A {`) would otherwise
        // come back with a double space before every brace.
        put(/\s$/.test(line) ? '{' : ' {');
        pushLine();
        pieces.push(OPEN_BLOCK);
        i++;
        continue;
      }
      if (c === '}') {
        pushLine();
        pieces.push(CLOSE_BLOCK);
        // Keep `} else {`, `} catch (…) {`, `};` and `},` attached.
        let j = i + 1;
        while (j < src.length && /\s/.test(src[j])) j++;
        const tail = src.slice(j);
        if (/^(else\b|catch\b|finally\b|while\b|elseif\b|elif\b)/.test(tail)) {
          line = '} ';
          i = j;
          continue;
        }
        if (src[j] === ';' || src[j] === ',' || src[j] === ')') {
          line = '}' + src[j];
          pushLine();
          i = j + 1;
          continue;
        }
        line = '}';
        pushLine();
        i++;
        continue;
      }
      if (c === ';' && paren === 0) {
        put(';');
        pushLine();
        i++;
        continue;
      }
      if (/\s/.test(c)) { put(' '); i++; continue; }

      put(c);
      i++;
    }
    pushLine();

    // Second pass: apply depth. Closing braces sit at the outer level.
    const out = [];
    let depth = 0;
    pieces.forEach((piece) => {
      if (piece === OPEN_BLOCK) { depth++; return; }
      if (piece === CLOSE_BLOCK) { depth = Math.max(0, depth - 1); return; }
      out.push(depth ? unit.repeat(depth) + piece : piece);
    });

    return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), error: null };
  };

  /* ------------------------------------------------------------------
     Tidy — whitespace-only clean-up
     ------------------------------------------------------------------ */

  /**
   * Mark lines that sit inside a triple-quoted string.
   *
   * Python's indentation is syntax, so re-indenting is off the table, but the
   * leading whitespace inside a docstring is *content* — rescaling it would
   * silently change the string. Those lines are left byte-for-byte alone.
   */
  function tripleQuotedLines(lines) {
    const inside = new Array(lines.length).fill(false);
    let delim = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (delim) {
        inside[i] = true;
        if (line.indexOf(delim) !== -1) delim = null;
        continue;
      }
      const open = /("""|''')/.exec(line);
      if (!open) continue;
      const rest = line.slice(open.index + 3);
      // Opens and closes on the same line: nothing spans.
      if (rest.indexOf(open[1]) !== -1) continue;
      delim = open[1];
    }
    return inside;
  }

  /** The indent step the file actually uses, so it can be rescaled faithfully. */
  function detectIndentUnit(lines, skip) {
    const widths = [];
    lines.forEach((line, i) => {
      if (skip[i] || !line.trim()) return;
      const lead = /^[ ]*/.exec(line)[0].length;
      if (lead > 0) widths.push(lead);
    });
    if (!widths.length) return null;
    // The smallest non-zero indent is almost always the unit.
    const smallest = Math.min.apply(null, widths);
    if (smallest < 1 || smallest > 8) return null;
    // Confirm every indent is a multiple of it, or rescaling would distort.
    return widths.every((w) => w % smallest === 0) ? smallest : null;
  }

  /**
   * Normalise whitespace without touching structure: tabs to spaces, a
   * consistent indent step, no trailing spaces, at most one blank line run.
   */
  F.tidy = function (text, opts) {
    const width = (opts && opts.indent) || 2;
    const useTabs = !!(opts && opts.useTabs);
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    const skip = tripleQuotedLines(lines);

    // Leading tabs first, so indent detection sees comparable widths.
    const expanded = lines.map((line, i) => {
      if (skip[i]) return line;
      const lead = /^[\t ]*/.exec(line)[0];
      const body = line.slice(lead.length);
      return lead.replace(/\t/g, '    ') + body;
    });

    const unit = detectIndentUnit(expanded, skip);
    const out = expanded.map((line, i) => {
      if (skip[i]) return line;
      if (!line.trim()) return '';
      const lead = /^[ ]*/.exec(line)[0].length;
      const body = line.slice(lead).replace(/\s+$/, '');
      if (!unit) return ' '.repeat(lead) + body;
      const depth = lead / unit;
      // A partial indent is not ours to reinterpret; leave it as-is.
      if (depth !== Math.floor(depth)) return ' '.repeat(lead) + body;
      return (useTabs ? '\t'.repeat(depth) : ' '.repeat(depth * width)) + body;
    });

    const collapsed = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
    return {
      text: collapsed,
      error: null,
      note: unit && unit !== width && !useTabs
        ? 'Indentation rescaled from ' + unit + ' to ' + width + ' spaces; nesting is unchanged.'
        : null
    };
  };

  /* ------------------------------------------------------------------
     INI / TOML
     ------------------------------------------------------------------ */

  /** Group into sections, align the separator within each, tidy the spacing. */
  F.ini = function (text, opts) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let block = { header: null, entries: [] };

    lines.forEach((raw) => {
      const line = raw.trim();
      if (!line) { block.entries.push({ kind: 'blank' }); return; }
      if (/^[#;]/.test(line)) { block.entries.push({ kind: 'comment', text: line }); return; }
      const section = /^\[(.*)\]$/.exec(line);
      if (section) {
        blocks.push(block);
        block = { header: '[' + section[1].trim() + ']', entries: [] };
        return;
      }
      const kv = /^([^=:]+)([=:])(.*)$/.exec(line);
      if (kv) {
        block.entries.push({ kind: 'kv', key: kv[1].trim(), sep: kv[2], value: kv[3].trim() });
        return;
      }
      block.entries.push({ kind: 'raw', text: line });
    });
    blocks.push(block);

    const out = [];
    blocks.forEach((b) => {
      const hasContent = b.header || b.entries.some((e) => e.kind !== 'blank');
      if (!hasContent) return;
      if (out.length) out.push('');
      if (b.header) out.push(b.header);

      const width = b.entries.reduce((m, e) => (e.kind === 'kv' ? Math.max(m, e.key.length) : m), 0);
      let lastBlank = true;
      b.entries.forEach((e) => {
        if (e.kind === 'blank') {
          if (!lastBlank && out.length) out.push('');
          lastBlank = true;
          return;
        }
        lastBlank = false;
        if (e.kind === 'kv') out.push(e.key.padEnd(width) + ' ' + e.sep + ' ' + e.value);
        else out.push(e.text);
      });
    });

    return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), error: null };
  };

  /* ------------------------------------------------------------------
     CSV / TSV
     ------------------------------------------------------------------ */

  /** RFC 4180 parse: quoted fields, embedded delimiters and newlines. */
  F.parseDelimited = function (text, delimiter) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else quoted = false;
        } else field += c;
        continue;
      }
      if (c === '"') { quoted = true; continue; }
      if (c === delimiter) { row.push(field); field = ''; continue; }
      if (c === '\r') continue;
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
      field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.length > 1 || (r[0] || '').trim() !== '');
  };

  F.detectDelimiter = function (text) {
    const head = text.split('\n')[0] || '';
    const counts = { ',': 0, '\t': 0, ';': 0, '|': 0 };
    let quoted = false;
    for (const c of head) {
      if (c === '"') { quoted = !quoted; continue; }
      if (!quoted && Object.prototype.hasOwnProperty.call(counts, c)) counts[c]++;
    }
    return Object.keys(counts).reduce((a, b) => (counts[b] > counts[a] ? b : a), ',');
  };

  /** Pad every column to a common width so the grid lines up when read. */
  F.csv = function (text, opts) {
    const delimiter = F.detectDelimiter(text);
    const rows = F.parseDelimited(text, delimiter);
    if (!rows.length) return { text: '', error: null };

    const columns = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const widths = new Array(columns).fill(0);
    rows.forEach((r) => {
      for (let c = 0; c < columns; c++) widths[c] = Math.max(widths[c], (r[c] || '').length);
    });

    const quote = (v) => (v.indexOf(delimiter) !== -1 || v.indexOf('"') !== -1 || v.indexOf('\n') !== -1
      ? '"' + v.replace(/"/g, '""') + '"' : v);

    const out = rows.map((r) => {
      const cells = [];
      for (let c = 0; c < columns; c++) {
        const v = quote(r[c] == null ? '' : r[c]);
        cells.push(c === columns - 1 ? v : v.padEnd(widths[c]));
      }
      return cells.join(delimiter + ' ').replace(/\s+$/, '');
    });

    return {
      text: out.join('\n'),
      error: null,
      note: 'Columns padded for readability — that padding is part of the text if you copy it.'
    };
  };

  /* ------------------------------------------------------------------
     CSS-ish minify
     ------------------------------------------------------------------ */

  F.cssMinify = function (text) {
    return {
      text: text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\s*([{}:;,])\s*/g, '$1')
        .replace(/;}/g, '}')
        .replace(/\s+/g, ' ')
        .trim(),
      error: null
    };
  };

  /* ------------------------------------------------------------------
     Dispatch
     ------------------------------------------------------------------ */

  /** @returns {Promise<{text, error, note?, warning?}>} */
  F.run = function (text, lang, opts) {
    try {
      switch (lang.engine) {
        case 'json':     return Promise.resolve(F.json(text, opts));
        case 'sql':      return Promise.resolve(F.sql(text, opts));
        case 'soql':     return Promise.resolve(F.soql(text, opts));
        case 'xml':      return Promise.resolve(F.xml(text, opts, lang));
        case 'prettier': return Promise.resolve(F.prettier(text, opts, lang));
        case 'indent':   return Promise.resolve(F.indent(text, opts));
        case 'tidy':     return Promise.resolve(F.tidy(text, opts));
        case 'ini':      return Promise.resolve(F.ini(text, opts));
        case 'csv':      return Promise.resolve(F.csv(text, opts));
        default:         return Promise.resolve({ text: String(text), error: null });
      }
    } catch (err) {
      return Promise.resolve({ text: '', error: { message: err.message || String(err) } });
    }
  };

  /** @returns {Promise<{text, error}>} */
  F.minify = function (text, lang) {
    try {
      if (lang.id === 'json') return Promise.resolve(F.jsonMinify(text));
      if (lang.id === 'sql' || lang.id === 'soql') return Promise.resolve(F.sqlMinify(text));
      if (['xml', 'html', 'svg', 'lwchtml', 'visualforce'].indexOf(lang.id) !== -1) {
        return Promise.resolve(F.xmlMinify(text));
      }
      if (['css', 'scss', 'less'].indexOf(lang.id) !== -1) return Promise.resolve(F.cssMinify(text));
      return Promise.resolve({ text: '', error: { message: 'Minifying ' + lang.label + ' is not supported.' } });
    } catch (err) {
      return Promise.resolve({ text: '', error: { message: err.message || String(err) } });
    }
  };

  global.Formatters = F;
})(window);
