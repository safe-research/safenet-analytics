# Deployment

GitHub is the source of truth for the queries, charts, dashboard text and layout in `dune/`. Merging to `main` deploys them to Dune. Deploying never runs queries; that is the job of [refreshes](refreshes.md).

## Workflows

| Workflow | Trigger | What it does |
| --- | --- | --- |
| **Validate** | pull requests | Typecheck, tests, offline validation. With `DUNE_API_KEY`, also a dry-run plan against Dune, which fails on conflicting Dune edits. It also runs each changed query's SQL on Dune as an unsaved execution, which costs credits, and checks that the columns the charts use exist in the result. |
| **Deploy** | push to `main` touching `dune/`, `src/` or dependencies; manual (optional *dry run*, *force*) | Deploys the current `main` (so queued runs see the previous run's `state.json`), then commits `dune/state.json` |
| **Refresh** | daily 05:17 UTC; after a successful deploy; manual | Executes the queries, then checks the first metric against on-chain events |

## How a deploy works

1. **Identity.** Dune's `whoami` must return team `safe`; otherwise the deploy stops.
2. **Protected dashboards.** The deploy reads `safe/safenet-beta` with all its visualizations and queries, and fingerprints them. Any of those IDs appearing in the plan is an error, even with `--force`. The deployer also refuses to write to them. After the deploy, the fingerprint must be unchanged. If the Beta dashboard cannot be read, the deploy stops rather than run unprotected. The Beta IDs are recorded in `dune/state.json` under `protected`.
3. **Plan.** Each resource in `dune/` is matched to Dune by its ID in `dune/state.json`. If there is no recorded ID, the deployer looks for an existing resource before creating one:
   - queries by name with the `safenet-analytics` tag;
   - visualizations by name on their query;
   - the dashboard by `safe/<slug>`.

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

5. **Apply** in this order: queries → visualizations → dashboard → removals. After each write the deployer reads the resource back from Dune and stores two fingerprints in `dune/state.json`: one of the GitHub configuration and one of Dune's copy. Comparing Dune's copy with the stored fingerprint is how later deploys detect direct edits. State is saved even if the deploy fails partway.

Dune's API has no versioning or locking for updates, so the check and the write are separate requests. An edit made in Dune in the seconds between them is overwritten.

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

## What is managed

- **Queries:** name, description, SQL, parameters, tags (plus the `safenet-analytics` tag), privacy.
- **Visualizations:** name, type, description, options. Options are Dune's chart settings as JSON; see [adding-a-metric.md](adding-a-metric.md).
- **Dashboard:** name, slug, privacy, tags, text widgets and their positions, visualization widgets and their positions.

Not managed: dashboard parameter widgets, query schedules set in the Dune UI, materialized views. The dashboard must not have parameter widgets; a parameter widget added in Dune shows up as a conflict.
