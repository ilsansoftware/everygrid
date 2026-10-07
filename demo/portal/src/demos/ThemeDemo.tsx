import {useEffect, useState, type MouseEvent} from 'react';
import {Everygrid, EverygridLocaleSwitch, useGrid} from '@everygrid/grid';
import {LUCIDE_ICONS} from './lucideIcons';

// Theming demo — the grid restyled through its CSS tokens alone: an accent scale, corner radius,
// font, a header look, icons (through Everygrid.setIcons), and light / dark / auto mode. The CSS below the grid is exactly what a page would ship for
// the current choices; this tab injects that same text, so what you see is what you would get.

type Mode = 'light' | 'dark' | 'auto';
type Font = 'system' | 'serif' | 'mono';
type Header = 'default' | 'strong' | 'accent' | 'minimal';
type Icons = 'default' | 'lucide';

const STEPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'];

// Accent scales (Tailwind's palette). Dark mode needs its own values: tints become shades, so the
// light 50 background is the dark 950 one, and solid steps stay solid.
const ACCENTS = {
  indigo: {
    label: 'Indigo',
    light: ['oklch(96.2% 0.018 272.314)', 'oklch(93% 0.034 272.788)', 'oklch(87% 0.065 274.039)', 'oklch(78.5% 0.115 274.713)', 'oklch(67.3% 0.182 276.935)', 'oklch(58.5% 0.233 277.117)', 'oklch(51.1% 0.262 276.966)', 'oklch(45.7% 0.24 277.023)', 'oklch(39.8% 0.195 277.366)', 'oklch(35.9% 0.144 278.697)'],
    dark: ['oklch(25.7% 0.09 281.288)', 'oklch(35.9% 0.144 278.697)', 'oklch(39.8% 0.195 277.366)', 'oklch(45.7% 0.24 277.023)', 'oklch(51.1% 0.262 276.966)', 'oklch(58.5% 0.233 277.117)', 'oklch(58.5% 0.233 277.117)', 'oklch(67.3% 0.182 276.935)', 'oklch(78.5% 0.115 274.713)', 'oklch(87% 0.065 274.039)'],
  },
  rose: {
    label: 'Rose',
    light: ['oklch(96.9% 0.015 12.422)', 'oklch(94.1% 0.03 12.58)', 'oklch(89.2% 0.058 10.001)', 'oklch(81% 0.117 11.638)', 'oklch(71.2% 0.194 13.428)', 'oklch(64.5% 0.246 16.439)', 'oklch(58.6% 0.253 17.585)', 'oklch(51.4% 0.222 16.935)', 'oklch(45.5% 0.188 13.697)', 'oklch(41% 0.159 10.272)'],
    dark: ['oklch(27.1% 0.105 12.094)', 'oklch(41% 0.159 10.272)', 'oklch(45.5% 0.188 13.697)', 'oklch(51.4% 0.222 16.935)', 'oklch(58.6% 0.253 17.585)', 'oklch(64.5% 0.246 16.439)', 'oklch(64.5% 0.246 16.439)', 'oklch(71.2% 0.194 13.428)', 'oklch(81% 0.117 11.638)', 'oklch(89.2% 0.058 10.001)'],
  },
  emerald: {
    label: 'Emerald',
    light: ['oklch(97.9% 0.021 166.113)', 'oklch(95% 0.052 163.051)', 'oklch(90.5% 0.093 164.15)', 'oklch(84.5% 0.143 164.978)', 'oklch(76.5% 0.177 163.223)', 'oklch(69.6% 0.17 162.48)', 'oklch(59.6% 0.145 163.225)', 'oklch(50.8% 0.118 165.612)', 'oklch(43.2% 0.095 166.913)', 'oklch(37.8% 0.077 168.94)'],
    dark: ['oklch(26.2% 0.051 172.552)', 'oklch(37.8% 0.077 168.94)', 'oklch(43.2% 0.095 166.913)', 'oklch(50.8% 0.118 165.612)', 'oklch(59.6% 0.145 163.225)', 'oklch(69.6% 0.17 162.48)', 'oklch(69.6% 0.17 162.48)', 'oklch(76.5% 0.177 163.223)', 'oklch(84.5% 0.143 164.978)', 'oklch(90.5% 0.093 164.15)'],
  },
  amber: {
    label: 'Amber',
    light: ['oklch(98.7% 0.022 95.277)', 'oklch(96.2% 0.059 95.617)', 'oklch(92.4% 0.12 95.746)', 'oklch(87.9% 0.169 91.605)', 'oklch(82.8% 0.189 84.429)', 'oklch(76.9% 0.188 70.08)', 'oklch(66.6% 0.179 58.318)', 'oklch(55.5% 0.163 48.998)', 'oklch(47.3% 0.137 46.201)', 'oklch(41.4% 0.112 45.904)'],
    dark: ['oklch(27.9% 0.077 45.635)', 'oklch(41.4% 0.112 45.904)', 'oklch(47.3% 0.137 46.201)', 'oklch(55.5% 0.163 48.998)', 'oklch(66.6% 0.179 58.318)', 'oklch(76.9% 0.188 70.08)', 'oklch(76.9% 0.188 70.08)', 'oklch(82.8% 0.189 84.429)', 'oklch(87.9% 0.169 91.605)', 'oklch(92.4% 0.12 95.746)'],
  },
  sky: {
    label: 'Sky',
    light: ['oklch(97.7% 0.013 236.62)', 'oklch(95.1% 0.026 236.824)', 'oklch(90.1% 0.058 230.902)', 'oklch(82.8% 0.111 230.318)', 'oklch(74.6% 0.16 232.661)', 'oklch(68.5% 0.169 237.323)', 'oklch(58.8% 0.158 241.966)', 'oklch(50% 0.134 242.749)', 'oklch(44.3% 0.11 240.79)', 'oklch(39.1% 0.09 240.876)'],
    dark: ['oklch(29.3% 0.066 243.157)', 'oklch(39.1% 0.09 240.876)', 'oklch(44.3% 0.11 240.79)', 'oklch(50% 0.134 242.749)', 'oklch(58.8% 0.158 241.966)', 'oklch(68.5% 0.169 237.323)', 'oklch(68.5% 0.169 237.323)', 'oklch(74.6% 0.16 232.661)', 'oklch(82.8% 0.111 230.318)', 'oklch(90.1% 0.058 230.902)'],
  },
  violet: {
    label: 'Violet',
    light: ['oklch(96.9% 0.016 293.756)', 'oklch(94.3% 0.029 294.588)', 'oklch(89.4% 0.057 293.283)', 'oklch(81.1% 0.111 293.571)', 'oklch(70.2% 0.183 293.541)', 'oklch(60.6% 0.25 292.717)', 'oklch(54.1% 0.281 293.009)', 'oklch(49.1% 0.27 292.581)', 'oklch(43.2% 0.232 292.759)', 'oklch(38% 0.189 293.745)'],
    dark: ['oklch(28.3% 0.141 291.089)', 'oklch(38% 0.189 293.745)', 'oklch(43.2% 0.232 292.759)', 'oklch(49.1% 0.27 292.581)', 'oklch(54.1% 0.281 293.009)', 'oklch(60.6% 0.25 292.717)', 'oklch(60.6% 0.25 292.717)', 'oklch(70.2% 0.183 293.541)', 'oklch(81.1% 0.111 293.571)', 'oklch(89.4% 0.057 293.283)'],
  },
};
type Accent = keyof typeof ACCENTS;

