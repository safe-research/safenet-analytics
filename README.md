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
| Sentinels: overview, participation by window and per day, verdicts, coverage, disputes and arbitration, earnings (USDC.e fees, SAFE subsidies), bonds | `sentinel_overview`, `sentinel_windows`, `sentinel_participation_daily`, `sentinel_verdicts`, `sentinel_coverage`, `sentinel_disputes`, `sentinel_earnings`, `sentinel_earnings_daily`, `sentinel_bonds` | [docs/metrics/sentinels.md](docs/metrics/sentinels.md) |
| Sentinel models (not displayed): membership terms, responses per request, reverted calls, Sentinel USDC.e transfers, SAFE rewards distributor events, published SAFE allocations | `safenet_sentinel_terms`, `safenet_sentinel_responses`, `safenet_sentinel_failed_calls`, `safenet_sentinel_wallet_transfers`, `safenet_reward_events`, `safenet_sentinel_rewards` | [docs/metrics/sentinels.md](docs/metrics/sentinels.md) |
| Staking: active stake, stakers and outstanding withdrawals now, flows by window, active stake history, deposits and completed withdrawals, net capital flow, withdrawal requests, outstanding withdrawals, stake by validator (self-stake and delegated) | `staking_overview`, `staking_flow_summary`, `staking_daily`, `staking_withdrawals_outstanding`, `staking_by_validator` | [docs/metrics/staking.md](docs/metrics/staking.md) |
| Staking models (not displayed, shared with the Validators section): events, validator stakers, withdrawals, positions, validators | `staking_events`, `staking_validator_stakers`, `staking_withdrawals`, `staking_positions`, `staking_validators` | [docs/metrics/staking.md](docs/metrics/staking.md#models) |
| Validators: overview (attestation set, staking registration, stake and shares, participation, last signature share), stake by status, participation by window and per day, stake history, rewards by period and by staker, withdrawal exposure | `validator_overview`, `validator_stake_status`, `validator_participation_windows`, `validator_participation_daily`, `validator_stake_daily`, `validator_stake_split_daily`, `validator_rewards_periods`, `validator_rewards_by_staker`, `validator_withdrawal_exposure` | [docs/metrics/validators.md](docs/metrics/validators.md) |
| Validator models (not displayed): epochs, attestation-set membership, signing ceremonies, staker history, published rewards | `validator_epochs`, `validator_membership`, `validator_ceremonies`, `validator_staker_history`, `safenet_validator_rewards` | [docs/metrics/validators.md](docs/metrics/validators.md#models) |
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
npm run sync:sentinel-rewards      # refresh published SAFE allocations of Sentinels from safe-fndn/safenet-data
npm run verify:sentinels           # recount the Sentinels section from chain data (add -- --traces for reverted calls)
npm run dune -- deploy --preview --sha <sha>   # preview deploy (normally done by CI)
```
