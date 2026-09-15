/**
 * Shared chrome for the server-rendered pages (/evals, /runs).
 *
 * The main UI is a single-page app with its own stylesheet; these two are
 * standalone documents. Without a shared shell they drift apart in spacing,
 * colour and navigation, and stop reading as one product. Keeping the brand
 * row, section nav and token palette here means a change lands in both.
 */

export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SECTIONS = [
  { href: '/', label: 'Ask' },
  { href: '/runs', label: 'Runs' },
  { href: '/evals', label: 'Evals' },
];

const BASE_CSS = `
  :root { --bg:#0c0d10; --raised:#14161b; --border:#262a33; --text:#e7e9ee; --dim:#9aa1ae; --faint:#6b7280;
          --ok:#5eead4; --bad:#f87171; --warn:#fbbf24; --mono: ui-monospace,"SF Mono",Menlo,monospace; }
  @media (prefers-color-scheme: light) {
    :root { --bg:#fbfbfa; --raised:#fff; --border:#e3e5e9; --text:#16181d; --dim:#5b6270; --faint:#8a909c;
            --ok:#0f766e; --bad:#b91c1c; --warn:#a16207; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px 20px 64px; background:var(--bg); color:var(--text);
         font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  main { max-width: 940px; margin: 0 auto; }
  a { color: inherit; }
  .dim { color:var(--dim); font-weight:400; }
  .faint { color:var(--faint); }
  .mono { font-family:var(--mono); }

  .brand-row { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:6px; }
  .brand { font-size:17px; font-weight:650; letter-spacing:.04em; }
  .brand .mark { color:var(--ok); margin-right:6px; }
  .app-nav { display:flex; gap:2px; }
  .app-nav a { font-size:12.5px; padding:4px 10px; border-radius:20px; color:var(--dim); text-decoration:none; }
  .app-nav a:hover { color:var(--text); background:var(--raised); }
  .app-nav a.active { color:var(--text); background:var(--raised); font-weight:550; }
  .app-nav a:focus-visible { outline:2px solid var(--ok); outline-offset:1px; }
  .lede { margin:0 0 18px; }

  .card { background:var(--raised); border:1px solid var(--border); border-radius:12px; padding:18px; margin-bottom:14px; }
  h2 { font-size:15px; margin:0 0 14px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  h3 { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--faint); margin:0 0 8px; font-weight:600; }
  h3 .dim { text-transform:none; letter-spacing:0; }
  .badge, .chip { font-family:var(--mono); font-size:10.5px; padding:2px 7px; border:1px solid var(--border);
                  border-radius:20px; color:var(--dim); }
  .badge { text-transform:uppercase; letter-spacing:.04em; }
  pre { background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:10px 12px;
        font-family:var(--mono); font-size:12.5px; overflow-x:auto; }
  code { font-family:var(--mono); font-size:12.5px; }
`;

/**
 * @param {object} opts
 * @param {string} opts.title document title
 * @param {string} opts.active href of the current section, for the nav state
 * @param {string} opts.lede one line under the brand row
 * @param {string} opts.body page content
 * @param {string} [opts.css] page-specific styles
 * @param {string} [opts.script] page-specific script, injected at the end of body
 */
export function shell({ title, active, lede, body, css = '', script = '' }) {
  const nav = SECTIONS.map(
    (s) =>
      `<a href="${s.href}"${s.href === active ? ' class="active" aria-current="page"' : ''}>${esc(s.label)}</a>`,
  ).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>◈</text></svg>" />
<style>${BASE_CSS}${css}</style></head><body><main>
<div class="brand-row">
  <div class="brand"><span class="mark">◈</span> LUMINA</div>
  <nav class="app-nav" aria-label="Sections">${nav}</nav>
</div>
${lede ? `<p class="dim lede">${lede}</p>` : ''}
${body}
</main>${script ? `<script type="module">${script}</script>` : ''}</body></html>`;
}