const FONTS: Record<Font, {label: string; value: string | null}> = {
  system: {label: 'System', value: null},
  serif: {label: 'Serif', value: "Georgia, 'Times New Roman', serif"},
  mono: {label: 'Mono', value: 'ui-monospace, SFMono-Regular, Menlo, monospace'},
};

// What the Icons option amounts to in a page's own script.
const ICONS_JS = `// SVG markup per icon name — copied from lucide.dev here; any icon set works.
Everygrid.setIcons({
  reload: '<svg viewBox="0 0 24 24" …>…</svg>',
  search: '<svg viewBox="0 0 24 24" …>…</svg>',
  // …${Object.keys(LUCIDE_ICONS).length - 2} more in this demo (see lucideIcons.ts)
});`;

const DEFAULT_RADIUS = 8; // --everygrid-radius-lg is 0.5rem

// Header looks, as token values. They point at other tokens, so they follow the accent and the mode.
const HEADERS: Record<Header, {label: string; tokens: [string, string][]}> = {
  default: {label: 'Default', tokens: []},
  strong: {label: 'Strong', tokens: [
    ['--everygrid-header-bg', 'var(--everygrid-neutral-800)'],
    ['--everygrid-header-color', 'var(--everygrid-neutral-50)'],
  ]},
  accent: {label: 'Accent', tokens: [
    ['--everygrid-header-bg', 'var(--everygrid-accent-50)'],
    ['--everygrid-header-color', 'var(--everygrid-accent-700)'],
    ['--everygrid-border', 'var(--everygrid-accent-100)'],
  ]},
  minimal: {label: 'Minimal', tokens: [
    ['--everygrid-header-bg', 'var(--everygrid-surface)'],
    ['--everygrid-header-color', 'var(--everygrid-neutral-500)'],
    ['--everygrid-header-font-weight', '500'],
    ['--everygrid-header-font-size', '12px'],
  ]},
};

