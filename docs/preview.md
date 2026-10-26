# Previews

Every pull request from a branch of this repository is deployed to a **private preview dashboard** on Dune before it is merged. Production, [dune.com/safe/safenet](https://dune.com/safe/safenet), only changes when the pull request is merged to `main`.

## Lifecycle

1. **Open a pull request.** The *Preview* workflow then:
   1. Runs the checks (typecheck, tests, offline validation).
   2. Prints the **production plan**: a dry run of what merging would change in production. It makes no writes.
   3. Deploys the pull request to its preview track. Resources are created private, or updated in place.
   4. Executes the preview queries whose SQL changed, within the cost caps. Queries whose SQL, with every referenced query inlined, equals production's on `main` are not executed (`run-preview --baseline`), so a new track runs only the section under review. Their preview panels stay empty, production shows them, and their reconciliation step is skipped. *Run workflow* with *force run* executes everything.
   5. Recounts the request metric from Gnosis Chain logs over exactly the block range of the preview result, and compares every day and column, the counter and the sum of the daily bars. The Network & revenue and Sentinels sections are recounted the same way (`verify:network-revenue`, `verify:sentinels`), with representative cases to check on the Safenet explorer. The Staking section is replayed from Ethereum logs and checked against the contract's state at the same block and against transaction receipts (`verify:staking`).
   6. Renders images of the panels from the preview results, including the Sentinel and Staking panels.
   7. Posts or updates one comment on the pull request with the private URL, the deployed commit, the images, the reconciliation, the preview resource IDs and the production plan.
2. **Review.** Open the preview URL while signed in to Dune with access to the `safe` team. Each push to the pull request redeploys the same preview resources. The banner at the top names the pull request and commit.
3. **Merge.** *Deploy* updates production in place (same IDs and URL), and *Refresh* executes the production queries and checks the metric against on-chain events. See [deployment.md](deployment.md).
4. **Verify production**, then **clean up** the preview track when its work is finished, not after every pull request. See [Cleanup](#cleanup).

## Tracks

A track is a set of preview resources. `dune/preview.yaml` on the branch names its track:

| Track | Dashboard | Queries |
| --- | --- | --- |
| `default` | *Safenet — Preview*, `safe/safenet-preview` | `[Preview] Safenet: …` |
| `<name>`, e.g. `staking-validators`, `beta-replacement` | *Safenet — Preview (`<name>`)*, `safe/safenet-preview-<name>` | `[Preview <name>] Safenet: …` |

Pull requests on the same track share its resources, and the last deployment wins. Work packages that run in parallel set their own track on their branch, so they never overwrite each other. The eventual replacement of the Beta dashboard is previewed on its own track (`beta-replacement`). Beta itself, [safe/safenet-beta](https://dune.com/safe/safenet-beta), stays protected: no deploy or cleanup writes to it.

Preview queries are tagged `safenet-preview` and `safenet-preview-<track>`. Production queries carry `safenet-analytics` instead, so lookups by name and tag can never confuse the two.

## What keeps production safe

- **Separate resources.** Previews have their own queries, visualizations and dashboard. Their IDs are recorded in `previews/<track>.json` on the `dune-preview-state` branch, never in `dune/state.json`.
- **Production IDs are guards.** A preview deploy reads `dune/state.json` from `main`. If any preview step would resolve to, write to or reference (`query_<id>`) a production query, visualization or dashboard, the deploy stops. Beta's resources are guarded the same way.
- **References are remapped.** Queries refer to each other as `{{query:<key>}}` (see [adding-a-metric.md](adding-a-metric.md)). In a preview this renders to the preview query's ID, in production to the production ID.
- **Production is only read.** The production plan in the comment is a dry run that fails if it makes a write request.
- **Private or nothing.** Preview queries and the dashboard are requested private and read back after every write. If Dune rejects private resources (for example because of a plan limit) or creates them public, the deploy stops and reports it. A query that came out public is archived at once. The deployer never continues with public previews.
- **Forks get nothing.** Pull requests from forks are skipped; the job runs only when the head branch is in this repository. Secrets are therefore never available to untrusted code, and `pull_request_target` is not used. A manual run checks the same for the pull request it is given. Anyone who can push a branch here can already change the workflows, so branch authors are trusted.
- **One deployment at a time.** All preview runs share the `dune-preview` concurrency group and are never cancelled halfway. A run whose commit is no longer the pull request head stops before deploying, so a preview never mixes revisions. GitHub keeps only the newest *pending* run of a group: if several pull requests push at once, an older pending run may be superseded. Rerun it with *Actions → Preview → Run workflow* and the pull request number.

Edits made in the Dune UI to preview resources are overwritten by the next preview deploy, because previews are disposable. Production keeps its conflict detection.

## Cost

- Deploys never execute queries. After a deploy, only queries shown on the dashboard run, and only if their SQL, including every referenced query, changed since their last preview execution.
- Caps in `dune/preview.yaml`: performance tier, timeout (a longer execution is cancelled), credits per execution and per run. The run fails when a cap is exceeded.
- Preview queries have no schedule: *Refresh* never selects them, and the deployer sets no Dune schedule.
- The data is bounded by the queries themselves: production contracts only, from their deploy block, with partition pruning from 2026-10-07.
- The production plan reads Dune but runs nothing. The Validate workflow's SQL check still runs changed SQL once per push, as before.

## Images

The preview dashboard is private, and CI cannot sign in to Dune, so a browser in CI cannot capture it. `scripts/render-preview.ts` instead draws the panels (counters, charts with their values as a table, and tables) from the preview's query results, fetched through the API. Each image says it is rendered, not a Dune screenshot. The images are kept on the `dune-preview-state` branch under `screenshots/<track>/<commit>/` and uploaded as the `preview` artifact. For the Dune rendering itself, open the preview URL.

## Setup

One-time steps, done in GitHub and Dune by someone with admin access:

1. **Secret.** The workflow uses the repository secret `DUNE_API_KEY` (the `safe` team key, see [setup.md](setup.md)) through the `dune-preview` environment. GitHub creates the environment on the first run. Optionally add *required reviewers* to it under *Settings → Environments → dune-preview* to approve each preview deployment by hand.
2. **Branch.** The workflow creates and pushes the `dune-preview-state` branch with `GITHUB_TOKEN`. If branch rules cover all branches, exempt `dune-preview-state` or allow GitHub Actions to push to it.
3. **Private resources.** The `safe` team's Dune plan must allow private queries and dashboards. The first preview run shows whether it does: it either succeeds or stops with Dune's error.
4. **Folder.** The verified Dune API endpoints ([dune-api.md](dune-api.md)) cannot assign folders. After the first successful run, move the resources into the existing **Safenet** folder once. In Dune, switch to the `safe` team, open the *Safenet* folder in the library, and use *Add* or *Move* to add *Safenet — Preview* and the `[Preview] Safenet: …` queries. Later runs update the same resources, so this is needed once per track. Do the same for production's new queries after the first production deploy of this change.
5. **Access.** Open the preview URL from the pull request comment while signed in to Dune with an account that is a member of the `safe` team. Private team resources are visible to team members only.

## Cleanup

Clean up a track after its last pull request is merged and the result is verified in production. Run *Actions → Preview cleanup → Run workflow* on `main` with the track, first with *dry run* (the default), then without. Locally: `npm run dune -- cleanup-preview --track <track> [--dry-run]`, with the track's state file at `dune/.preview/<track>.json`.

The cleanup:

1. **Selects candidates.** A resource qualifies only if all of these hold:
   - it is recorded in the track's preview state;
   - it is a private query with the track's tag, a visualization of such a query, or the private preview dashboard (slug `safenet-preview…`) showing only such visualizations;
   - it is neither a production resource nor part of Beta.
2. **Checks dependencies.** It reads every other query of the team. If any of them reads a candidate (`query_<id>`), it stops and changes nothing, as it does if any recorded resource fails the conditions above.
3. **Removes, in order:**
   1. Empties the dashboard, renames it `[Archived] …` and archives it. The archive endpoint is unverified; if the API has none, the dashboard stays private and empty, and the run lists the UI step to delete it.
   2. Deletes the preview visualizations.
   3. Archives the preview queries. Archiving can be undone in Dune.
4. **Reports schedules.** Preview queries never get schedules from this repository. If Dune reports a schedule set in its UI, the run names it so it can be checked.
5. **Clears the mappings.** It removes `previews/<track>.json` and `screenshots/<track>/` from `dune-preview-state`.

The next pull request on the track starts a new preview with new IDs. Shared and production resources are listed as kept and are never touched.

## Rollback

- **A preview** needs no rollback: push a fix, or rerun the workflow for an earlier pull request.
- **Production** is rolled back by reverting the merge on `main`; see [restoring.md](restoring.md).
