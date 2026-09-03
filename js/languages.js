/**
 * The language table.
 *
 * Two independent capabilities per language:
 *
 *   engine  — how BEAUTIFY reformats the text:
 *     json / sql / xml / ini / csv  purpose-built formatters
 *     prettier                      real, language-aware formatting
 *     indent                        generic brace re-indenter (Java, C-family …)
 *     tidy                          whitespace-only clean-up for languages whose
 *                                   indentation carries meaning (Python) or that
 *                                   have no browser formatter (Ruby, Shell)
 *     none                          text left exactly as pasted
 *
 *   render  — an optional rendered view (prose, preview, tree, table, image).
 *
 * `defaultMode` picks which of the two opens first.
 */
(function (global) {
  const LANGUAGES = [
    { id: 'json',       label: 'JSON',        engine: 'json',     hljs: 'json',  minify: true, render: 'jsonTree' },
    { id: 'sql',        label: 'SQL / MySQL', engine: 'sql',      hljs: 'sql',   minify: true },
    { id: 'xml',        label: 'XML',         engine: 'xml',      hljs: 'xml',   minify: true, render: 'xmlTree' },
    { id: 'svg',        label: 'SVG',         engine: 'xml',      hljs: 'xml',   minify: true, render: 'svg',   defaultMode: 'render' },
    { id: 'html',       label: 'HTML',        engine: 'prettier', parser: 'html',       hljs: 'xml',   plugins: ['html'], minify: true, render: 'html', defaultMode: 'render' },
    { id: 'markdown',   label: 'Markdown',    engine: 'prettier', parser: 'markdown',   hljs: 'markdown', plugins: ['markdown'], render: 'markdown', defaultMode: 'render' },
    { id: 'csv',        label: 'CSV / TSV',   engine: 'csv',      hljs: 'plaintext', render: 'table', defaultMode: 'render' },
    { id: 'diff',       label: 'Diff',        engine: 'none',     hljs: 'diff',  render: 'diff', defaultMode: 'render' },

    // Salesforce. Apex has no highlight.js grammar of its own upstream and no
    // browser formatter, so it is highlighted by js/hljs-salesforce.js and laid
    // out by the brace re-indenter. LWC templates and Visualforce go through
    // the XML indenter rather than Prettier: Prettier's html parser rewrites
    // `for:each={items}` into `for:each="{items}"`, which is a string literal
    // and a broken component.
    { id: 'apex',        label: 'Apex',               engine: 'indent',   hljs: 'apex' },
    { id: 'soql',        label: 'SOQL / SOSL',        engine: 'soql',     hljs: 'soql', minify: true },
    { id: 'lwcjs',       label: 'LWC JavaScript',     engine: 'prettier', parser: 'babel', hljs: 'javascript', plugins: ['babel', 'estree'] },
    { id: 'lwchtml',     label: 'LWC template',       engine: 'xml',      hljs: 'xml', minify: true, lenientMarkup: true },
    { id: 'visualforce', label: 'Visualforce / Aura', engine: 'xml',      hljs: 'xml', minify: true, lenientMarkup: true },

    { id: 'javascript', label: 'JavaScript',  engine: 'prettier', parser: 'babel',      hljs: 'javascript', plugins: ['babel', 'estree'] },
    { id: 'typescript', label: 'TypeScript',  engine: 'prettier', parser: 'typescript', hljs: 'typescript', plugins: ['typescript', 'estree'] },
    { id: 'css',        label: 'CSS',         engine: 'prettier', parser: 'css',        hljs: 'css',   plugins: ['postcss'], minify: true },
    { id: 'scss',       label: 'SCSS',        engine: 'prettier', parser: 'scss',       hljs: 'scss',  plugins: ['postcss'], minify: true },
    { id: 'less',       label: 'Less',        engine: 'prettier', parser: 'less',       hljs: 'less',  plugins: ['postcss'], minify: true },
    { id: 'yaml',       label: 'YAML',        engine: 'prettier', parser: 'yaml',       hljs: 'yaml',  plugins: ['yaml'], render: 'yamlTree' },
    { id: 'graphql',    label: 'GraphQL',     engine: 'prettier', parser: 'graphql',    hljs: 'graphql', plugins: ['graphql'] },

    // Brace-driven re-indent: correct-ish layout, not a real formatter.
    { id: 'java',   label: 'Java',   engine: 'indent', hljs: 'java' },
    { id: 'c',      label: 'C',      engine: 'indent', hljs: 'c' },
    { id: 'cpp',    label: 'C++',    engine: 'indent', hljs: 'cpp' },
    { id: 'csharp', label: 'C#',     engine: 'indent', hljs: 'csharp' },
    { id: 'kotlin', label: 'Kotlin', engine: 'indent', hljs: 'kotlin' },
    { id: 'go',     label: 'Go',     engine: 'indent', hljs: 'go' },
    { id: 'rust',   label: 'Rust',   engine: 'indent', hljs: 'rust' },
    { id: 'php',    label: 'PHP',    engine: 'indent', hljs: 'php' },
    { id: 'swift',  label: 'Swift',  engine: 'indent', hljs: 'swift' },
    { id: 'scala',  label: 'Scala',  engine: 'indent', hljs: 'scala' },
    { id: 'dart',   label: 'Dart',   engine: 'indent', hljs: 'dart' },

    // Whitespace-significant or no formatter available: tidy only.
    { id: 'python', label: 'Python', engine: 'tidy', hljs: 'python' },
    { id: 'ruby',   label: 'Ruby',   engine: 'tidy', hljs: 'ruby' },
    { id: 'bash',   label: 'Shell',  engine: 'tidy', hljs: 'bash' },

    { id: 'ini',       label: 'INI / TOML', engine: 'ini',  hljs: 'ini', minify: false },
    { id: 'plaintext', label: 'Plain text', engine: 'none', hljs: 'plaintext' }
  ];

  const BY_ID = {};
  LANGUAGES.forEach((l) => { BY_ID[l.id] = l; });

  /** How a language's beautify result should be described to the user. */
  const ENGINE_NOTE = {
    json: 'formatted',
    sql: 'formatted',
    soql: 'formatted',
    xml: 'formatted',
    csv: 'columns aligned',
    ini: 'formatted',
    prettier: 'formatted',
    indent: 're-indented from braces — not a full formatter',
    tidy: 'tidied only — indentation is preserved because it carries meaning',
    none: 'no formatter for this language — shown as pasted'
  };

  /** Label for each render mode, shown on the toggle. */
  const RENDER_LABEL = {
    markdown: 'Preview', html: 'Preview', svg: 'Image', diff: 'Diff',
    table: 'Table', jsonTree: 'Tree', yamlTree: 'Tree', xmlTree: 'Tree'
  };

  global.Languages = { LANGUAGES, BY_ID, ENGINE_NOTE, RENDER_LABEL };
})(window);