/** The stylesheet these choices amount to — injected by this tab, and shown below the grid. */
function themeCss(accent: Accent, radius: number, font: Font, header: Header): string {
  const root: string[] = [];
  const dark: string[] = [];
  if (accent !== 'indigo') {
    STEPS.forEach((s, i) => {
      root.push(`  --everygrid-accent-${s}: ${ACCENTS[accent].light[i]};`);
      dark.push(`  --everygrid-accent-${s}: ${ACCENTS[accent].dark[i]};`);
    });
  }
  if (radius !== DEFAULT_RADIUS) {
    const px = (k: number) => `${+(radius * k).toFixed(2)}px`;
    root.push(`  --everygrid-radius-sm: ${px(0.5)};`, `  --everygrid-radius-md: ${px(0.75)};`,
        `  --everygrid-radius-lg: ${px(1)};`, `  --everygrid-radius-xl: ${px(1.5)};`);
  }
  const family = FONTS[font].value;
  if (family) root.push(`  --everygrid-font: ${family};`);
  for (const [name, value] of HEADERS[header].tokens) root.push(`  ${name}: ${value};`);
  if (!root.length) return '/* The default theme — nothing to override. */';

  let css = `:root {\n${root.join('\n')}\n}`;
  if (dark.length) {
    const block = dark.join('\n');
    css += `\n\n/* Dark mode has its own scale values. */\n[data-everygrid-theme="dark"] {\n${block}\n}`
        + `\n@media (prefers-color-scheme: dark) {\n  [data-everygrid-theme="auto"] {\n`
        + `${block.replaceAll('  --', '    --')}\n  }\n}`;
  }
  return css;
}

/** Switch to the API Docs tab (the portal follows the hash) and bring its Theming section to the top.
 *  The jump is instant, not smooth, and is re-applied while the page settles: on a first visit the
 *  README's images load after the jump and push everything down, so a one-off (or animated) scroll
 *  ended up far from the heading. Re-aligning stops after a few seconds or as soon as you scroll. */
function openThemingDocs(e: MouseEvent) {
  e.preventDefault();
  window.location.hash = 'docs';
  const started = performance.now();
  const align = (): HTMLElement | null => {
    const heading = document.getElementById('theming');
    const scroller = heading?.closest<HTMLElement>('.demo-scroll');
    if (!heading || !scroller) return null;
    scroller.scrollTop += heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16;
    return scroller;
  };
  const wait = () => {
    const scroller = align();
    if (!scroller) {
      if (performance.now() - started < 2000) requestAnimationFrame(wait);
      return;
    }
    const keep = new ResizeObserver(() => align());
    keep.observe(document.getElementById('theming')?.closest('.docs-page') ?? scroller);
    const stop = () => {
      keep.disconnect();
      scroller.removeEventListener('wheel', stop);
      scroller.removeEventListener('touchstart', stop);
    };
    scroller.addEventListener('wheel', stop, {passive: true});
    scroller.addEventListener('touchstart', stop, {passive: true});
    setTimeout(stop, 3000);
  };
  requestAnimationFrame(wait);
}

