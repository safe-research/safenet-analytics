# Deployment

GitHub is the source of truth for the queries, charts, dashboard text and layout in `dune/`. Merging to `main` deploys them to Dune. Deploying never runs queries; that is the job of [refreshes](refreshes.md).

## Workflows

| Workflow | Trigger | What it does |
| --- | --- | --- |
| **Preview** | pull requests from branches of this repository; manual | Deploys the pull request to its private preview dashboards and comments with the URLs, link check, widget diagnosis, images, reconciliation and the production dry run; see [preview.md](preview.md) |
| **Preview auto-cleanup** | pull request closed | Starts *Preview cleanup* for the pull request's track, unless another open pull request uses it; see [preview.md](preview.md#cleanup) |
| **Preview cleanup** | started by *Preview auto-cleanup*; manual | Removes a preview track's resources; see [preview.md](preview.md#cleanup) |
| **Validate** | pull requests | Typecheck, tests, offline validation. With `DUNE_API_KEY`, also a dry-run plan against Dune, which fails on conflicting Dune edits. It also runs each changed query's SQL on Dune as an unsaved execution, which costs credits, and checks that the columns the charts use exist in the result. |
| **Deploy** | push to `main` touching `dune/`, `src/` or dependencies; manual (optional *dry run*, *force*) | Deploys the current `main` (so queued runs see the previous run's `state.json`), then commits `dune/state.json` to `main` over SSH with the repository's deploy key, which `main`'s ruleset lets through ([setup.md](setup.md)) |
| **Refresh** | daily 05:17 UTC; after a successful deploy; manual | Executes the queries, then checks the first metric against on-chain events |

## How a deploy works

1. **Identity.** Dune's `whoami` must return team `safe`; otherwise the deploy stops.
2. **Protected dashboards.** The deploy reads `safe/safenet-beta` with all its visualizations and queries, and fingerprints them. Any of those IDs appearing in the plan is an error, even with `--force`. The deployer also refuses to write to them. After the deploy, the fingerprint must be unchanged. If the Beta dashboard cannot be read, the deploy stops rather than run unprotected. The Beta IDs are recorded in `dune/state.json` under `protected`.
3. **Plan.** Each resource in `dune/` is matched to Dune by its ID in `dune/state.json`. If there is no recorded ID, the deployer looks for an existing resource before creating one:
   - queries by name with the `safenet-analytics` tag;
   - visualizations by name on their query;
   - each dashboard by `safe/<slug>`. An existing dashboard at the slug that differs from GitHub is a conflict, so a deploy never takes over a dashboard it did not create.

   This is why redeploys never duplicate resources, even if `state.json` was lost.
4. **Actions.** For each resource:

   | Action | When |
   | --- | --- |
   | `noop` | GitHub and Dune are unchanged since the last deploy. No API write is made. |
   | `update` | GitHub changed. Updated in place, so the ID and dashboard URL stay the same. |
   | `create` | Not in Dune yet. |
   | `adopt` | Found in Dune and matching GitHub. Only its ID is recorded. |
   | `conflict` | Dune differs from what the last deploy left there (someone edited it in Dune), or an untracked resource with the same name or slug differs. Nothing at all is written. |
   | `delete` / `archive` | Removed from `dune/`. Visualizations are deleted after the dashboard stops showing them. Queries are archived, which can be undone in Dune. |

5. **Apply** in this order: queries → visualizations → dashboards → removals. Dashboards are written in two passes; see [Dashboards and links](#dashboards-and-links). After each write the deployer reads the resource back from Dune and stores two fingerprints in `dune/state.json`: one of the GitHub configuration and one of Dune's copy. Comparing Dune's copy with the stored fingerprint is how later deploys detect direct edits. State is saved even if the deploy fails partway.

Dune's API has no versioning or locking for updates, so the check and the write are separate requests. An edit made in Dune in the seconds between them is overwritten.

## Dashboards and links

Each file `dune/dashboards/<key>.yaml` is one dashboard. `overview` is `safe/safenet`. It is the landing page, and its section boxes link to the section dashboards. Each section dashboard has a navigation bar at the top and bottom that links back to the overview and to the other sections. The dashboards share queries and visualizations, so a panel shown on two dashboards is one Dune visualization, and its query runs once per refresh or preview run.

Text links to another dashboard as `{{dashboard:<key>}}`. Each environment renders it to `https://dune.com/safe/<slug>` with its own slugs: production slugs in production, preview slugs in a preview. Validation rejects hard-coded links to managed dashboards, unknown keys, and a production dashboard that does not link to all the others.

Applying dashboards:

1. Every dashboard is created if it is new, and given its slug. Dune can only set a slug after creating the dashboard.
2. Each dashboard's URL must resolve, through Dune's by-slug endpoint, to exactly the dashboard recorded for it. If Dune kept another slug (for example because the slug is taken), the deploy stops before writing any text, so no link points to a missing dashboard.
3. Text (with links) and layout are written, and read back.
4. After the deploy, every link is followed again through the API and must reach its dashboard. The deploy log and summary list them under *Links*.

`preview_only: true` marks a dashboard that is deployed to previews but never to production. Use it for temporary diagnostics. A dashboard removed from `dune/dashboards/` is left unchanged in Dune: the plan lists it as `noop`, and it is deleted by hand, or for previews by the preview cleanup.

## Dry run

```sh
npm run plan    # = node src/cli.ts deploy --dry-run
```

This reads Dune, prints the plan and exits non-zero on conflicts. It never writes; the client records every non-GET request, and a dry run fails if there is one. In GitHub, run *Deploy* with *dry run*, or open a pull request.

## Resolving a conflict

A conflict means someone changed a managed resource in the Dune UI.

1. `npm run dune -- pull` writes the Dune versions to `dune/.remote/` (ignored by git). Compare them with `diff -ru dune/.remote dune/queries`.
2. Choose one:
   - **Keep the Dune edit:** copy it into `dune/` and merge it as a pull request. The deployer sees that Dune now matches GitHub and records it (`adopt`).
   - **Discard the Dune edit:** run *Deploy* manually with *force*, or `npm run deploy -- --force`.

Resources deleted or archived in Dune also show up as conflicts. With *force*, they are created again with new IDs. For the dashboard this means a new dashboard; set its slug back in Dune if necessary.

## Production deployment of a reviewed change

1. The pull request's preview comment shows the **production plan**: the dry run of exactly what the merge will do. For example, `update` keeps an ID, `create` adds a resource, and `archive`/`delete` remove one. Check that no unexpected production resource is touched.
2. Merge. *Deploy* applies the plan to the stable production IDs, and the dashboard URL stays the same. A conflicting Dune edit made since the last deploy stops it; see below.
3. *Refresh* executes the production queries and runs the on-chain verification. Its summary is the production evidence.
4. The preview track is cleaned up automatically when the pull request is closed ([preview.md](preview.md#cleanup)).

To roll back, revert the merge ([restoring.md](restoring.md)).

## Query references

Queries refer to other managed queries as `{{query:<key>}}`. The deployer orders queries so referenced ones are written first, and renders each reference as `query_<id>` with the target's ID: production IDs in production, preview IDs in a preview. Fingerprints use the rendered SQL. A deploy also refuses SQL that names a guarded query directly as `query_<id>`, that is, a Beta query, or a production query in a preview.

## What is managed

- **Queries:** name, description, SQL, parameters, tags (plus the `safenet-analytics` tag), privacy.
- **Visualizations:** name, type, description, options. Options are Dune's chart settings as JSON; see [adding-a-metric.md](adding-a-metric.md).
- **Dashboards:** name, slug, privacy, tags, text widgets (with rendered links) and their positions, visualization widgets and their positions.

Not managed: dashboard parameter widgets, query schedules set in the Dune UI, materialized views, library folders. The dashboards must not have parameter widgets; a parameter widget added in Dune shows up as a conflict.
