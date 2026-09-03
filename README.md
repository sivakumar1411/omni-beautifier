# Beautifier

A Chrome extension that formats and highlights anything you paste. Two panes:
paste on the left, get it formatted and colour-highlighted on the right. It
detects the language itself — 36 of them, including Apex, SOQL/SOSL, LWC and
Visualforce — and you can override the guess any time.

---

## 1. Install it in Chrome

The extension is not on the Chrome Web Store, so it loads unpacked. Takes a
minute.

1. **Download the code.** On the repository page, click **Code → Download ZIP**,
   then unzip it. Keep the folder somewhere permanent — Chrome reads the
   extension from this folder every time it starts, so don't delete or move it
   afterwards.

2. **Open the extensions page:** **[chrome://extensions](chrome://extensions)**

   > Chrome blocks pages from linking to `chrome://` URLs, so that link won't
   > open on click. Paste `chrome://extensions` into the address bar instead, or
   > use the menu: **⋮ → Extensions → Manage Extensions**.

3. **Turn on Developer mode** — the toggle in the **top-right** corner of that
   page. Three new buttons appear.

4. **Click "Load unpacked"** (top-left) and select the **`extension_beautifier`**
   folder — the one containing `manifest.json`. Not the parent folder, not the
   zip.

5. **Pin it** so it's one click away: click the **puzzle-piece icon** in the
   toolbar, find *Beautifier*, and click the **pin**.

Done. Click the toolbar icon to open it.

**To update later:** download the new ZIP, replace the folder contents, then
click the **↻ reload** icon on the extension's card in `chrome://extensions`.

---

## 2. The keyboard shortcut

A shortcut is set up for you on install — no configuration needed:

| Platform | Shortcut |
| --- | --- |
| macOS | **`Option + B`** (the `⌥` key) |
| Windows / Linux | **`Alt + B`** |

Press it anywhere in Chrome and the Beautifier page opens in a tab right next to
the one you're on. Press it again and it re-focuses that same tab instead of
piling up duplicates.

### Changing it

1. Open **[chrome://extensions/shortcuts](chrome://extensions/shortcuts)**
   (paste it into the address bar — or from `chrome://extensions`, open the
   **☰ menu** on the left and choose **Keyboard shortcuts**).

2. Find **Beautifier** and the row *"Open Beautifier next to the current tab"*.

3. Click the **pencil / input box** on that row and **press the combination** you
   want instead.

4. Optional: switch the dropdown on the right from **In Chrome** to **Global** if
   you want it to work even when Chrome isn't the focused app.

Notes:

- A shortcut has to include `Ctrl`, `Alt`/`Option` or `⌘` — `Shift` alone won't
  be accepted.
- Chrome reserves some combinations (`Ctrl+T`, `Ctrl+N`, `Ctrl+W`, …). If
  nothing gets recorded, that combo is taken — pick another.
- If `Option/Alt + B` is already claimed by another extension, Chrome leaves the
  row blank rather than stealing it; set your own from the page above.
- Had an earlier version installed? Chrome keeps whatever binding you already
  had, so remove and re-add the extension, or just set the shortcut manually.

## 3. Other ways to open it

- **Toolbar icon** — click it.
- **Right-click selected text** on any page → **Beautify selected text**. The
  selection comes across and is formatted on arrival.

### Shortcuts inside the page

| Keys | Action |
| --- | --- |
| `Ctrl`/`⌘ + Enter` | Format now |
| `Ctrl`/`⌘ + Shift + C` | Copy the result |
| `Tab` | Insert an indent in the source pane |

---

## What it does

**Auto-detects the language** by structure rather than statistics, and always
shows what it picked with a confidence colour — green (certain), blue (likely),
amber (a guess). Wrong guess? Override it from the **Language** menu.

**Formats 36 languages.** Full reformatting for JSON, SQL, SOQL, XML, CSV and
INI/TOML; Prettier for JS/TS, CSS/SCSS/Less, HTML, Markdown, YAML and GraphQL; a
brace re-indenter for Java, Apex, C/C++, C#, Kotlin, Go, Rust, PHP, Swift, Scala
and Dart; whitespace-only tidying for Python, Ruby and Shell, whose indentation
carries meaning.

**Renders as well as formats.** JSON, YAML and XML get a collapsible tree, CSV a
sortable table, Markdown and HTML a preview, SVG an image, diffs a coloured
diff. Switch between **Preview** and **Beautify** in the output pane.

**Reports what's broken.** Invalid JSON gets a line, a column and a *Go to line*
button. XML is checked with the browser's own parser. A query that won't parse is
still laid out on a best-effort basis, with a note explaining why.

**Colours nested sub-queries** in SQL and SOQL by depth, so an
`UPDATE … INNER JOIN (SELECT …)` reads as two separate queries rather than one
wall of red. Grouping parentheses get matched rainbow colours of their own. The
**Nesting** control switches this between colours, colours + zones, and off.

**Click a bracket to select its block.** Click the `(` that opens a sub-query and
the whole sub-query is selected; a Java method's `{` gives you the body; a JSON
`[` gives you the array, ready to copy as valid JSON on its own. Alt-click
selects the contents without the brackets. In XML, SVG, HTML, LWC and
Visualforce, clicking a **tag name** selects the whole element.

**Salesforce.** Apex classes and triggers, SOQL and SOSL, LWC templates and
modules, Visualforce pages and Aura components each detect, format and highlight
on their own terms — including the query inside
`[SELECT Id FROM Account WHERE Tier__c = :tier]`, which is highlighted as a
query in the middle of the method and selectable by clicking its `[`.

**Minify** JSON, SQL, SOQL, XML, SVG, HTML, LWC, Visualforce, CSS, SCSS and Less
back down to one line.

**Light, dark or follow-system**, with your language, indent, dialect, nesting
and theme choices remembered between sessions.

---

## Privacy

Everything runs locally in the extension page. There is no network code, no
analytics and no telemetry — nothing you paste leaves your machine. The only
permissions requested are `storage` (to remember your settings and to hand a
right-click selection to the page) and `contextMenus`.

---

## Project layout

```
manifest.json           MV3 manifest
background.js           Opens the page; the right-click menu entry
beautify.html           The two-pane page
js/languages.js         Language table: engine, parser, highlight grammar
js/detect.js            Auto-detection
js/formatters.js        JSON, SQL, SOQL, XML, Prettier, brace re-indenter
js/renderers.js         Tree, table, preview and diff views
js/hljs-salesforce.js   highlight.js grammars for Apex and SOQL/SOSL
js/sql-nesting.js       Sub-query depth colouring
js/brackets.js          Bracket and tag matching, click-to-select
js/app.js               Panes, splitter, theming, wiring
css/                    Chrome, panes and syntax colours
lib/                    highlight.js, sql-formatter, Prettier + plugins
```
