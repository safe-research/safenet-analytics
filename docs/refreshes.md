# Refreshes

Dashboards show each query's latest stored result. The **Refresh** workflow keeps those results current by executing the deployed queries:

- daily at 05:17 UTC, for all queries with `refresh: daily` in their `query.yaml`;
- after every successful deploy of a merge to `main`, so changed SQL shows up without waiting a day (manual Deploy runs do not trigger it);
- manually: *Actions → Refresh → Run workflow*, optionally for a single query key.

Locally: `npm run refresh` (all daily queries) or `npm run refresh -- --query transaction_checks_daily`.

Each execution uses the query's `performance` tier (`medium` by default) and costs Dune credits based on the compute used. The workflow log and job summary show the state and credits of every execution. A failed execution fails the workflow, and GitHub notifies whoever last changed the schedule.

After refreshing, the workflow recomputes the request metric (`verify:transaction-checks`) and the Network & revenue section with its fee accounting (`verify:network-revenue`), and the Sentinels section with its bonds and SAFE rewards (`verify:sentinels`), from Gnosis Chain logs, and compares them with the fresh Dune results. If they differ, the workflow fails. The full comparison is uploaded as the `verification` artifact.

## Why not Dune's own scheduler

- **The Dune API cannot set query schedules.** The scheduler is UI-only, and schedules set there are not visible to GitHub.
- **Materialized views do not fit.** They can be scheduled via the API, but a dashboard chart reads its query's results, not a materialized view, and every update of a materialized view re-executes it.

So the schedule lives in this repository and runs on GitHub Actions. To add another schedule (for example hourly), add it to `REFRESH_SCHEDULES` in `src/config.ts` and a cron entry in `.github/workflows/refresh.yml` that runs `npm run refresh -- --schedule hourly`.

GitHub disables scheduled workflows in repositories without activity for 60 days. If the dashboard stops updating, check that *Refresh* is still enabled.
