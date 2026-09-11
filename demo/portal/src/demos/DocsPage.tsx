import {useMemo} from 'react';
import {Marked, type Tokens} from 'marked';
import readme from '../../../../README.md?raw';

/** Heading text → anchor id, the way GitHub does it, so links in the README keep working. */
function slug(text: string): string {
  return text.toLowerCase().replace(/[`*_]/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
}

const escapeHtml = (s: string) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// One parser, built once: headings get ids for the table of contents, code blocks a language class.
const marked = new Marked({
  renderer: {
    heading({tokens, depth, text}: Tokens.Heading) {
      // The id comes from the raw heading text, the same input the table of contents slugs.
      return `<h${depth} id="${slug(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
    code({text, lang}: Tokens.Code) {
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      return `<pre><code${cls}>${escapeHtml(text)}</code></pre>\n`;
    },
  },
});

// The library's README, rendered as the portal's documentation page: a sticky table of contents
// built from its second-level headings, and the document itself.
export default function DocsPage() {
  const {html, toc} = useMemo(() => {
    const toc = marked.lexer(readme)
        .filter((t): t is Tokens.Heading => t.type === 'heading' && t.depth === 2)
        .map(t => ({id: slug(t.text), text: t.text}));
    return {html: marked.parse(readme) as string, toc};
  }, []);

  return (
      <div className='max-w-7xl mx-auto docs-page'>
        <aside className='docs-toc' aria-label='Contents'>
          {toc.map(h => <a key={h.id} href={`#docs-${h.id}`} onClick={(e) => {
            e.preventDefault();
            document.getElementById(h.id)?.scrollIntoView({behavior: 'smooth', block: 'start'});
          }}>{h.text}</a>)}
        </aside>
        <article className='docs-body' dangerouslySetInnerHTML={{__html: html}}/>
      </div>
  );
}
