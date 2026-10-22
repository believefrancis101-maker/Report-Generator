import { layout } from './layout.js';

/**
 * The trigger page: submit a report request and watch it move.
 *
 * The inline script talks to the JSON API; every value it puts on screen is
 * assigned with `textContent`, never `innerHTML`, so a hostile `last_error`
 * cannot inject markup through the polling path either.
 */

/** A sensible default range: the last twelve months, in UTC. */
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const yearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  return {
    from: yearAgo.toISOString().slice(0, 10),
    to: now.toISOString().slice(0, 10),
  };
}

const SCRIPT = `
(function () {
  var form = document.getElementById('trigger-form');
  var out = document.getElementById('result');
  var timer = null;
  var currentJobId = null;

  function stopPolling() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function showMessage(text, isError) {
    stopPolling();
    out.replaceChildren();
    var p = document.createElement('p');
    p.className = isError ? 'notice error' : 'notice';
    p.textContent = text;
    out.appendChild(p);
  }

  function buildPanel(jobId, duplicate) {
    stopPolling();
    out.replaceChildren();

    var box = document.createElement('div');
    box.className = 'panel';

    var heading = document.createElement('h2');
    heading.textContent = duplicate ? 'Duplicate request' : 'Job accepted';
    box.appendChild(heading);

    if (duplicate) {
      var note = document.createElement('p');
      note.textContent = 'This request matches existing job ' + jobId;
      box.appendChild(note);
    }

    var idLine = document.createElement('p');
    idLine.className = 'mono';
    idLine.textContent = jobId;
    box.appendChild(idLine);

    var dl = document.createElement('dl');
    function addRow(label, id) {
      var dt = document.createElement('dt');
      dt.textContent = label;
      var dd = document.createElement('dd');
      dd.id = id;
      dd.textContent = '\\u2026';
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    addRow('Status', 'job-status');
    addRow('Failed attempts', 'job-attempts');
    addRow('Last error', 'job-error');
    box.appendChild(dl);

    var download = document.createElement('p');
    download.id = 'job-download';
    box.appendChild(download);

    out.appendChild(box);
  }

  function update(job) {
    var statusCell = document.getElementById('job-status');
    statusCell.replaceChildren();
    var badge = document.createElement('span');
    badge.className = 'badge badge-' + job.status;
    badge.textContent = job.status;
    statusCell.appendChild(badge);

    document.getElementById('job-attempts').textContent =
      String(job.attempts) + ' / ' + String(job.maxAttempts);
    document.getElementById('job-error').textContent =
      job.lastError === null || job.lastError === undefined ? '\\u2014' : job.lastError;

    var download = document.getElementById('job-download');
    download.replaceChildren();
    if (job.reportAvailable) {
      var link = document.createElement('a');
      link.href = '/api/jobs/' + encodeURIComponent(job.id) + '/report';
      link.textContent = 'Download report (PDF)';
      download.appendChild(link);
    }
  }

  function poll(jobId) {
    fetch('/api/jobs/' + encodeURIComponent(jobId))
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (job) {
        if (currentJobId !== jobId) return;
        update(job);
        if (job.status === 'succeeded' || job.status === 'dead') {
          timer = null;
          return;
        }
        timer = setTimeout(function () { poll(jobId); }, 1000);
      })
      .catch(function () {
        if (currentJobId !== jobId) return;
        timer = setTimeout(function () { poll(jobId); }, 1000);
      });
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    stopPolling();
    out.replaceChildren();
    currentJobId = null;

    var payload = {
      dateFrom: document.getElementById('dateFrom').value,
      dateTo: document.getElementById('dateTo').value
    };
    var key = document.getElementById('idempotencyKey').value.trim();
    var body = { type: 'sales_report', payload: payload };
    if (key) {
      body.idempotencyKey = key;
    }

    fetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (response) {
        return response.json()
          .catch(function () { return {}; })
          .then(function (data) { return { status: response.status, data: data }; });
      })
      .then(function (result) {
        var data = result.data;
        if (result.status === 422) {
          showMessage(data.message || 'This key was already used with a different request', true);
          return;
        }
        if (result.status === 400) {
          var issues = (data.issues || []).map(function (issue) {
            return (issue.path ? issue.path + ': ' : '') + issue.message;
          }).join('; ');
          showMessage('Invalid request. ' + (issues || 'Check the dates.'), true);
          return;
        }
        if (!data.id) {
          showMessage('Unexpected response (' + result.status + ').', true);
          return;
        }

        var duplicate = result.status === 200 && data.duplicate === true;
        currentJobId = data.id;
        buildPanel(data.id, duplicate);
        poll(data.id);
      })
      .catch(function (error) {
        showMessage('Request failed: ' + error.message, true);
      });
  });
})();
`;

/** Renders the trigger form and its polling script. */
export function renderTriggerPage(): string {
  const range = defaultRange();

  const body = `
<h1>Generate a sales report</h1>
<p class="muted">The request is queued and processed by a worker. The page polls
the job until it is finished.</p>

<div class="card narrow">
  <form id="trigger-form">
    <label for="dateFrom">From
      <input type="date" id="dateFrom" name="dateFrom" required value="${range.from}">
    </label>
    <label for="dateTo">To
      <input type="date" id="dateTo" name="dateTo" required value="${range.to}">
    </label>
    <label for="idempotencyKey">Idempotency key <span class="hint">(optional - blank derives a key from the request)</span>
      <input type="text" id="idempotencyKey" name="idempotencyKey" maxlength="255"
             placeholder="blank = derived from the request">
    </label>
    <div><button type="submit">Generate report</button></div>
  </form>
</div>

<div id="result" role="status" aria-live="polite"></div>

<script>${SCRIPT}</script>`;

  return layout({ title: 'Trigger', active: 'trigger', body });
}
