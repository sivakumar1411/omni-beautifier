/**
 * Beautifier app.
 *
 * Paste on the left, formatted and highlighted on the right. The language is
 * auto-detected on every input change but always shown and always overridable,
 * so a wrong guess costs one click rather than a confusing result.
 */
(function (global) {
  const $ = (id) => document.getElementById(id);

  const state = {
    theme: 'dark',
    languageChoice: 'auto',   // 'auto' or a language id
    detected: null,           // result from Detect.detect
    activeId: 'plaintext',    // language actually used for the last run
    mode: null,               // 'render' | 'beautify'; null = follow the language
    modeChosen: false,        // true once the user has picked explicitly
    output: '',
    split: 50,
    sqlNesting: 'colors'  // 'colors' | 'zones' | 'off' — sub-query depth colouring
  };

  /* ----------------------------------------------------------------
     Theme
     ---------------------------------------------------------------- */

  const systemDark = global.matchMedia ? global.matchMedia('(prefers-color-scheme: dark)') : null;

  function applyTheme() {
    const resolved = state.theme === 'auto'
      ? (systemDark && systemDark.matches ? 'dark' : 'light')
      : state.theme;
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.dataset.resolvedTheme = resolved;
    document.querySelectorAll('.theme-opt').forEach((b) => {
      b.classList.toggle('active', b.dataset.theme === state.theme);
    });
  }

  function setTheme(theme) {
    state.theme = theme;
    applyTheme();
    save({ theme });
  }

  function save(patch) {
    try { chrome.storage.local.set(patch); } catch (_) { /* not an extension context */ }
  }

  /* ----------------------------------------------------------------
     Options
     ---------------------------------------------------------------- */

  function currentOptions() {
    const indentValue = $('indent-select').value;
    return {
      useTabs: indentValue === 'tab',
      indent: indentValue === 'tab' ? 4 : parseInt(indentValue, 10),
      sqlDialect: $('dialect-select').value,
      keywordCase: $('keyword-select').value
    };
  }

  /** The language to format with, resolving 'auto' against the detector. */
  function resolveLanguage(text) {
    if (state.languageChoice !== 'auto') {
      state.detected = null;
      return global.Languages.BY_ID[state.languageChoice] || global.Languages.BY_ID.plaintext;
    }
    state.detected = global.Detect.detect(text);
    return global.Languages.BY_ID[state.detected.id] || global.Languages.BY_ID.plaintext;
  }

  /* ----------------------------------------------------------------
     Rendering
     ---------------------------------------------------------------- */

  function renderOutput(text, lang) {
    state.output = text;
    const code = $('output');
    const gutter = $('output-gutter');

    $('empty-state').hidden = !!text;
    if (!text) {
      code.innerHTML = '';
      gutter.innerHTML = '';
      $('output-meta').textContent = '';
      if (global.Brackets) global.Brackets.clear();
      $('selection-note').textContent = '';
      return;
    }

    code.textContent = text;
    code.className = 'hljs';
    if (lang && lang.hljs && lang.hljs !== 'plaintext') {
      code.classList.add('language-' + lang.hljs);
      try {
        // Explicit language beats auto-detection, which we have already done.
        const res = hljs.highlight(text, { language: lang.hljs, ignoreIllegals: true });
        code.innerHTML = res.value;
      } catch (_) {
        code.textContent = text;
      }
    }

    paintSqlNesting(code, text, lang);

    const lines = text.split('\n');
    gutter.innerHTML = '';
    lines.forEach((_, i) => {
      const em = document.createElement('em');
      em.textContent = String(i + 1);
      gutter.appendChild(em);
    });
    $('output-meta').textContent = lines.length + ' lines · ' + formatBytes(text.length);

    // Last, so the clickable spans sit innermost and survive the passes above.
    $('selection-note').textContent = '';
    if (global.Brackets) global.Brackets.paint(code, text, lang && lang.id, gutter);
  }

  /**
   * Recolour the highlighted SQL by sub-query depth, and show a legend so the
   * colours are self-explaining. A no-op for anything that is not SQL, or when
   * the statement turns out to be flat.
   */
  function paintSqlNesting(code, text, lang) {
    const legend = $('nesting-legend');
    legend.hidden = true;
    legend.innerHTML = '';
    document.documentElement.dataset.sqlZones = state.sqlNesting === 'zones' ? 'on' : 'off';

    // SOQL gets this as well: a relationship sub-query is exactly the same
    // shape as a SQL one, and nests just as deep.
    const nestable = lang && (lang.id === 'sql' || lang.id === 'soql');
    if (!nestable || state.sqlNesting === 'off') return;
    if (!global.SqlNesting) return;

    const found = global.SqlNesting.paint(code, text);
    if (!found.maxDepth) return;

    const levels = Math.min(found.maxDepth, global.SqlNesting.CYCLE);
    legend.appendChild(chipFor(0, 'outer'));
    for (let d = 1; d <= levels; d++) {
      legend.appendChild(chipFor(d, d === 1 ? 'sub-query' : 'level ' + d));
    }
    legend.hidden = false;
    legend.title = found.subqueries + (found.subqueries === 1 ? ' sub-query' : ' sub-queries')
      + ', nested ' + found.maxDepth + ' deep';
  }

  function chipFor(depth, label) {
    const chip = document.createElement('span');
    chip.className = 'legend-chip' + (depth ? ' sqlq-' + depth : ' is-outer');
    chip.textContent = label;
    return chip;
  }

  /** Say what a click just grabbed, so the selection is not silent. */
  function showSelection(hit) {
    const note = $('selection-note');
    if (!hit) { note.textContent = ''; return; }
    const unit = hit.kind === 'tag' ? 'element' : 'block';
    note.textContent = 'selected ' + unit + ' · lines ' + hit.from
      + (hit.lines > 1 ? '–' + hit.to : '')
      + ' · ' + hit.lines + (hit.lines === 1 ? ' line · ' : ' lines · ')
      + formatBytes(hit.chars);
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function showBanner(kind, message, location) {
    const banner = $('banner');
    banner.hidden = false;
    banner.className = 'banner' + (kind === 'error' ? '' : ' is-' + kind);
    $('banner-icon').textContent = kind === 'error' ? '!' : (kind === 'warning' ? '!' : 'i');
    $('banner-text').textContent = location
      ? message + '  (line ' + location.line + ', column ' + location.column + ')'
      : message;

    const jump = $('banner-jump');
    jump.hidden = !location;
    jump.onclick = location ? () => jumpToLine(location.line, location.column) : null;
  }

  function hideBanner() { $('banner').hidden = true; }

  /** Put the caret on the offending line in the source pane. */
  function jumpToLine(line, column) {
    const input = $('input');
    const lines = input.value.split('\n');
    let offset = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
    offset += Math.max(0, (column || 1) - 1);

    input.focus();
    input.setSelectionRange(offset, offset);
    // Scroll the target line roughly into the middle of the textarea.
    const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 19;
    input.scrollTop = Math.max(0, (line - 1) * lineHeight - input.clientHeight / 2);
  }

  function setStatus(lang) {
    const chip = $('status-lang');
    const detected = state.detected;
    chip.textContent = lang.label + (detected ? ' · detected' : ' · chosen');
    chip.className = 'chip ' + (detected ? detected.confidence : 'likely');
    chip.title = detected ? detected.why : 'Language selected manually';
    $('status-engine').textContent = global.Languages.ENGINE_NOTE[lang.engine] || '';
  }

  /* ----------------------------------------------------------------
     Render / Beautify mode
     ---------------------------------------------------------------- */

  /**
   * Which view to show. A language's own default wins until the user picks a
   * mode themselves, at which point their choice sticks across languages that
   * can honour it.
   */
  function modeFor(lang) {
    if (!lang.render) return 'beautify';
    if (state.modeChosen && state.mode) return state.mode;
    return lang.defaultMode === 'render' ? 'render' : 'beautify';
  }

  function syncModeToggle(lang, mode) {
    const toggle = $('mode-toggle');
    toggle.hidden = !lang.render;
    if (!lang.render) return;

    $('mode-render').textContent = global.Languages.RENDER_LABEL[lang.render] || 'Preview';
    $('mode-render').classList.toggle('active', mode === 'render');
    $('mode-beautify').classList.toggle('active', mode === 'beautify');
    $('output-title').textContent = mode === 'render'
      ? ($('mode-render').textContent)
      : 'Formatted';
  }

  function showPane(mode) {
    $('output-scroll').hidden = mode === 'render';
    $('render-scroll').hidden = mode !== 'render';
  }

  /** Draw the rendered view for the current input. */
  function renderView(text, lang) {
    const mount = $('render-scroll');
    mount.innerHTML = '';
    const result = global.Renderers.run(lang.render, text, mount, currentOptions());

    if (result.error) {
      mount.innerHTML = '';
      showBanner('error', result.error.message, result.error.location || null);
      $('output-meta').textContent = '';
      return;
    }
    $('output-meta').textContent = result.status || '';
    $('status-note').textContent = '';
  }

  /* ----------------------------------------------------------------
     Actions
     ---------------------------------------------------------------- */

  let runToken = 0;

  function format() {
    const text = $('input').value;
    updateInputMeta();
    hideBanner();
    $('status-note').textContent = '';

    if (!text.trim()) {
      $('render-scroll').innerHTML = '';
      $('mode-toggle').hidden = true;
      showPane('beautify');
      renderOutput('', null);
      $('status-lang').textContent = '';
      $('status-engine').textContent = '';
      markRunComplete();
      return Promise.resolve();
    }

    const lang = resolveLanguage(text);
    state.activeId = lang.id;
    syncLanguageControls(lang);
    setStatus(lang);

    const mode = modeFor(lang);
    syncModeToggle(lang, mode);
    showPane(mode);

    if (mode === 'render') {
      renderView(text, lang);
      markRunComplete();
      return Promise.resolve();
    }

    const token = ++runToken;
    const opts = currentOptions();

    return global.Formatters.run(text, lang, opts)
      .then((result) => {
        // Only rescue genuinely uncertain guesses fed to a parser-based
        // formatter. A confident detection that fails to parse is a real syntax
        // error worth reporting — that is the whole point of validating JSON —
        // so those must fall through untouched.
        const wasWeakGuess = state.detected && state.detected.confidence === 'guess';
        if (result.error && wasWeakGuess && lang.engine === 'prettier') {
          const retry = global.Formatters.indent(text, opts);
          if (retry.text) {
            return {
              text: retry.text,
              error: null,
              fellBack: 'Detected ' + lang.label + ', but it did not parse — re-indented generically instead. ' +
                'Pick the language above if this guess was wrong.'
            };
          }
        }
        return result;
      })
      .then((result) => {
        // A newer run started while this one was in flight.
        if (token !== runToken) return;

        if (result.error) {
          renderOutput('', lang);
          showBanner('error', result.error.message, result.error.location);
        } else {
          renderOutput(result.text, lang);

          if (result.fellBack) showBanner('warning', result.fellBack, null);
          else if (result.warning) showBanner('warning', result.warning.message, result.warning.location);
          else if (result.note) showBanner('info', result.note, null);

          if (result.fellBack) {
            $('status-note').textContent = 'Fell back to generic re-indenting.';
          } else if (lang.engine === 'none') {
            $('status-note').textContent = 'No formatter for ' + lang.label + ' — shown as pasted, with highlighting.';
          } else if (lang.engine === 'indent') {
            $('status-note').textContent = 'Re-indented from braces — not a full ' + lang.label + ' formatter.';
          }
        }
        markRunComplete();
      });
  }

  /**
   * Bump a counter on <body> after every completed run. Purely so automated
   * tests can wait for a result instead of guessing at a delay.
   */
  let runsCompleted = 0;
  function markRunComplete() {
    runsCompleted += 1;
    document.body.dataset.runs = String(runsCompleted);
  }

  function minify() {
    const text = $('input').value;
    if (!text.trim()) return;
    hideBanner();

    const lang = resolveLanguage(text);
    state.activeId = lang.id;
    syncLanguageControls(lang);
    setStatus(lang);

    global.Formatters.minify(text, lang).then((result) => {
      if (result.error) {
        showBanner('error', result.error.message, result.error.location);
        markRunComplete();
        return;
      }
      renderOutput(result.text, lang);
      $('status-note').textContent = 'Minified.';
      markRunComplete();
    });
  }

  function copyOutput() {
    if (!state.output) {
      toast($('render-scroll').hidden ? 'Nothing to copy yet.' : 'Switch to Beautify to copy the text.');
      return;
    }
    navigator.clipboard.writeText(state.output)
      .then(() => toast('Copied to clipboard.'))
      .catch(() => toast('Could not access the clipboard.'));
  }

  const DOWNLOAD_EXT = {
    json: 'json', sql: 'sql', xml: 'xml', html: 'html', javascript: 'js', typescript: 'ts',
    css: 'css', scss: 'scss', less: 'less', yaml: 'yaml', markdown: 'md', graphql: 'graphql',
    java: 'java', c: 'c', cpp: 'cpp', csharp: 'cs', kotlin: 'kt', go: 'go', rust: 'rs',
    php: 'php', swift: 'swift', scala: 'scala', dart: 'dart', python: 'py', ruby: 'rb',
    bash: 'sh', ini: 'ini', diff: 'diff', plaintext: 'txt'
  };

  function downloadOutput() {
    if (!state.output) { toast('Nothing to download yet.'); return; }
    const ext = DOWNLOAD_EXT[state.activeId] || 'txt';
    const blob = new Blob([state.output], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'formatted.' + ext;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function clearAll() {
    $('input').value = '';
    renderOutput('', null);
    hideBanner();
    state.detected = null;
    $('status-lang').textContent = '';
    $('status-engine').textContent = '';
    $('status-note').textContent = '';
    updateInputMeta();
    $('input').focus();
  }

  let toastTimer = null;
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
  }

  function updateInputMeta() {
    const text = $('input').value;
    $('input-meta').textContent = text
      ? text.split('\n').length + ' lines · ' + formatBytes(text.length)
      : '';
  }

  /** Dialect and keyword-case controls only make sense for SQL. */
  function syncLanguageControls(lang) {
    // SOQL has no dialects, but it does have keyword casing and sub-queries.
    const isSql = lang.id === 'sql';
    const isQuery = isSql || lang.id === 'soql';
    $('dialect-field').hidden = !isSql;
    $('keyword-field').hidden = !isQuery;
    $('nesting-field').hidden = !isQuery;
    $('btn-minify').disabled = !lang.minify;
    $('btn-minify').title = lang.minify
      ? 'Compact to one line'
      : 'Minifying ' + lang.label + ' is not supported';
  }

  /* ----------------------------------------------------------------
     Splitter
     ---------------------------------------------------------------- */

  function wireSplitter() {
    const splitter = $('splitter');
    const split = $('split');
    let dragging = false;

    const setSplit = (pct) => {
      state.split = Math.min(85, Math.max(15, pct));
      document.documentElement.style.setProperty('--split', state.split + '%');
    };

    splitter.addEventListener('mousedown', (e) => {
      dragging = true;
      splitter.classList.add('active');
      split.classList.add('dragging');
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = split.getBoundingClientRect();
      setSplit(((e.clientX - rect.left) / rect.width) * 100);
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      splitter.classList.remove('active');
      split.classList.remove('dragging');
      save({ split: state.split });
    });

    splitter.addEventListener('dblclick', () => { setSplit(50); save({ split: 50 }); });
    setSplit(state.split);
  }

  /* ----------------------------------------------------------------
     Samples
     ---------------------------------------------------------------- */

  const SAMPLES = {
    JSON: '{"id":42,"name":"Widget","tags":["a","b"],"meta":{"active":true,"score":9.5,"parent":null}}',
    MySQL: 'select u.id,u.name,count(`o`.id) as orders from users u left join orders o on o.user_id=u.id where u.active=1 and u.created_at>"2024-01-01" group by u.id having orders>2 order by orders desc limit 10;',
    Java: 'public class Main{private static final String MSG="hi";public static void main(String[] args){if(args.length>0){System.out.println(MSG);}else{for(int i=0;i<3;i++){System.out.println(i);}}}}',
    XML: '<?xml version="1.0"?><catalog><book id="1"><title>Dune</title><price>9.99</price></book><book id="2"><title>Neuromancer</title><price>7.50</price></book></catalog>',
    CSS: '.card{display:flex;gap:8px;color:#333}.card:hover{background:#eee}@media(max-width:600px){.card{display:block}}',
    TypeScript: 'interface User{id:number;name:string}const find=(users:User[],id:number):User|undefined=>{return users.find(u=>u.id===id)}',
    Apex: 'public with sharing class AccountService{@AuraEnabled(cacheable=true) public static List<Account> topAccounts(String tier){List<Account> rows=[SELECT Id,Name,(SELECT LastName FROM Contacts) FROM Account WHERE Tier__c=:tier AND CreatedDate=LAST_N_DAYS:30 ORDER BY Name LIMIT 50];for(Account a:rows){System.debug(a.Name);}return rows;}}',
    SOQL: 'SELECT Id, Name, (SELECT LastName, Email FROM Contacts WHERE CreatedDate = LAST_N_DAYS:7) FROM Account WHERE Tier__c = :tier AND Owner.Profile.Name != null WITH SECURITY_ENFORCED ORDER BY Name DESC LIMIT 100',
    LWC: '<template><lightning-card title="Accounts"><template for:each={accounts} for:item="acc"><p key={acc.Id} class="row">{acc.Name}</p></template></lightning-card></template>'
  };

  function renderSamples() {
    const box = $('samples');
    Object.keys(SAMPLES).forEach((name) => {
      const chip = document.createElement('button');
      chip.className = 'sample-chip';
      chip.textContent = name;
      chip.addEventListener('click', () => {
        $('input').value = SAMPLES[name];
        $('lang-select').value = 'auto';
        state.languageChoice = 'auto';
        format();
      });
      box.appendChild(chip);
    });
  }

  /* ----------------------------------------------------------------
     Wiring
     ---------------------------------------------------------------- */

  function populateLanguages() {
    const select = $('lang-select');
    global.Languages.LANGUAGES.forEach((lang) => {
      const opt = document.createElement('option');
      opt.value = lang.id;
      opt.textContent = lang.label;
      select.appendChild(opt);
    });
  }

  function wire() {
    const input = $('input');
    let debounce = null;

    // Format as you type, but only once you have stopped.
    input.addEventListener('input', () => {
      updateInputMeta();
      clearTimeout(debounce);
      debounce = setTimeout(format, 260);
    });

    // A paste is a deliberate act: format it straight away.
    input.addEventListener('paste', () => {
      clearTimeout(debounce);
      setTimeout(format, 0);
    });

    $('lang-select').addEventListener('change', (e) => {
      state.languageChoice = e.target.value;
      save({ languageChoice: state.languageChoice });
      format();
    });
    $('nesting-select').addEventListener('change', (e) => {
      state.sqlNesting = e.target.value;
      save({ sqlNesting: state.sqlNesting });
      // Re-highlight from the stored output; no need to re-run the formatter.
      renderOutput(state.output, global.Languages.BY_ID[state.activeId]);
    });
    ['indent-select', 'dialect-select', 'keyword-select'].forEach((id) => {
      $(id).addEventListener('change', () => {
        save({
          indent: $('indent-select').value,
          dialect: $('dialect-select').value,
          keywordCase: $('keyword-select').value
        });
        format();
      });
    });

    document.querySelectorAll('.mode-opt').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.mode = btn.dataset.mode;
        state.modeChosen = true;
        save({ mode: state.mode, modeChosen: true });
        format();
      });
    });

    if (global.Brackets) {
      global.Brackets.install({ code: $('output'), onSelect: showSelection });
    }

    $('btn-format').addEventListener('click', format);
    $('btn-minify').addEventListener('click', minify);
    $('btn-copy').addEventListener('click', copyOutput);
    $('btn-download').addEventListener('click', downloadOutput);
    $('btn-clear').addEventListener('click', clearAll);
    $('banner-x').addEventListener('click', hideBanner);

    document.querySelectorAll('.theme-opt').forEach((btn) => {
      btn.addEventListener('click', () => setTheme(btn.dataset.theme));
    });
    if (systemDark && systemDark.addEventListener) {
      systemDark.addEventListener('change', () => { if (state.theme === 'auto') applyTheme(); });
    }

    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key === 'Enter') { e.preventDefault(); format(); return; }
      if (e.shiftKey && e.key.toLowerCase() === 'c') { e.preventDefault(); copyOutput(); }
    });

    // Tab inserts an indent rather than leaving the textarea.
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const opts = currentOptions();
      const unit = opts.useTabs ? '\t' : ' '.repeat(opts.indent);
      const start = input.selectionStart;
      const end = input.selectionEnd;
      input.value = input.value.slice(0, start) + unit + input.value.slice(end);
      input.setSelectionRange(start + unit.length, start + unit.length);
    });
  }

  /* ----------------------------------------------------------------
     Boot
     ---------------------------------------------------------------- */

  function init() {
    populateLanguages();
    renderSamples();
    wire();
    wireSplitter();
    applyTheme();
    syncLanguageControls(global.Languages.BY_ID.plaintext);

    let restored = false;
    try {
      chrome.storage.local.get(
        ['theme', 'languageChoice', 'indent', 'dialect', 'keywordCase', 'split', 'pendingInput',
         'mode', 'modeChosen', 'sqlNesting'],
        (cfg) => {
          if (!cfg) return;
          if (cfg.theme) { state.theme = cfg.theme; applyTheme(); }
          if (cfg.languageChoice) { state.languageChoice = cfg.languageChoice; $('lang-select').value = cfg.languageChoice; }
          if (cfg.indent) $('indent-select').value = cfg.indent;
          if (cfg.dialect) $('dialect-select').value = cfg.dialect;
          if (cfg.keywordCase) $('keyword-select').value = cfg.keywordCase;
          if (cfg.sqlNesting) { state.sqlNesting = cfg.sqlNesting; $('nesting-select').value = cfg.sqlNesting; }
          if (cfg.modeChosen && cfg.mode) { state.mode = cfg.mode; state.modeChosen = true; }
          if (cfg.split) {
            state.split = cfg.split;
            document.documentElement.style.setProperty('--split', cfg.split + '%');
          }
          // Text handed over by the "Beautify selected text" context menu.
          if (cfg.pendingInput) {
            $('input').value = cfg.pendingInput;
            chrome.storage.local.remove('pendingInput');
            restored = true;
            format();
          }
        }
      );
    } catch (_) { /* not an extension context */ }

    if (!restored) $('input').focus();
    updateInputMeta();
  }

  document.addEventListener('DOMContentLoaded', init);
})(window);
