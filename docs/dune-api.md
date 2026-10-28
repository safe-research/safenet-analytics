# Dune API: supported operations

Checked on 2026-10-23 against:

- the live docs at docs.dune.com;
- the official CLI [`duneanalytics/cli`](https://github.com/duneanalytics/cli) v0.1.18;
- its API client `duneapi-client-go` v0.5.0, which is where the CLI makes its HTTP calls.

The deployer (`src/dune.ts`) calls these endpoints directly, because the CLI cannot set query tags or parameters, has no query listing, and has no conflict detection.

| Resource | Operations used | Documented on docs.dune.com |
| --- | --- | --- |
| Queries | `GET /api/v1/query/{id}`, `POST /api/v1/query`, `PATCH /api/v1/query/{id}`, `POST …/private`, `…/unprivate`, `…/archive`, `GET /api/v1/queries` | yes |
| Visualizations | `GET/PUT/DELETE /api/v1/visualizations/{id}`, `GET/POST /api/v1/queries/{id}/visualizations` | no; used by the official CLI (`dune viz`) |
| Dashboards | `POST /api/v1/dashboards`, `GET/PATCH /api/v1/dashboards/{id}`, `GET /api/v1/dashboards/by-slug/{owner}/{slug}` | no; used by the official CLI (`dune dashboard`) |
| Execution | `POST /api/v1/query/{id}/execute`, `POST /api/v1/sql/execute`, `GET /api/v1/execution/{id}/status`, `GET …/results`, `POST …/cancel`, `GET /api/v1/query/{id}/results` | yes |
| Dashboard archive | `POST /api/v1/dashboards/{id}/archive`, tried by preview cleanup only, with a fallback | no, and not in the official CLI; unverified |
| Identity | `GET /api/whoami` | no; used by the official CLI (`dune whoami`) |

## Constraints that shaped the design

- **No idempotency keys and no optimistic locking.** Query reads return a `version`, but updates do not accept one. Hence `dune/state.json` and the lookup-before-create steps; see [deployment.md](deployment.md).
- **Full replacement.** Visualization updates (`PUT`) replace name, type, description and options. Each widget array sent in a dashboard `PATCH` replaces all widgets of that kind. The deployer always sends the complete desired configuration.
- **Dashboard slug.** It cannot be set when the dashboard is created, so the deployer creates the dashboard and then sets the slug, text and widgets with one `PATCH`. There is no owner field. Ownership follows the API key, so the deploy requires a `safe` team key.
- **Query schedules cannot be set via the API.** See [refreshes.md](refreshes.md).
- **Rate limits.** On Plus: 70 write and 200 read requests per minute. A deploy makes a few dozen requests, most of them reads of the Beta dashboard for the protection check. The client retries `429` and `5xx` responses with backoff.

- **No folders.** None of the endpoints above assigns a library folder, so placing resources in the *Safenet* folder is a one-time UI step per new dashboard or query ([preview.md](preview.md#setup), [setup.md](setup.md)).
- **Slugs after creation.** A dashboard's slug can only be set by a `PATCH` after it is created, and Dune may keep another one (for example if the slug is taken). Before writing links, the deployer checks that each dashboard resolves by slug to the expected ID ([deployment.md](deployment.md#dashboards-and-links)).
- **Pivot options.** Dune documents no options format for `pivot`. Its editor stores `rows`, `columns` and `values` as lists of `{ column_name }`, with `agg_type` and `numberFormat` on values. PivotTable.js-style options crash its renderer ([adding-a-metric.md](adding-a-metric.md#visualization-options)).
- **Private resources.** Queries and dashboards are created with `is_private`. Whether the plan allows them shows on the first preview run: [preview.md](preview.md#what-keeps-production-safe) describes how the deployer stops otherwise.

## Not verified yet (needs the team key)

- Account permissions of the team key: the plan's API access, and whether visualizations and dashboards created with a team key are owned by the team.
- Dashboard grid width (assumed 6 columns) and whether Dune changes widget positions on save.
- Whether Dune normalizes stored visualization options (the deployer tolerates added defaults).

The first deploy settles all of these; see the checklist in [setup.md](setup.md).
