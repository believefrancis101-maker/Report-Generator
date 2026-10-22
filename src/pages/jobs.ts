import type { JobView } from '../jobs/queries.js';
import { JOB_STATUSES, type JobStatus } from '../jobs/status.js';
import {
  escapeHtml,
  formatTimestamp,
  layout,
  statusBadge,
  type LayoutOptions,
} from './layout.js';

/**
 * The jobs page: counts per status, filter links and the newest jobs.
 *
 * `?refresh=2` reloads the page every two seconds, which is handy while
 * watching jobs move (for example while taking screenshots).
 */

export interface JobsPageOptions {
  counts: Record<JobStatus, number>;
  jobs: JobView[];
  status: JobStatus | null;
  refreshSeconds: 2 | null;
}

/** Appends the refresh parameter so a filter does not stop the refresh. */
function hrefFor(status: JobStatus | null, refresh: 2 | null): string {
  const params = new URLSearchParams();
  if (status !== null) params.set('status', status);
  if (refresh !== null) params.set('refresh', '2');
  const query = params.toString();
  return query === '' ? '/jobs' : `/jobs?${query}`;
}

/** The last error, shortened for the table, with the full text in a title. */
function errorCell(lastError: string | null): string {
  if (lastError === null || lastError === '') {
    return '<span class="muted">—</span>';
  }
  const short =
    lastError.length > 90 ? `${lastError.slice(0, 87)}…` : lastError;
  return `<span class="mono" title="${escapeHtml(lastError)}">${escapeHtml(short)}</span>`;
}

export function renderJobsPage(options: JobsPageOptions): string {
  const counts = JOB_STATUSES.map((status) => {
    const selected = options.status === status ? ' selected' : '';
    return `<a class="count${selected}" href="${hrefFor(status, options.refreshSeconds)}" data-status-count="${status}">
      ${statusBadge(status)}
      <strong>${options.counts[status]}</strong>
    </a>`;
  }).join('');

  const filters = [
    `<a href="${hrefFor(null, options.refreshSeconds)}"${
      options.status === null ? ' aria-current="true"' : ''
    }><strong>All</strong></a>`,
    ...JOB_STATUSES.map(
      (status) =>
        `<a href="${hrefFor(status, options.refreshSeconds)}"${
          options.status === status ? ' aria-current="true"' : ''
        }>${status}</a>`,
    ),
  ].join(' · ');

  const rows = options.jobs
    .map(
      (job) => `<tr>
      <td class="mono ts">${escapeHtml(job.id)}</td>
      <td>${statusBadge(job.status)}</td>
      <td class="ts">${job.attempts}/${job.maxAttempts}</td>
      <td class="mono ts">${formatTimestamp(job.runAt)}</td>
      <td class="mono ts">${formatTimestamp(job.startedAt)}</td>
      <td class="mono ts">${formatTimestamp(job.finishedAt)}</td>
      <td class="err">${errorCell(job.lastError)}</td>
    </tr>`,
    )
    .join('');

  const table =
    options.jobs.length === 0
      ? '<p class="muted">No jobs match this filter.</p>'
      : `<div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Job id</th>
          <th>Status</th>
          <th>Failed attempts</th>
          <th>run_at</th>
          <th>started_at</th>
          <th>finished_at</th>
          <th>last_error</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;

  const refreshNote =
    options.refreshSeconds === null
      ? ''
      : `<p class="muted">Refreshing every ${options.refreshSeconds} seconds.</p>`;

  const body = `
<h1>Jobs</h1>
${refreshNote}
<div class="counts">${counts}</div>
<p class="filters"><span class="muted">Filter:</span> ${filters}</p>
${table}`;

  const layoutOptions: LayoutOptions = {
    title: 'Jobs',
    active: 'jobs',
    body,
  };
  if (options.refreshSeconds !== null) {
    layoutOptions.refreshSeconds = options.refreshSeconds;
  }
  return layout(layoutOptions);
}
