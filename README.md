# safenet-analytics

Safenet production analytics on Dune, managed from GitHub. The dashboard is [dune.com/safe/safenet](https://dune.com/safe/safenet), owned by the `safe` team.

This repository holds the SQL, chart settings, dashboard text and layout, and the IDs of the Dune resources they map to. Every pull request is first deployed to a private preview dashboard ([docs/preview.md](docs/preview.md)). Merging to `main` deploys to production. A separate daily job refreshes the data. The Beta dashboard, [dune.com/safe/safenet-beta](https://dune.com/safe/safenet-beta), is not managed here, and deploys check that it stays unchanged.

```
dune/
  project.yaml                Dune team, managed tag, protected dashboards
  dashboard.yaml              dashboard name, slug, text and layout
  preview.yaml                preview track and cost caps
  data/participants.json      participant labels (npm run sync:participants)
  text/*.md                   dashboard text
  queries/<key>/query.sql     query SQL
  queries/<key>/query.yaml    query metadata, refresh schedule, charts
  state.json                  Dune IDs and fingerprints (written by the Deploy workflow)
src/                          deployer (Dune API client, validation, plan/apply, refresh)
scripts/                      on-chain verification of metrics
verification/                 latest verification results
docs/                         documentation
```

## Metrics

| Metric | Query | Definition |
| --- | --- | --- |
| Transaction checks per day: requests, completed checks, attestations; all-time request counter | `transaction_checks_daily` | [docs/metrics/transaction-checks.md](docs/metrics/transaction-checks.md) |
| Latest requests with explorer links | `latest_requests` | [docs/metrics/transaction-checks.md](docs/metrics/transaction-checks.md#latest-requests) |
| Network & revenue: headline counters, time windows, result breakdown, networks, Guard-enabled Safes, fees and fee allocation | `network_summary`, `results_daily`, `network_breakdown`, `guard_adoption`, `fee_revenue_daily`, `fee_allocation`, `fee_config` | [docs/metrics/network-and-revenue.md](docs/metrics/network-and-revenue.md) |
| Shared models (not displayed): requests, oracle USDC.e flows, known traffic, SafenetGuard deployments and Safe guard status | `safenet_requests`, `safenet_fee_flows`, `safenet_known_traffic`, `safenet_guards`, `safenet_guard_status` | [docs/metrics/network-and-revenue.md](docs/metrics/network-and-revenue.md) |
| Decoded production events (shared, not displayed) | `safenet_events` | [docs/decoding.md](docs/decoding.md) |
| Participant labels (shared, not displayed) | `safenet_participant_labels` | [src/participants.ts](src/participants.ts) |

## Documentation

- [Setup](docs/setup.md): Dune API key, GitHub secret, first deployment
- [Adding a metric](docs/adding-a-metric.md)
- [Previews](docs/preview.md): private preview per pull request, tracks, review, cleanup
- [Deployment](docs/deployment.md): workflows, dry run, conflict detection, `--force`, query references
- [Event decoding](docs/decoding.md): raw-log decoding and replacing it with decoded tables
- [Refreshes](docs/refreshes.md): daily execution and on-chain verification
- [Restoring a previous configuration](docs/restoring.md)
- [Dune API notes](docs/dune-api.md): supported operations and their limits

## Commands

```sh
npm ci
npm test                           # unit tests (fake Dune API)
npm run validate                   # offline config checks
npm run plan                       # dry run against Dune (needs DUNE_API_KEY)
npm run deploy                     # deploy (normally done by CI)
npm run refresh                    # execute daily queries
npm run verify:transaction-checks  # recompute the first metric from Gnosis Chain logs
npm run verify:network-revenue     # recount the Network & revenue section and check fees against USDC.e flows
npm run sync:known-traffic         # regenerate the known operational/test Safes query
npm run sync:participants          # refresh participant labels from safe-fndn/safenet-data
npm run dune -- deploy --preview --sha <sha>   # preview deploy (normally done by CI)
```
