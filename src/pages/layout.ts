import type { JobStatus } from '../jobs/status.js';

/**
 * The shared HTML shell for the three server-rendered pages.
 *
 * Everything dynamic on a page goes through `escapeHtml`: job payloads and
 * `last_error` strings come from the database and are untrusted.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes a value for use in HTML text and attribute positions. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) => HTML_ESCAPES[character] ?? character,
  );
}

/** An ISO 8601 UTC timestamp with milliseconds, or a dash. */
export function formatTimestamp(value: string | null): string {
  return value === null ? '—' : escapeHtml(value);
}

/** A coloured status badge that always carries its text label. */
export function statusBadge(status: JobStatus): string {
  return `<span class="badge badge-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

export type PageId = 'trigger' | 'jobs' | 'dead';

export interface LayoutOptions {
  title: string;
  active: PageId;
  body: string;
  /** Auto-refresh interval in seconds (the jobs page uses 2). */
  refreshSeconds?: number;
}

const NAV: { id: PageId; href: string; label: string }[] = [
  { id: 'trigger', href: '/', label: 'Trigger' },
  { id: 'jobs', href: '/jobs', label: 'Jobs' },
  { id: 'dead', href: '/dead', label: 'Dead letters' },
];

const STYLES = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
       color: #111827; background: #f9fafb; }
header { background: #111827; color: #f9fafb; }
header .inner { max-width: 1200px; margin: 0 auto; padding: 0 20px; display: flex;
                align-items: center; gap: 24px; height: 56px; }
header .brand { font-weight: 700; letter-spacing: .02em; }
nav { display: flex; gap: 4px; }
nav a { color: #d1d5db; text-decoration: none; padding: 6px 10px; border-radius: 6px; }
nav a:hover { color: #fff; background: #1f2937; }
nav a.active { color: #111827; background: #f9fafb; font-weight: 600; }
main { max-width: 1200px; margin: 0 auto; padding: 24px 20px 64px; }
h1 { font-size: 22px; margin: 0 0 16px; }
h2 { font-size: 17px; margin: 0 0 12px; }
h3 { font-size: 14px; margin: 18px 0 8px; text-transform: uppercase;
     letter-spacing: .05em; color: #6b7280; }
a { color: #1d4ed8; }
.mono, code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre { background: #f3f4f6; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px;
      overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 12px; }
.card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
        padding: 16px 18px; margin: 0 0 16px; }
.table-wrap { overflow-x: auto; background: #fff; border: 1px solid #e5e7eb;
              border-radius: 10px; margin: 0 0 16px; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e5e7eb;
         vertical-align: top; }
th { background: #f9fafb; font-weight: 600; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px;
         font-size: 12px; font-weight: 600; white-space: nowrap; }
.badge-pending { background: #e5e7eb; color: #111827; }
.badge-processing { background: #dbeafe; color: #1e3a8a; }
.badge-succeeded { background: #d1fae5; color: #065f46; }
.badge-failed { background: #fef3c7; color: #92400e; }
.badge-dead { background: #fee2e2; color: #991b1b; }
.counts { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 16px; }
.count { display: flex; align-items: center; gap: 8px; background: #fff;
         border: 1px solid #e5e7eb; border-radius: 10px; padding: 10px 12px;
         text-decoration: none; color: inherit; }
.count:hover { border-color: #9ca3af; }
.count.selected { outline: 2px solid #1d4ed8; }
.count strong { font-size: 18px; }
form { display: grid; gap: 14px; max-width: 560px; }
label { display: grid; gap: 6px; font-weight: 600; }
label .hint { font-weight: 400; color: #6b7280; font-size: 13px; }
input { font: inherit; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; }
button { font: inherit; font-weight: 600; padding: 9px 16px; border: 0; border-radius: 8px;
         background: #1d4ed8; color: #fff; cursor: pointer; }
button:hover:enabled { background: #1e40af; }
button:disabled { background: #9ca3af; cursor: not-allowed; }
.notice { padding: 10px 12px; border-radius: 8px; background: #fef3c7; color: #92400e; }
.notice.error { background: #fee2e2; color: #991b1b; }
.panel { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
         padding: 16px 18px; margin: 18px 0 0; }
dl { display: grid; grid-template-columns: 150px 1fr; gap: 6px 12px; margin: 0; }
dt { font-weight: 600; color: #374151; }
dd { margin: 0; overflow-wrap: anywhere; }
.muted { color: #6b7280; }
.filters { margin: 0 0 12px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.filters a[aria-current="true"] { font-weight: 700; color: #111827; text-decoration: none; }
.card.narrow { max-width: 640px; }
.ts { white-space: nowrap; }
.table-wrap td, .table-wrap th { padding: 7px 8px; }
.table-wrap td.ts { font-size: 12px; }
.err { max-width: 260px; min-width: 180px; overflow-wrap: anywhere; }
`;

/** Wraps page content in the shared shell. */
export function layout(options: LayoutOptions): string {
  const refresh =
    options.refreshSeconds === undefined
      ? ''
      : `<meta http-equiv="refresh" content="${options.refreshSeconds}">`;

  const nav = NAV.map(
    (item) =>
      `<a href="${item.href}"${item.id === options.active ? ' class="active" aria-current="page"' : ''}>${item.label}</a>`,
  ).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)} · Report generator</title>
${refresh}
<style>${STYLES}</style>
</head>
<body>
<header>
  <div class="inner">
    <span class="brand">Report generator</span>
    <nav>${nav}</nav>
  </div>
</header>
<main>
${options.body}
</main>
</body>
</html>`;
}
