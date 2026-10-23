# safenet-analytics

Safenet production analytics on Dune, managed from GitHub. The dashboard is [dune.com/safe/safenet](https://dune.com/safe/safenet), owned by the `safe` team.

This repository holds the SQL, chart settings, dashboard text and layout, and the IDs of the Dune resources they map to. Merging to `main` deploys them. A separate daily job refreshes the data. The Beta dashboard, [dune.com/safe/safenet-beta](https://dune.com/safe/safenet-beta), is not managed here, and deploys check that it stays unchanged.

```
dune/
  project.yaml                Dune team, managed tag, protected dashboards
  dashboard.yaml              dashboard name, slug, text and layout
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
| Transaction checks per day: requests, completed checks, attestations | `transaction_checks_daily` | [docs/metrics/transaction-checks.md](docs/metrics/transaction-checks.md) |

## Documentation

- [Setup](docs/setup.md): Dune API key, GitHub secret, first deployment
- [Adding a metric](docs/adding-a-metric.md)
- [Deployment](docs/deployment.md): workflows, dry run, conflict detection, `--force`
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
```
