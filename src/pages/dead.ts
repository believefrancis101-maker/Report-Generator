import type { DeadJobView, JobRunView } from '../jobs/queries.js';
import { escapeHtml, formatTimestamp, layout } from './layout.js';

/**
 * The dead letter view.
 *
 * Everything an operator needs to diagnose the failure without opening the
 * database: the payload, the full error and the complete run history.
 */

const SCRIPT = `
(function () {
  var buttons = document.querySelectorAll('button[data-retry]');
  Array.prototype.forEach.call(buttons, function (button) {
    button.addEventListener('click', function () {
      var jobId = button.getAttribute('data-retry');
      button.disabled = true;
      button.textContent = 'Retrying\\u2026';

      fetch('/api/jobs/' + encodeURIComponent(jobId) + '/retry', { method: 'POST' })
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          window.location.reload();
        })
        .catch(function () {
          button.disabled = false;
          button.textContent = 'Retry failed - try again';
        });
    });
  });
})();
`;

function runRow(run: JobRunView, index: number): string {
  const duration =
    run.durationMs === null ? '—' : `${run.durationMs} ms`;
  return `<tr>
      <td>${index + 1}</td>
      <td class="mono">${escapeHtml(run.workerId)}</td>
      <td class="mono ts">${formatTimestamp(run.startedAt)}</td>
      <td class="mono ts">${formatTimestamp(run.finishedAt)}</td>
      <td class="mono ts">${duration}</td>
      <td class="mono">${run.outcome === null ? '—' : escapeHtml(run.outcome)}</td>
      <td class="mono err">${run.error === null ? '—' : escapeHtml(run.error)}</td>
    </tr>`;
}

function deadJobCard(job: DeadJobView): string {
  const payload = JSON.stringify(job.payload, null, 2);
  const runs =
    job.runs.length === 0
      ? '<p class="muted">No execution records.</p>'
      : `<div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>Worker</th>
            <th>started</th>
            <th>finished</th>
            <th>Duration</th>
            <th>Outcome</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>${job.runs.map(runRow).join('')}</tbody>
      </table>
    </div>`;

  return `
<section class="card">
  <h2>Dead job <span class="mono">${escapeHtml(job.id)}</span></h2>
  <dl>
    <dt>Type</dt>
    <dd>${escapeHtml(job.type)}</dd>
    <dt>Attempts</dt>
    <dd>${job.attempts}/${job.maxAttempts}</dd>
    <dt>Created</dt>
    <dd class="mono">${formatTimestamp(job.createdAt)}</dd>
    <dt>Finished</dt>
    <dd class="mono">${formatTimestamp(job.finishedAt)}</dd>
  </dl>

  <h3>Payload</h3>
  <pre>${escapeHtml(payload)}</pre>

  <h3>Last error</h3>
  <pre>${job.lastError === null ? '—' : escapeHtml(job.lastError)}</pre>

  <h3>Run history</h3>
  ${runs}

  <p><button type="button" data-retry="${escapeHtml(job.id)}">Retry job</button></p>
</section>`;
}

/** Renders the dead letter page. */
export function renderDeadPage(jobs: DeadJobView[]): string {
  const body =
    jobs.length === 0
      ? `<h1>Dead letters</h1>
<p>No dead jobs.</p>`
      : `<h1>Dead letters</h1>
<p class="muted">${jobs.length} dead ${jobs.length === 1 ? 'job' : 'jobs'}.
A retry resets the attempt counter and puts the job back in the queue; the run
history stays below each job.</p>
${jobs.map(deadJobCard).join('')}
<script>${SCRIPT}</script>`;

  return layout({ title: 'Dead letters', active: 'dead', body });
}
