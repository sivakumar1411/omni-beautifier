/**
 * Language auto-detection.
 *
 * Structured formats (JSON, XML, SQL) are recognised by shape, which is both
 * faster and far more reliable than statistical guessing. Anything left over is
 * handed to highlight.js's own detector, then mapped back onto our language ids.
 *
 * Every result carries a confidence so the UI can say "detected JSON" versus
 * "guessed Java", and the user can always override.
 */
(function (global) {
  /** Strip strings and comments so keyword probes cannot match inside them. */
  function denoise(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      .replace(/--[^\n]*/g, ' ')
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  }

  const SQL_LEAD = /^\s*(select|insert\s+into|update|delete\s+from|create\s+(table|database|index|view|procedure|function|trigger)|alter\s+table|drop\s+(table|database|index|view)|truncate|with\s+[\w`"]+\s+as|explain|describe|show\s+(tables|databases|columns)|use\s+[\w`]+|grant|replace\s+into)\b/i;
  const SQL_BODY = /\b(from|where|join|group\s+by|order\s+by|having|limit|values|set|inner\s+join|left\s+join|on\s+duplicate\s+key)\b/i;

  function looksLikeJson(t) {
    const s = t.trim();
    if (!/^[[{]/.test(s) || !/[\]}]$/.test(s)) return false;
    try { JSON.parse(s); return true; } catch (_) { /* maybe JSONC/JSON5 */ }
    try {
      JSON.parse(s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
      return true;
    } catch (_) { return false; }
  }

  function looksLikeXmlOrHtml(t) {
    const s = t.trim();
    if (!/^</.test(s)) return false;
    if (/^<\?xml[\s?]/i.test(s)) return 'xml';
    if (/^<!doctype\s+html/i.test(s)) return 'html';
    if (!/<[a-zA-Z!/?]/.test(s)) return false;
    // Tags unique to HTML settle it; otherwise treat generic markup as XML.
    if (/<(html|head|body|div|span|p|a|img|table|script|style|meta|link|ul|li|h[1-6])\b/i.test(s)) return 'html';
    return 'xml';
  }

  /** highlight.js language name -> our id. */
  const HLJS_MAP = {
    json: 'json', xml: 'xml', sql: 'sql', javascript: 'javascript', typescript: 'typescript',
    css: 'css', scss: 'scss', less: 'less', yaml: 'yaml', markdown: 'markdown', graphql: 'graphql',
    java: 'java', c: 'c', cpp: 'cpp', csharp: 'csharp', kotlin: 'kotlin', go: 'go', rust: 'rust',
    php: 'php', swift: 'swift', scala: 'scala', dart: 'dart', python: 'python', ruby: 'ruby',
    bash: 'bash', shell: 'bash', ini: 'ini', toml: 'ini', diff: 'diff', plaintext: 'plaintext'
  };

  /* ------------------------------------------------------------------
     Salesforce

     Each of these has to be consulted *before* the general rule that would
     otherwise claim the text first: an LWC template is markup and would be
     read as HTML, a SOQL query starts with SELECT and would be read as SQL,
     and an Apex class is full of access modifiers and would be read as Java.
     ------------------------------------------------------------------ */

  /** LWC templates, Visualforce pages and Aura components. Runs on raw text. */
  function salesforceMarkup(t) {
    const head = t.trim();
    if (/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<apex:page\b/i.test(head) || /<apex:[a-z]/i.test(t)) {
      return { id: 'visualforce', confidence: 'certain', why: 'Visualforce <apex:> tags' };
    }
    if (/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<aura:component\b/i.test(head) || /<aura:[a-z]/i.test(t)) {
      return { id: 'visualforce', confidence: 'certain', why: 'Aura <aura:> tags' };
    }
    // A bare <template> is also valid HTML, so an LWC signal is required:
    // a directive, a Salesforce component tag, or an unquoted {binding}.
    if (/^(<!--[\s\S]*?-->\s*)*<template[\s>]/i.test(head)) {
      if (/\b(lwc:(if|elseif|else|for-each|item|index|ref|spread|external|dom)|for:(each|item|index)|if:(true|false)|iterator:\w+|key)\s*=/i.test(t)
        || /<(lightning|lightning-[a-z-]+|c)-[a-z]/i.test(t)
        || /\s[\w:.-]+=\{[^}]*\}/.test(t)) {
        return { id: 'lwchtml', confidence: 'certain', why: 'LWC template directives or bindings' };
      }
    }
    return null;
  }

  /**
   * SOQL and SOSL. Deliberately conservative: ordinary SQL must not be
   * hijacked, so a bind variable on its own is only a hint, while the
   * constructs that exist nowhere but Salesforce are conclusive.
   */
  function salesforceQuery(clean) {
    if (/^\s*FIND\s*\{/i.test(clean)) {
      return { id: 'soql', confidence: 'certain', why: 'SOSL FIND clause' };
    }
    if (!/^\s*SELECT\b/i.test(clean.trim()) || !/\bFROM\b/i.test(clean)) return null;

    // Custom objects, fields and relationships all end in __c / __r / __mdt …
    if (/\b\w+__(c|r|kav|b|e|mdt|x|Share|History|Feed|Tag)\b/i.test(clean)) {
      return { id: 'soql', confidence: 'certain', why: 'Salesforce custom object or field (__c)' };
    }
    if (/\bWITH\s+(SECURITY_ENFORCED|USER_MODE|SYSTEM_MODE|DATA\s+CATEGORY)\b/i.test(clean)) {
      return { id: 'soql', confidence: 'certain', why: 'SOQL WITH clause' };
    }
    if (/\bUSING\s+SCOPE\b/i.test(clean)) return { id: 'soql', confidence: 'certain', why: 'SOQL USING SCOPE' };
    if (/\bTYPEOF\b[\s\S]*\bEND\b/i.test(clean)) return { id: 'soql', confidence: 'certain', why: 'SOQL TYPEOF' };
    if (/\b(LAST|NEXT)_N_(DAYS|WEEKS|MONTHS|QUARTERS|YEARS|FISCAL_QUARTERS|FISCAL_YEARS):-?\d+/i.test(clean)) {
      return { id: 'soql', confidence: 'certain', why: 'SOQL date literal' };
    }
    if (/\btoLabel\s*\(/i.test(clean)) return { id: 'soql', confidence: 'certain', why: 'SOQL toLabel()' };
    if (/\bALL\s+ROWS\s*$/i.test(clean.trim())) return { id: 'soql', confidence: 'certain', why: 'SOQL ALL ROWS' };

    // Bind variables are the weak signal: plenty of SQL tooling uses :named
    // parameters too. Only claim it when nothing looks like real SQL.
    const hasBind = /(=|\bIN|\bLIKE|,)\s*:[A-Za-z_]\w*/i.test(clean);
    const looksSql = /\bSELECT\s+\*|\bJOIN\b|\bUNION\b|`|\bINSERT\b|\bDELETE\b|;\s*$/i.test(clean.trim());
    if (hasBind && !looksSql) {
      return { id: 'soql', confidence: 'likely', why: 'SELECT with Apex bind variables' };
    }
    return null;
  }

  /** Apex classes and triggers, and LWC JavaScript modules. */
  function salesforceCode(t, clean) {
    // LWC first: its module imports are unambiguous.
    if (/\bfrom\s*['"]lwc['"]/.test(t) || /\bfrom\s*['"]@salesforce\//.test(t)) {
      return { id: 'lwcjs', confidence: 'certain', why: "imports from 'lwc' or @salesforce" };
    }
    if (/\bextends\s+LightningElement\b/.test(clean)) {
      return { id: 'lwcjs', confidence: 'certain', why: 'extends LightningElement' };
    }
    if (/@(api|track|wire)\b/.test(clean) && /\bexport\s+default\s+class\b/.test(clean)) {
      return { id: 'lwcjs', confidence: 'likely', why: 'LWC decorators on an exported class' };
    }

    if (/\b(with|without|inherited)\s+sharing\b/i.test(clean)) {
      return { id: 'apex', confidence: 'certain', why: 'Apex sharing declaration' };
    }
    if (/^\s*trigger\s+\w+\s+on\s+\w+\s*\(/im.test(clean)) {
      return { id: 'apex', confidence: 'certain', why: 'Apex trigger declaration' };
    }
    if (/@(AuraEnabled|isTest|TestSetup|TestVisible|InvocableMethod|InvocableVariable|RestResource|HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete|future|NamespaceAccessible|JsonAccess|ReadOnly)\b/i.test(clean)) {
      return { id: 'apex', confidence: 'certain', why: 'Apex annotation' };
    }
    if (/\bSystem\.debug\s*\(/i.test(clean)) {
      return { id: 'apex', confidence: 'certain', why: 'System.debug call' };
    }
    if (/\[\s*(SELECT|FIND)\b[\s\S]*?\]/i.test(clean)) {
      return { id: 'apex', confidence: 'certain', why: 'inline SOQL in square brackets' };
    }
    if (/\bTrigger\.(new|old|newMap|oldMap|is(Insert|Update|Delete|Undelete|Before|After))\b/i.test(clean)) {
      return { id: 'apex', confidence: 'certain', why: 'Trigger context variables' };
    }
    if (/\b(Database|Schema|UserInfo|ApexPages|Limits)\.\w+/.test(clean)
      && /\b(public|private|global)\s/.test(clean)) {
      return { id: 'apex', confidence: 'likely', why: 'Apex system classes' };
    }
    if (/\bglobal\s+(class|interface|abstract|virtual|static)\b/i.test(clean)
      || /\btestMethod\b/i.test(clean)) {
      return { id: 'apex', confidence: 'likely', why: 'Apex-only modifiers' };
    }
    return null;
  }

  /**
   * @returns {{id: string, confidence: 'certain'|'likely'|'guess', why: string}}
   */
  function detect(text) {
    const t = String(text || '');
    if (!t.trim()) return { id: 'plaintext', confidence: 'guess', why: 'empty input' };

    if (looksLikeJson(t)) return { id: 'json', confidence: 'certain', why: 'parses as JSON' };

    // JSON that does not parse is still JSON as far as the user is concerned —
    // recognising it by shape is what lets the formatter report *where* it is
    // broken instead of the detector wandering off to another language.
    const trimmed = t.trim();
    if (/^[[{]/.test(trimmed) && /"[^"\n]*"\s*:/.test(trimmed)) {
      return { id: 'json', confidence: 'likely', why: 'JSON shape, but it does not parse' };
    }

    if (/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(t)) {
      return { id: 'svg', confidence: 'certain', why: 'root <svg> element' };
    }

    // Salesforce markup, before the generic markup check: an LWC template or a
    // Visualforce page would otherwise be claimed as HTML.
    const sfMarkup = salesforceMarkup(t);
    if (sfMarkup) return sfMarkup;

    const markup = looksLikeXmlOrHtml(t);
    if (markup) return { id: markup, confidence: 'certain', why: markup === 'html' ? 'HTML tags found' : 'XML markup' };

    const clean = denoise(t);

    // SOQL before SQL: every SOQL query also matches SQL_LEAD.
    const sfQuery = salesforceQuery(clean);
    if (sfQuery) return sfQuery;

    if (SQL_LEAD.test(clean) && SQL_BODY.test(clean)) {
      return { id: 'sql', confidence: 'certain', why: 'SQL statement and clauses' };
    }
    if (SQL_LEAD.test(clean)) return { id: 'sql', confidence: 'likely', why: 'starts with a SQL statement' };

    // Apex and LWC JavaScript before the brace families: an Apex class is a
    // wall of access modifiers and reads as Java, and a trigger reads as C#.
    const sfCode = salesforceCode(t, clean);
    if (sfCode) return sfCode;

    // A few high-signal shapes highlight.js tends to confuse with each other.
    if (/^\s*(package|import)\s+[\w.]+;\s*$/m.test(clean) && /\b(public|private|protected)\s+(static\s+)?(final\s+)?(class|interface|enum|void|[\w<>[\]]+)\s/.test(clean)) {
      return { id: 'java', confidence: 'likely', why: 'Java package/class declarations' };
    }
    if (/^\s*(func\s+\w+|package\s+\w+\s*$)/m.test(clean) && /\b(:=|func\s|import\s+\()/.test(clean)) {
      return { id: 'go', confidence: 'likely', why: 'Go declarations' };
    }
    if (/\b(interface|type)\s+\w+\s*[={]/.test(clean) && /:\s*(string|number|boolean|any|unknown)\b/.test(clean)) {
      return { id: 'typescript', confidence: 'likely', why: 'TypeScript type annotations' };
    }
    if (/^\s*(---|\w[\w -]*:\s)/m.test(t) && !/[{};]/.test(clean.replace(/\s/g, '').slice(0, 40))) {
      if (/^\s*\w[\w -]*:\s*\S/m.test(t)) return { id: 'yaml', confidence: 'likely', why: 'key: value lines' };
    }

    // Markdown, before anything statistical. highlight.js reads `# Title` as a
    // CSS/Less id selector and confidently mislabels whole documents, so the
    // structural markers are checked directly.
    const md = markdownSignals(t);
    if (md.score >= 3) return { id: 'markdown', confidence: 'certain', why: md.why };
    if (md.score === 2) return { id: 'markdown', confidence: 'likely', why: md.why };
    // A plain document of headings and prose only trips one signal, but it is
    // still the commonest thing anyone pastes. Accept it when it is laid out
    // like prose — heading, blank line, text — and shows no sign of being code.
    if (md.score === 1 && md.headingLed) {
      return { id: 'markdown', confidence: 'guess', why: 'headings followed by prose' };
    }

    // Delimited data: every line carrying the same number of separators is a
    // far stronger signal than anything the statistical detector would find.
    const csv = looksDelimited(t);
    if (csv) return { id: 'csv', confidence: csv.confidence, why: csv.why };

    // Brace-language families. highlight.js reads a bare `public class A { … }`
    // as CSS (selector + block), which then fails in the CSS formatter, so
    // these get settled before the statistical detector is consulted.
    if (/\{[\s\S]*\}/.test(clean)) {
      if (/\bSystem\.out\.print|\bpublic\s+static\s+void\s+main\s*\(\s*String/.test(clean)) {
        return { id: 'java', confidence: 'certain', why: 'Java entry point or System.out' };
      }
      if (/\busing\s+System\b|\bConsole\.(Write|Read)|\bnamespace\s+[\w.]+\s*\{/.test(clean)) {
        return { id: 'csharp', confidence: 'certain', why: 'C# namespace or Console call' };
      }
      if (/#include\b|\bstd::/.test(clean)) {
        return { id: 'cpp', confidence: 'likely', why: 'C/C++ includes or std::' };
      }
      if (/<\?php|\$\w+\s*=/.test(clean)) {
        return { id: 'php', confidence: 'likely', why: 'PHP tags or $variables' };
      }
      if (/\bfun\s+\w+\s*\(|\bval\s+\w+\s*[:=]/.test(clean)) {
        return { id: 'kotlin', confidence: 'likely', why: 'Kotlin fun/val' };
      }
      if (/\bfn\s+\w+\s*\(|\blet\s+mut\b/.test(clean)) {
        return { id: 'rust', confidence: 'likely', why: 'Rust fn/let mut' };
      }
      if (/\b(public|private|protected)\s+(static\s+)?(final\s+)?(abstract\s+)?(class|interface|enum|void|[\w<>\[\]]+\s+\w+\s*\()/.test(clean)) {
        return { id: 'java', confidence: 'likely', why: 'access-modified declarations' };
      }
    }

    // Fall back to highlight.js's own detector.
    if (global.hljs && typeof global.hljs.highlightAuto === 'function') {
      try {
        const res = global.hljs.highlightAuto(t.slice(0, 20000));
        const id = HLJS_MAP[res.language];
        if (id) {
          return {
            id,
            confidence: res.relevance >= 10 ? 'likely' : 'guess',
            why: 'highlight.js detection (relevance ' + res.relevance + ')'
          };
        }
      } catch (_) { /* detector unavailable */ }
    }

    return { id: 'plaintext', confidence: 'guess', why: 'no clear match' };
  }


  /**
   * Recognise CSV/TSV by shape: several lines that all split into the same
   * number of fields on the same separator.
   */
  function looksDelimited(text) {
    const lines = String(text).split('\n').filter((l) => l.trim());
    if (lines.length < 2) return null;
    // Markup, braces and SQL are handled elsewhere and must not be stolen.
    if (/^[\s]*[<{[]/.test(text) || /[{};]/.test(text.slice(0, 200))) return null;

    const candidates = [',', '\t', ';', '|'];
    let best = null;
    candidates.forEach((sep) => {
      const counts = lines.slice(0, 40).map((l) => {
        let n = 0;
        let quoted = false;
        for (const c of l) {
          if (c === '"') { quoted = !quoted; continue; }
          if (!quoted && c === sep) n++;
        }
        return n;
      });
      if (counts[0] < 1) return;
      const consistent = counts.every((c) => c === counts[0]);
      if (!consistent) return;
      if (!best || counts[0] > best.fields) best = { sep, fields: counts[0] };
    });
    if (!best) return null;

    // Two columns is the danger zone: ordinary prose has one comma per line
    // too. Only accept it when the fields look like data rather than sentences.
    if (best.fields < 2) {
      if (lines.length < 4) return null;
      const fieldsLookLikeData = lines.slice(0, 20).every((l) =>
        l.split(best.sep).every((f) => {
          const v = f.trim();
          return v.length <= 25 && !/\s{2,}/.test(v) && !/[.!?]$/.test(v);
        }));
      if (!fieldsLookLikeData) return null;
    }

    return {
      confidence: best.fields >= 2 ? 'likely' : 'guess',
      why: (best.sep === '\t' ? 'tab' : best.sep) + '-separated columns on every line'
    };
  }


  /**
   * Count the independent Markdown constructs present. One alone is weak — a
   * shell script is full of `# comment` lines — but two or more together are
   * decisive.
   */
  function markdownSignals(text) {
    const found = [];
    const has = (name, re) => { if (re.test(text)) found.push(name); };

    has('heading', /^#{1,6} +\S/m);
    has('fenced code', /^(```|~~~)/m);
    has('list', /^[ \t]*([-*+] +\S|\d+\. +\S)/m);
    has('link', /\[[^\]\n]+\]\([^)\n]*\)/);
    has('image', /!\[[^\]\n]*\]\([^)\n]*\)/);
    has('bold', /\*\*[^*\n]+\*\*/);
    has('blockquote', /^> +\S/m);
    has('rule', /^([-*_])\1{2,}\s*$/m);
    if (/^\|.*\|\s*$/m.test(text) && /^\|[\s:|-]+\|\s*$/m.test(text)) found.push('table');

    // A heading, a blank line, then prose — and nothing that looks like code.
    const headingLed = /^#{1,6} +\S.*\n[ \t]*\n[ \t]*\S/m.test(text) &&
      !/^#!/.test(text) &&
      !/[{};]/.test(text);

    return { score: found.length, headingLed, why: 'Markdown ' + found.slice(0, 3).join(', ') };
  }

  global.Detect = { detect, looksLikeJson, looksLikeXmlOrHtml, looksDelimited, markdownSignals };
})(window);
