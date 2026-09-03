/**
 * Rendered views.
 *
 * Beautify shows you the text laid out; Render shows you what the text *is* —
 * prose for Markdown, a preview for HTML, a tree for JSON, a table for CSV.
 *
 * Every renderer takes (text, mount, opts) and returns { status, error }.
 * Anything derived from the pasted text is sanitised before it reaches the DOM.
 */
(function (global) {
  const R = {};

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  /* ------------------------------------------------------------------
     Markdown
     ------------------------------------------------------------------ */

  let markedReady = false;
  R.markdown = function (text, mount) {
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
      return { error: { message: 'The Markdown renderer failed to load.' } };
    }
    if (!markedReady) {
      marked.use({ gfm: true, breaks: false });
      markedReady = true;
    }
    const article = el('article', 'render render-markdown');
    article.innerHTML = DOMPurify.sanitize(marked.parse(text), { ADD_ATTR: ['target'] });

    article.querySelectorAll('input[type="checkbox"]').forEach((b) => { b.disabled = true; });
    article.querySelectorAll('pre > code').forEach((code) => {
      try { hljs.highlightElement(code); } catch (_) { /* unknown language */ }
    });
    // Links in a preview should not navigate the tool away.
    article.querySelectorAll('a[href]').forEach((a) => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });

    mount.appendChild(article);
    const words = (article.textContent || '').trim().split(/\s+/).filter(Boolean).length;
    return { status: words + ' words' };
  };

  /* ------------------------------------------------------------------
     HTML
     ------------------------------------------------------------------ */

  R.html = function (text, mount) {
    const box = el('div', 'render render-html');
    // `sandbox` with no allow-scripts: the previewed page cannot run anything
    // or reach this extension's context.
    const frame = el('iframe', 'preview-frame');
    frame.setAttribute('sandbox', '');
    frame.setAttribute('srcdoc', text);
    box.appendChild(frame);
    mount.appendChild(box);
    return { status: 'sandboxed preview — scripts do not run' };
  };

  /* ------------------------------------------------------------------
     SVG
     ------------------------------------------------------------------ */

  R.svg = function (text, mount) {
    if (typeof DOMPurify === 'undefined') {
      return { error: { message: 'The sanitiser failed to load.' } };
    }
    const box = el('div', 'render render-image');
    const holder = el('div', 'image-holder');
    holder.innerHTML = DOMPurify.sanitize(text, { USE_PROFILES: { svg: true, svgFilters: true } });
    if (!holder.querySelector('svg')) {
      return { error: { message: 'No drawable <svg> element was found.' } };
    }
    box.appendChild(holder);
    mount.appendChild(box);
    return { status: 'SVG preview' };
  };

  /* ------------------------------------------------------------------
     Diff
     ------------------------------------------------------------------ */

  function diffClass(line) {
    if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity |rename )/.test(line)) return 'meta';
    if (/^@@/.test(line)) return 'hunk';
    if (/^\+/.test(line)) return 'add';
    if (/^-/.test(line)) return 'del';
    return 'ctx';
  }

  R.diff = function (text, mount) {
    const box = el('div', 'render render-diff');
    let added = 0;
    let removed = 0;
    text.split('\n').forEach((line) => {
      const kind = diffClass(line);
      if (kind === 'add') added++;
      if (kind === 'del') removed++;
      box.appendChild(el('div', 'diff-line diff-' + kind, line || ' '));
    });
    mount.appendChild(box);
    return { status: '+' + added + ' −' + removed };
  };

  /* ------------------------------------------------------------------
     CSV / TSV table
     ------------------------------------------------------------------ */

  const MAX_ROWS = 5000;
  const isNumeric = (v) => v !== '' && v != null && !isNaN(Number(String(v).replace(/[, ]/g, '')));

  R.table = function (text, mount) {
    const F = global.Formatters;
    const rows = F.parseDelimited(text, F.detectDelimiter(text));
    if (!rows.length) return { error: { message: 'No rows to show.' } };

    const header = rows[0];
    let body = rows.slice(1);
    const truncated = body.length > MAX_ROWS;
    if (truncated) body = body.slice(0, MAX_ROWS);

    const box = el('div', 'render render-table');
    const table = el('table', 'grid');
    const thead = el('thead');
    const headRow = el('tr');
    headRow.appendChild(el('th', 'grid-rownum', '#'));

    header.forEach((name, col) => {
      const th = el('th', 'sortable', name || '(unnamed)');
      let direction = 0;
      th.addEventListener('click', () => {
        direction = direction === 1 ? -1 : 1;
        const numeric = body.every((r) => !r[col] || isNumeric(r[col]));
        body.sort((a, b) => {
          const x = a[col] || '';
          const y = b[col] || '';
          const cmp = numeric
            ? Number(String(x).replace(/[, ]/g, '') || 0) - Number(String(y).replace(/[, ]/g, '') || 0)
            : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
          return cmp * direction;
        });
        thead.querySelectorAll('th').forEach((h) => h.classList.remove('sorted-asc', 'sorted-desc'));
        th.classList.add(direction === 1 ? 'sorted-asc' : 'sorted-desc');
        fill();
      });
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    function fill() {
      tbody.innerHTML = '';
      body.forEach((row, i) => {
        const tr = el('tr');
        tr.appendChild(el('td', 'grid-rownum', String(i + 1)));
        for (let c = 0; c < header.length; c++) {
          tr.appendChild(el('td', isNumeric(row[c]) ? 'is-num' : null, row[c] == null ? '' : row[c]));
        }
        tbody.appendChild(tr);
      });
    }
    fill();
    table.appendChild(tbody);
    box.appendChild(table);
    if (truncated) {
      box.appendChild(el('div', 'render-note',
        'Showing the first ' + MAX_ROWS.toLocaleString() + ' of ' + rows.slice(1).length.toLocaleString() + ' rows.'));
    }
    mount.appendChild(box);
    return { status: body.length + ' rows × ' + header.length + ' cols · click a header to sort' };
  };

  /* ------------------------------------------------------------------
     Data trees (JSON, YAML)
     ------------------------------------------------------------------ */

  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

  function treeRow(key, value, depth) {
    const kind = typeOf(value);
    const row = el('div', 'tree-row');
    row.style.paddingLeft = depth * 16 + 'px';

    if (kind !== 'object' && kind !== 'array') {
      if (key !== null) row.appendChild(el('span', 'tree-key', key));
      const leaf = el('span', 'tree-value tree-' + kind);
      leaf.textContent = kind === 'string' ? JSON.stringify(value) : String(value);
      row.appendChild(leaf);
      return { row, children: null };
    }

    const entries = kind === 'array'
      ? value.map((v, i) => [String(i), v])
      : Object.keys(value).map((k) => [k, value[k]]);

    const twisty = el('span', 'tree-twisty', entries.length ? '▾' : '·');
    row.appendChild(twisty);
    if (key !== null) row.appendChild(el('span', 'tree-key', key));
    row.appendChild(el('span', 'tree-brace', kind === 'array' ? '[' : '{'));
    row.appendChild(el('span', 'tree-count', entries.length + (kind === 'array' ? ' items' : ' keys')));
    row.appendChild(el('span', 'tree-brace', kind === 'array' ? ']' : '}'));

    const childBox = el('div', 'tree-children');
    entries.forEach(([k, v]) => {
      const child = treeRow(k, v, depth + 1);
      childBox.appendChild(child.row);
      if (child.children) childBox.appendChild(child.children);
    });

    let open = entries.length > 0 && entries.length <= 30 && depth < 3;
    childBox.hidden = !open;
    twisty.textContent = entries.length ? (open ? '▾' : '▸') : '·';
    if (entries.length) {
      row.classList.add('is-container');
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        open = !open;
        childBox.hidden = !open;
        twisty.textContent = open ? '▾' : '▸';
      });
    }
    return { row, children: childBox };
  }

  function renderTree(data, mount, statusText) {
    const box = el('div', 'render render-tree');

    const bar = el('div', 'render-bar');
    const expand = el('button', 'mini-btn', 'Expand all');
    const collapse = el('button', 'mini-btn', 'Collapse all');
    bar.append(expand, collapse);
    box.appendChild(bar);

    const treeBox = el('div', 'tree-body');
    const root = treeRow(null, data, 0);
    treeBox.appendChild(root.row);
    if (root.children) { root.children.hidden = false; treeBox.appendChild(root.children); }
    box.appendChild(treeBox);

    const setAll = (open) => {
      treeBox.querySelectorAll('.tree-children').forEach((c) => { c.hidden = !open; });
      treeBox.querySelectorAll('.tree-twisty').forEach((t) => {
        if (t.textContent !== '·') t.textContent = open ? '▾' : '▸';
      });
    };
    expand.addEventListener('click', () => setAll(true));
    collapse.addEventListener('click', () => setAll(false));

    mount.appendChild(box);
    return { status: statusText };
  }

  function describe(data) {
    if (Array.isArray(data)) return data.length + ' items';
    if (data && typeof data === 'object') return Object.keys(data).length + ' keys';
    return typeOf(data);
  }

  R.jsonTree = function (text, mount) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      try {
        data = JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
      } catch (err) {
        return { error: { message: 'Cannot show a tree: ' + err.message } };
      }
    }
    return renderTree(data, mount, describe(data));
  };

  R.yamlTree = function (text, mount) {
    if (typeof jsyaml === 'undefined') {
      return { error: { message: 'The YAML parser failed to load.' } };
    }
    let docs;
    try {
      docs = jsyaml.loadAll(text);
    } catch (err) {
      return { error: { message: 'Cannot show a tree: ' + err.message.split('\n')[0] } };
    }
    const data = docs.length === 1 ? docs[0] : docs;
    return renderTree(data === undefined ? null : data, mount,
      docs.length > 1 ? docs.length + ' documents' : describe(data));
  };

  /* ------------------------------------------------------------------
     XML tree
     ------------------------------------------------------------------ */

  R.xmlTree = function (text, mount) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const failure = doc.getElementsByTagName('parsererror')[0];
    if (failure) {
      return { error: { message: 'Cannot show a tree: ' + failure.textContent.replace(/\s+/g, ' ').trim().slice(0, 200) } };
    }

    const box = el('div', 'render render-tree');
    const treeBox = el('div', 'tree-body');
    let nodes = 0;

    const walk = (node, depth, into) => {
      if (node.nodeType === 3) {
        const value = node.nodeValue.trim();
        if (value) {
          const row = el('div', 'tree-row');
          row.style.paddingLeft = depth * 16 + 'px';
          row.appendChild(el('span', 'tree-value tree-string', value));
          into.appendChild(row);
        }
        return;
      }
      if (node.nodeType !== 1) return;
      nodes++;

      const row = el('div', 'tree-row');
      row.style.paddingLeft = depth * 16 + 'px';

      const kids = Array.from(node.childNodes).filter(
        (n) => n.nodeType === 1 || (n.nodeType === 3 && n.nodeValue.trim())
      );
      const twisty = el('span', 'tree-twisty', kids.length ? '▾' : '·');
      row.appendChild(twisty);
      row.appendChild(el('span', 'tree-tag', node.nodeName));

      Array.from(node.attributes || []).forEach((attr) => {
        row.appendChild(el('span', 'tree-attr', attr.name + '="' + attr.value + '"'));
      });
      into.appendChild(row);

      if (!kids.length) return;
      const childBox = el('div', 'tree-children');
      into.appendChild(childBox);
      kids.forEach((kid) => walk(kid, depth + 1, childBox));

      let open = depth < 3;
      childBox.hidden = !open;
      twisty.textContent = open ? '▾' : '▸';
      row.classList.add('is-container');
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        open = !open;
        childBox.hidden = !open;
        twisty.textContent = open ? '▾' : '▸';
      });
    };

    Array.from(doc.childNodes).forEach((n) => walk(n, 0, treeBox));
    box.appendChild(treeBox);
    mount.appendChild(box);
    return { status: nodes + ' elements' };
  };

  /** @returns {{status?: string, error?: {message: string}}} */
  R.run = function (name, text, mount, opts) {
    const fn = R[name];
    if (typeof fn !== 'function') return { error: { message: 'No renderer called ' + name + '.' } };
    try {
      return fn(text, mount, opts) || {};
    } catch (err) {
      return { error: { message: (err && err.message) || String(err) } };
    }
  };

  global.Renderers = R;
})(window);