export default function ThemeDemo({active}: { active: boolean }) {
  // The React demo's first dataset: nested objects and arrays too, to see JSON cells and their
  // popup under each theme.
  useGrid('theme-grid', '/react/data.json');

  const [mode, setMode] = useState<Mode>('light');
  const [accent, setAccent] = useState<Accent>('indigo');
  const [radius, setRadius] = useState(DEFAULT_RADIUS);
  const [font, setFont] = useState<Font>('system');
  const [header, setHeader] = useState<Header>('default');
  const [icons, setIcons] = useState<Icons>('default');
  const css = themeCss(accent, radius, font, header);

  // Tokens and mode go on the document while this tab is on screen — popups render into <body>,
  // so they have to see them too — and come off when it is not, leaving the other tabs as they were.
  useEffect(() => {
    if (!active) return;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    Everygrid.setTheme(mode);
    return () => {
      style.remove();
      Everygrid.setTheme('light');
    };
  }, [active, css, mode]);

  // Icons are swapped through the API rather than CSS; restored the same way on leaving the tab.
  useEffect(() => {
    if (!active || icons === 'default') return;
    Everygrid.setIcons(LUCIDE_ICONS);
    return () => Everygrid.setIcons(Object.fromEntries(Object.keys(LUCIDE_ICONS).map(k => [k, null])));
  }, [active, icons]);

  const reset = () => {
    setMode('light');
    setAccent('indigo');
    setRadius(DEFAULT_RADIUS);
    setFont('system');
    setHeader('default');
    setIcons('default');
  };

  return (
      <div className='max-w-7xl mx-auto'>
        <main className='min-h-150 flex flex-col gap-6 py-8 bg-white'>
          <div className='demo-tools'>
            <EverygridLocaleSwitch persist defaultLocale='en'/>
            <a className='theme-docs-link' href='#docs' onClick={openThemingDocs}>Theming docs →</a>
          </div>

          <div className='theme-controls'>
            <Segmented label='Mode' value={mode} onChange={setMode}
                       options={[['light', 'Light'], ['dark', 'Dark'], ['auto', 'Auto']]}/>
            <div className='theme-field'>
              <span>Accent</span>
              <div className='theme-swatches'>
                {(Object.keys(ACCENTS) as Accent[]).map(a => (
                    <button key={a} type='button' title={ACCENTS[a].label} aria-pressed={a === accent}
                            className={a === accent ? 'active' : ''}
                            style={{background: ACCENTS[a].light[6]}} onClick={() => setAccent(a)}/>
                ))}
              </div>
            </div>
            <label className='theme-field'>
              <span>Radius <b>{radius}px</b></span>
              <input type='range' min={0} max={16} value={radius} onChange={e => setRadius(+e.target.value)}/>
            </label>
            <Segmented label='Font' value={font} onChange={setFont}
                       options={(Object.keys(FONTS) as Font[]).map(f => [f, FONTS[f].label])}/>
            <Segmented label='Header' value={header} onChange={setHeader}
                       options={(Object.keys(HEADERS) as Header[]).map(h => [h, HEADERS[h].label])}/>
            <Segmented label='Icons' value={icons} onChange={setIcons}
                       options={[['default', 'Default'], ['lucide', 'Lucide']]}/>
            <button type='button' className='theme-reset' onClick={reset}>Reset</button>
          </div>

          {/* The stage follows the tokens too, so the dark grid sits on a dark backdrop. */}
          <div className='theme-stage'>
            <div id='theme-grid' className='w-full'/>
          </div>

          <div className='theme-css'>
            <div className='theme-css-head'>Your CSS</div>
            <pre>{css}</pre>
            {icons === 'lucide' && <>
              <div className='theme-css-head'>Your JS</div>
              <pre>{ICONS_JS}</pre>
            </>}
          </div>
        </main>
      </div>
  );
}

function Segmented<T extends string>({label, value, options, onChange}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
      <div className='theme-field'>
        <span>{label}</span>
        <div className='theme-seg' role='group' aria-label={label}>
          {options.map(([v, text]) => (
              <button key={v} type='button' aria-pressed={v === value} className={v === value ? 'active' : ''}
                      onClick={() => onChange(v)}>{text}</button>
          ))}
        </div>
      </div>
  );
}
