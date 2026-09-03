/**
 * highlight.js grammars for the Salesforce languages.
 *
 * The bundled highlight.js ships 36 grammars and none of them is Apex or SOQL,
 * so Apex used to be highlighted as Java — close enough to look right and wrong
 * in all the places that matter: `with sharing`, `global`, `testMethod` and,
 * most of all, the SOQL query sitting in square brackets in the middle of a
 * method.
 *
 * Both grammars set `disableAutodetect`. They are only ever selected
 * explicitly, by `Detect` or by the language menu, and letting them into
 * `highlightAuto()` would make it guess Apex for ordinary Java.
 */
(function (global) {
  const hljs = global.hljs;
  if (!hljs || typeof hljs.registerLanguage !== 'function') return;

  /* ------------------------------------------------------------------
     SOQL / SOSL

     Registered first: Apex embeds it as a sub-language.
     ------------------------------------------------------------------ */

  hljs.registerLanguage('soql', function () {
    const KEYWORD = [
      'SELECT', 'FROM', 'WHERE', 'WITH', 'DATA', 'CATEGORY', 'GROUP', 'BY',
      'ROLLUP', 'CUBE', 'HAVING', 'ORDER', 'ASC', 'DESC', 'NULLS', 'FIRST',
      'LAST', 'LIMIT', 'OFFSET', 'FOR', 'UPDATE', 'VIEW', 'REFERENCE', 'ALL',
      'ROWS', 'USING', 'SCOPE', 'TYPEOF', 'WHEN', 'THEN', 'ELSE', 'END',
      'AND', 'OR', 'NOT', 'LIKE', 'IN', 'INCLUDES', 'EXCLUDES', 'ABOVE',
      'BELOW', 'AT', 'ABOVE_OR_BELOW', 'SECURITY_ENFORCED', 'USER_MODE',
      'SYSTEM_MODE', 'FIND', 'RETURNING', 'DIVISION', 'SNIPPET', 'NETWORK',
      'METADATA', 'TRACKING', 'VIEWSTAT', 'GROUPING'
    ].join(' ');

    const BUILT_IN = [
      'COUNT', 'COUNT_DISTINCT', 'SUM', 'AVG', 'MIN', 'MAX', 'toLabel',
      'convertCurrency', 'convertTimezone', 'FORMAT', 'DISTANCE', 'GEOLOCATION',
      'CALENDAR_MONTH', 'CALENDAR_QUARTER', 'CALENDAR_YEAR', 'DAY_IN_MONTH',
      'DAY_IN_WEEK', 'DAY_IN_YEAR', 'DAY_ONLY', 'FISCAL_MONTH',
      'FISCAL_QUARTER', 'FISCAL_YEAR', 'HOUR_IN_DAY', 'WEEK_IN_MONTH',
      'WEEK_IN_YEAR'
    ].join(' ');

    // Fixed date literals. The parameterised ones (LAST_N_DAYS:30) carry a
    // number and are matched as their own mode below.
    const LITERAL = [
      'TRUE', 'FALSE', 'NULL', 'YESTERDAY', 'TODAY', 'TOMORROW',
      'LAST_WEEK', 'THIS_WEEK', 'NEXT_WEEK',
      'LAST_MONTH', 'THIS_MONTH', 'NEXT_MONTH',
      'LAST_90_DAYS', 'NEXT_90_DAYS',
      'THIS_QUARTER', 'LAST_QUARTER', 'NEXT_QUARTER',
      'THIS_YEAR', 'LAST_YEAR', 'NEXT_YEAR',
      'THIS_FISCAL_QUARTER', 'LAST_FISCAL_QUARTER', 'NEXT_FISCAL_QUARTER',
      'THIS_FISCAL_YEAR', 'LAST_FISCAL_YEAR', 'NEXT_FISCAL_YEAR'
    ].join(' ');

    return {
      name: 'SOQL',
      aliases: ['sosl'],
      case_insensitive: true,
      disableAutodetect: true,
      keywords: { keyword: KEYWORD, built_in: BUILT_IN, literal: LITERAL },
      contains: [
        { className: 'comment', begin: '//', end: '$', contains: [{ begin: '\\\\.' }] },
        { className: 'comment', begin: '/\\*', end: '\\*/' },
        // Parameterised date literals, before the keyword pass so that the
        // LAST_N_DAYS half is not split off from its :30.
        { className: 'literal', begin: '\\b[A-Za-z_][A-Za-z0-9_]*:-?\\d+\\b' },
        // Apex bind variables: :accountId, :wrapper.field
        { className: 'variable', begin: ':[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*' },
        // The SOSL search term: FIND {Acme*}
        { className: 'string', begin: '\\{', end: '\\}' },
        { className: 'string', begin: "'", end: "'", contains: [{ begin: '\\\\.' }] },
        // Custom objects, fields and relationships all carry a __ suffix,
        // which is the clearest signal in a SOQL query of what is yours.
        { className: 'type', begin: '\\b\\w+__(?:c|r|kav|b|e|mdt|x|Share|History|Feed|Tag)\\b' },
        { className: 'number', begin: '\\b\\d+(?:\\.\\d+)?\\b' }
      ]
    };
  });

  /* ------------------------------------------------------------------
     Apex
     ------------------------------------------------------------------ */

  hljs.registerLanguage('apex', function (hl) {
    // `case` is deliberately absent: Apex switches use `switch on … when`, and
    // Case is a standard object, so treating the word as a keyword would
    // mis-colour every query against it.
    const KEYWORD = [
      'abstract', 'and', 'as', 'asc', 'assert', 'break', 'bulk', 'by', 'catch',
      'commit', 'const', 'continue', 'default', 'delete', 'desc', 'do', 'else',
      'enum', 'exit', 'export', 'extends', 'final', 'finally', 'for', 'from',
      'future', 'get', 'global', 'goto', 'group', 'having', 'hint', 'if',
      'implements', 'import', 'inherited', 'inner', 'insert', 'instanceof',
      'interface', 'into', 'join', 'like', 'limit', 'merge', 'new', 'not',
      'nulls', 'on', 'or', 'outer', 'override', 'package', 'parallel', 'private',
      'protected', 'public', 'retrieve', 'return', 'rollback', 'savepoint',
      'select', 'set', 'sharing', 'sort', 'static', 'super', 'switch',
      'synchronized', 'system', 'testmethod', 'then', 'this', 'throw', 'to',
      'transaction', 'trigger', 'try', 'undelete', 'update', 'upsert', 'using',
      'virtual', 'void', 'webservice', 'when', 'where', 'while', 'with',
      'without', 'transient'
    ].join(' ');

    const BUILT_IN = [
      'Blob', 'Boolean', 'Date', 'Datetime', 'Decimal', 'Double', 'Id', 'ID',
      'Integer', 'Long', 'Object', 'String', 'Time', 'List', 'Set', 'Map',
      'SObject', 'Database', 'Schema', 'System', 'Test', 'UserInfo', 'Limits',
      'Trigger', 'ApexPages', 'Messaging', 'JSON', 'Http', 'HttpRequest',
      'HttpResponse', 'Exception', 'DmlException', 'QueryException', 'Savepoint',
      'StaticResourceCalloutMock', 'PageReference', 'SelectOption', 'Type',
      'Version', 'Address', 'Location'
    ].join(' ');

    return {
      name: 'Apex',
      case_insensitive: true,
      disableAutodetect: true,
      keywords: { keyword: KEYWORD, built_in: BUILT_IN, literal: 'true false null' },
      contains: [
        hl.C_LINE_COMMENT_MODE,
        hl.C_BLOCK_COMMENT_MODE,
        // Annotations: @AuraEnabled(cacheable=true), @isTest, @future
        { className: 'meta', begin: '@[A-Za-z_][A-Za-z0-9_]*' },
        // Inline SOQL/SOSL. Guarded by a lookahead so ordinary indexing —
        // `rows[0]`, `String[] parts` — is left alone.
        {
          begin: '\\[(?=\\s*(?:SELECT|FIND)\\b)',
          end: '\\]',
          subLanguage: 'soql',
          relevance: 10
        },
        { className: 'string', begin: "'", end: "'", contains: [{ begin: '\\\\.' }] },
        { className: 'type', begin: '\\b\\w+__(?:c|r|kav|b|e|mdt|x|Share|History|Feed|Tag)\\b' },
        {
          className: 'class',
          beginKeywords: 'class interface enum trigger',
          end: /[{(]/,
          excludeEnd: true,
          contains: [{ beginKeywords: 'extends implements on' }, hl.UNDERSCORE_TITLE_MODE]
        },
        { className: 'number', begin: '\\b\\d+(?:\\.\\d+)?[LlDd]?\\b' }
      ]
    };
  });
})(window);
