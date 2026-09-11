import {useMemo, type MouseEvent} from 'react';
import {Marked, type Tokens} from 'marked';
import readme from '../../../../README.md?raw';
import {version} from '../../../../packages/everygrid/package.json';

/** Heading text → anchor id, the way GitHub does it, so links in the README keep working. */
function slug(text: string): string {
  return text.toLowerCase().replace(/[`*_]/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
}

const escapeHtml = (s: string) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Headings get ids for the table of contents, code blocks a language class.
const heading = ({tokens, depth, text}: Tokens.Heading, parser: {parseInline: (t: Tokens.Heading['tokens']) => string}) =>
    // The id comes from the raw heading text, the same input the table of contents slugs.
    `<h${depth} id="${slug(text)}">${parser.parseInline(tokens)}</h${depth}>\n`;
const codeBlock = ({text, lang}: Tokens.Code) => {
  const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
  return `<pre><code${cls}>${escapeHtml(text)}</code></pre>\n`;
};

const marked = new Marked({
  renderer: {
    heading(t: Tokens.Heading) { return heading(t, this.parser); },
    code: codeBlock,
  },
});

// The same, with a copy button on every code block — used for the Installation section only, the
// one whose commands are meant to be pasted. The click is handled once, on the article (see
// copyCode below), since this HTML is not React's.
const markedWithCopy = new Marked({
  renderer: {
    heading(t: Tokens.Heading) { return heading(t, this.parser); },
    code(t: Tokens.Code) {
      return `<div class="docs-code"><button type="button" class="docs-copy" aria-label="Copy code">Copy</button>${codeBlock(t)}</div>\n`;
    },
  },
});

/** Sections that get copy buttons on their code blocks. */
const COPYABLE_SECTIONS = new Set(['Installation', 'Quick Start']);

// The library's README, rendered as the portal's documentation page: a sticky table of contents
// built from its second-level headings, and the document itself.
/** The technical case for the library, above the README: what is different and why it matters. */
const HIGHLIGHTS: { title: string; body: string; tag: string }[] = [
  {
    tag: 'Rust → WASM',
    title: 'The heavy lifting is not in JavaScript',
    body: 'Filtering, sorting and paging run in a Rust engine compiled to WebAssembly, inside a Web '
        + 'Worker. A million rows sort in the worker while the page stays responsive; the main thread '
        + 'only ever renders the rows in view.',
  },
  {
    tag: 'Streaming',
    title: 'Bytes go straight to the engine',
    body: 'A URL fetcher streams the response into the worker as raw bytes — no JSON.parse on the '
        + 'main thread, no copy of the dataset on the JS heap. The 1.6M-row demo loads with a '
        + 'progress bar, not a frozen tab.',
  },
  {
    tag: 'Virtual scroll',
    title: 'Millions of rows, one scrollbar',
    body: 'Only the rows on screen exist in the DOM. Blocks are fetched from the engine on demand '
        + 'and prefetched ahead of the scroll, and results too tall for a browser scroller are '
        + 'paged through in 200,000-row segments that slide under the reader unnoticed.',
  },
  {
    tag: 'Config-driven',
    title: 'Behaviour is JSON, not code',
    body: 'Pagination, editable columns, checkboxes, colours, row actions, keys, mobile columns and '
        + 'i18n are all per-grid entries in a config file. A grid is one element with an id; the '
        + 'config decides the rest.',
  },
  {
    tag: 'Any stack',
    title: 'React, plain HTML, jQuery — one API',
    body: 'A React hook and component for bundlers; a single self-contained <script> (React, WASM, '
        + 'worker and CSS inlined) for any other page. The same Everygrid.get(id) handle works in all '
        + 'of them.',
  },
  {
    tag: 'Change tracking',
    title: 'Edits are data you can ship',
    body: 'A grid → row → cell handle: get, set, cancel, insert, delete, check. patch() gives the '
        + 'inserted rows, the updated cells by key and the deleted keys as plain JSON — save it '
        + 'however you like, then commit().',
  },
];

/** Copies the code block whose button was clicked; the button reads "Copied" for a moment. */
function copyCode(e: MouseEvent<HTMLElement>) {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.docs-copy');
  if (!btn) return;
  const code = btn.parentElement?.querySelector('code')?.textContent ?? '';
  void navigator.clipboard.writeText(code).then(() => {
    btn.textContent = 'Copied';
    btn.classList.add('is-copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('is-copied'); }, 1500);
  });
}

export default function DocsPage() {
  // The README's title and opening paragraph lead the page; the highlights sit between them and
  // the rest of the document.
  const {intro, body, toc} = useMemo(() => {
    const tokens = marked.lexer(readme);
    const firstSection = tokens.findIndex(t => t.type === 'heading' && (t as Tokens.Heading).depth === 2);
    const toc = tokens
        .filter((t): t is Tokens.Heading => t.type === 'heading' && t.depth === 2)
        .map(t => ({id: slug(t.text), text: t.text}));
    // The body is rendered section by section (each h2 and what follows it), so the copyable
    // sections can use the renderer with copy buttons.
    const sections: {heading: string; tokens: typeof tokens}[] = [];
    for (const t of tokens.slice(firstSection)) {
      if (t.type === 'heading' && (t as Tokens.Heading).depth === 2) sections.push({heading: (t as Tokens.Heading).text, tokens: [] as unknown as typeof tokens});
      sections[sections.length - 1].tokens.push(t);
    }
    return {
      intro: marked.parser(tokens.slice(0, firstSection)),
      body: sections.map(sec => (COPYABLE_SECTIONS.has(sec.heading) ? markedWithCopy : marked).parser(sec.tokens)).join(''),
      toc: [{id: 'highlights', text: 'Highlights'}, ...toc],
    };
  }, []);

  return (
      <div className='max-w-7xl mx-auto docs-page'>
        <aside className='docs-toc' aria-label='Contents'>
          {toc.map(h => <a key={h.id} href={`#docs-${h.id}`} onClick={(e) => {
            e.preventDefault();
            document.getElementById(h.id)?.scrollIntoView({behavior: 'smooth', block: 'start'});
          }}>{h.text}</a>)}
        </aside>
        <div className='docs-main'>
          <div className='docs-intro'>
            <article className='docs-body' onClick={copyCode} dangerouslySetInnerHTML={{__html: intro}}/>
            <span className='docs-version' title='@everygrid/grid'>v{version}</span>
          </div>
          <section id='highlights' className='docs-highlights'>
            <h2>Highlights</h2>
            <div className='docs-highlight-grid'>
              {HIGHLIGHTS.map(h => (
                  <div key={h.tag} className='docs-highlight'>
                    <span className='docs-highlight-tag'>{h.tag}</span>
                    <h3>{h.title}</h3>
                    <p>{h.body}</p>
                  </div>
              ))}
            </div>
            <div className='docs-pipeline'>
              <span>everygrid.config.json</span><i>→</i>
              <span>Everygrid (React UI)</span><i>→</i>
              <span>GridEngineWasm</span><i>→</i>
              <span>Web Worker</span><i>→</i>
              <span>Rust engine (WASM)</span>
            </div>
          </section>
          <article className='docs-body' onClick={copyCode} dangerouslySetInnerHTML={{__html: body}}/>
        </div>
      </div>
  );
}
