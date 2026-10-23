# Break-it evidence

These scripts try to break the queue on purpose and record what happened. Every
printed value comes from the database or from a captured child process log -
nothing is edited by hand.

Each script starts from a clean queue: it prints a one-line warning and deletes
every row from `jobs`, which cascades to `job_runs` and `reports`. It never
touches `sales_orders`, and it prints that table's row count as proof. The API
and the workers are started as **real child processes** of `process.execPath`
(`node --import tsx src/worker.ts`), not through npm or `tsx watch`, so the PID
that is killed is the process that holds the job.

```bash
npm run evidence:concurrency
npm run evidence:backoff
npm run evidence:kill-recovery
npm run evidence:idempotency-key
npm run evidence:two-workers
npm run evidence:crash-after-work
npm run evidence:all-statuses
```

Add `--pause` to any of them to stop at the screenshot points:

```bash
npm run evidence:kill-recovery -- --pause
```

At a pause the script prints `SCREENSHOT NOW: <what to capture>` and waits for
Enter. The API is left running during the pause, so `/jobs` and `/dead` can be
opened in a browser. `EVIDENCE_PORT` overrides the API port (default `3000`) if
it is taken.

Add `--screenshots` to capture the same pages automatically with Playwright
(Chromium) and continue without waiting:

```bash
npm run evidence:kill-recovery -- --screenshots
npm run evidence:screenshots
```

The second command runs `kill-recovery` and `all-statuses` with the flag and
then prints every file with its size.

## Output files

Each run writes its complete output to `evidence/<name>.txt`. Every child's
stdout/stderr is captured with a leading timestamp in
`evidence/logs/<name>-<child>.log`, and those raw logs are kept. Re-running a
script overwrites its own files.

| Script | Output | Requirement it proves |
| --- | --- | --- |
| `evidence:concurrency` | `concurrency.txt`, `logs/concurrency-worker.log` | Enqueue does one insert and returns `202` immediately; the worker's concurrency cap is never exceeded. 50 simultaneous POSTs, one worker with `CONCURRENCY=3`. |
| `evidence:backoff` | `backoff.txt`, `logs/backoff-worker.log` | Retries are exponential with jitter and capped by `MAX_ATTEMPTS`. Gaps between attempt starts sit in `[base * 2^(n-1), 1.5 * base * 2^(n-1) + poll slack]`. The job ends `dead`. |
| `evidence:kill-recovery` | `kill-recovery.txt`, `logs/kill-recovery-worker-{a,b}.log` | `SIGKILL` mid-job leaves the job `processing` with an open run; the next worker's sweep closes the run as `crashed`, counts the attempt once, requeues the job, and exactly one report is written. |
| `evidence:idempotency-key` | `idempotency-key.txt`, `logs/idempotency-key-api.log` | The unique constraint enforces idempotency, not a check-then-insert: sequential repeat is `200 duplicate`, 20 concurrent submits produce one row, and a reused key with another payload is `422`. |
| `evidence:two-workers` | `two-workers.txt`, `logs/two-workers-worker-{a,b}.log` | Two workers claiming from the same queue never double-claim a job: 100 jobs, 100 runs, zero jobs with more than one run, each worker at or below its cap. |
| `evidence:crash-after-work` | `crash-after-work.txt`, `logs/crash-after-work-worker-{a,b}.log` | A real crash after the report is saved does not repeat the aggregation: the recovered job is `succeeded`, there is exactly one `reports` row, and the aggregation log line appears once across both workers. |
| `evidence:all-statuses` | `all-statuses.txt`, `logs/all-statuses-*.log` | All five states (`pending`, `processing`, `succeeded`, `failed`, `dead`) exist at the same time, produced by real workers, with the API up for the screenshot. |

## Screenshots

The screenshots were captured by script from the real pages during the runs:
`npm run evidence:screenshots` runs `evidence:kill-recovery` and
`evidence:all-statuses` with `--screenshots`, which captures each point with
Playwright (Chromium) at 1400x900, 2x scale, full page, after the network is
idle and the table has rendered.

| Screenshot | Run | Capture |
| --- | --- | --- |
| ![Jobs while processing](screenshots/kill-1-before.png) | `npm run evidence:kill-recovery -- --screenshots` | `/jobs` while the job is `processing` (blue badge) with one open run. |
| ![Jobs after the kill](screenshots/kill-2-after-kill.png) | same run, second capture | `/jobs` after the worker was killed: still `processing`, still one open run, nothing has swept yet. |
| ![Jobs after recovery](screenshots/kill-3-after-recovery.png) | same run, third capture | `/jobs` after recovery: `succeeded`, `Failed attempts 1/5`, and the sweep message in `last_error`. |
| ![All five statuses](screenshots/all-statuses.png) | `npm run evidence:all-statuses -- --screenshots` | `/jobs` showing all five statuses in the counts and in the table. |
| ![Dead letter](screenshots/dead-letter.png) | same run, second capture | `/dead` with the dead job's payload, full error and run history. |
