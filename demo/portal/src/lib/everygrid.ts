import type EverygridDefault from '@everygrid/grid';

export type EverygridType = typeof EverygridDefault;
export type Locale = 'en' | 'ko';

// The React demo consumes the library through the workspace dependency (bundled
// by vite). The vanilla / jquery demos instead load the CDN standalone build in
// their own static HTML pages (see public/{vanilla,jquery}/index.html).
export function resolveEverygrid(): Promise<EverygridType> {
  return import('@everygrid/grid').then((m) => m.default);
}
