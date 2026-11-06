# Refreshes

Dashboards show each query's latest stored result. The **Refresh** workflow keeps those results current by executing the deployed queries:

- daily at 05:17 UTC, for all queries with `refresh: daily` in their `query.yaml`;
- after every successful deploy of a merge to `main`, so changed SQL shows up without waiting a day (manual Deploy runs do not trigger it);
- manually: *Actions → Refresh → Run workflow*, optionally for a single query key.

Locally: `npm run refresh` (all daily queries) or `npm run refresh -- --query transaction_checks_daily`.

Each execution uses the query's `performance` tier (`medium` by default) and costs Dune credits based on the compute used. The workflow log and job summary show the state and credits of every execution, and Dune's error message when one fails. A failed, cancelled or expired execution is retried once after a minute: Dune occasionally fails an execution of unchanged SQL that succeeds later. If the retry fails too, the workflow fails after refreshing the other queries, and GitHub notifies whoever last changed the schedule. The dashboard then keeps showing that query's last successful result.

After refreshing, the workflow recomputes the request metric (`verify:transaction-checks`) and the Network & revenue section with its fee accounting (`verify:network-revenue`), and the Sentinels section with its bonds and SAFE rewards (`verify:sentinels`), from Gnosis Chain logs. It checks validator membership and signing against contract state (`verify:validators`). It also replays the Staking contract from Ethereum logs and checks it against the contract's state at the same block (`verify:staking`, with `ETHEREUM_RPC_URL` if set). It recomputes the realized APR from the ENS-pinned rewards, a stake replay and signing events (`verify:rewards-apr`). It compares all of them with the latest Dune results, each at the block that result ends at, also when a refresh failed. If they differ, the workflow fails. The full comparison is uploaded as the `verification` artifact.

## Why not Dune's own scheduler

- **The Dune API cannot set query schedules.** The scheduler is UI-only, and schedules set there are not visible to GitHub.
- **Materialized views do not fit.** They can be scheduled via the API, but a dashboard chart reads its query's results, not a materialized view, and every update of a materialized view re-executes it.

So the schedule lives in this repository and runs on GitHub Actions. To add another schedule (for example hourly), add it to `REFRESH_SCHEDULES` in `src/config.ts` and a cron entry in `.github/workflows/refresh.yml` that runs `npm run refresh -- --schedule hourly`.

GitHub disables scheduled workflows in repositories without activity for 60 days. If the dashboard stops updating, check that *Refresh* is still enabled.

## Published rewards

Rewards data is generated into the repository, not read live: a new Merkle root changes nothing on Dune until it is synced and merged. *Sync rewards* ([setup.md](setup.md#rewards-sync)) checks daily, before Refresh. When the ENS name `rewards.safenet-gov.eth` pins a new rewards DB, it pushes a branch and opens an issue with a link to create the pull request. Until that pull request is merged, Refresh's `verify:rewards-apr` and `verify:sentinels` fail on purpose, because the distributor's root is newer than the repository's. The realized APR shows the new period as *not yet published*, with its stake.
