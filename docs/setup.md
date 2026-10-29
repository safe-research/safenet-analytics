# Setup

## One-time setup

1. **Create a Dune API key for the `safe` team.** In Dune, switch to the `safe` team context, open *Settings → API*, and create a key with **Read/Write** scope.
   - It must be a team key. Dune assigns new queries and dashboards to the account that owns the key. Deploys check the key with Dune's `whoami` endpoint and refuse any key that is not a key of team `safe` (configured in `dune/project.yaml`).
   - The Dune plan must include API query management. Dune lists the queries endpoints under its paid API plans.
2. **Add the key to GitHub** as the repository secret `DUNE_API_KEY` (*Settings → Secrets and variables → Actions*).
3. **Optional:** add `GNOSIS_RPC_URL` as a secret to use a private Gnosis Chain RPC for verification instead of `https://rpc.gnosischain.com`.
4. **Let the Deploy workflow record resource IDs on `main`.** After each deploy, the workflow commits `dune/state.json` to `main`. `main`'s ruleset only accepts pull requests that passed the preview and the status checks, and the workflow's `GITHUB_TOKEN` cannot bypass a ruleset. So the deploy pushes over SSH with a **deploy key** that the ruleset lets through, as [safe-fndn/safenet-data](https://github.com/safe-fndn/safenet-data/blob/main/.github/workflows/update-data.yml) does. One-time setup, by a repository admin:
   1. **Create a key pair** without a passphrase: `ssh-keygen -t ed25519 -N "" -C "safenet-analytics deploy state" -f deploy-state`.
   2. **Add the deploy key.** Under *Settings → Deploy keys*, add `deploy-state.pub` with **Allow write access**.
   3. **Create the environment.** Under *Settings → Environments*, create `dune-production`, and under *Deployment branches and tags* allow `main` only. Add the secret `DEPLOY_STATE_SSH_KEY` with the contents of `deploy-state` (the private key). Only the Deploy job on `main` can read it. Then delete both files locally.
   4. **Let deploy keys bypass the ruleset.** Under *Settings → Rules → Rulesets*, open `main`'s ruleset and add *Deploy keys* to the *Bypass list*. The bypass covers every deploy key of the repository with write access, so keep this the only one.

   Commits pushed with a deploy key start workflows, but Deploy ignores changes to `dune/state.json` alone. Without the key, Deploy stops before deploying, with an error that points here. If recording ever fails anyway, the deploy has still happened: run *Deploy* again on `main`, and it finds the unrecorded resources by name and slug (`adopt`) and records them. Then run *Refresh* by hand, because Refresh follows only deploys started by a push. A query without a recorded ID fails the refresh, but every other query is still refreshed.
5. **Run the first deployment:** *Actions → Deploy → Run workflow* on `main`, first with *dry run*, then without. Alternatively, merging any change under `dune/` deploys.
6. **Check the first deploy:**
   - The deploy log shows `Dune account: safe (team_…)` and records the Beta dashboard's IDs in `dune/state.json` under `protected`.
   - `https://dune.com/safe/safenet` and the section dashboards exist, and every link between them works (the deploy log lists them under *Links*).
   - The *Refresh* workflow ran after the deploy, and its verification step reports `"mismatches": []`.
   - The layout looks as intended. The 6-column grid in `src/config.ts` is taken from the official CLI's examples and is not documented by Dune. If widths look wrong, adjust `GRID_COLUMNS` and the positions in `dune/dashboards/`.
   - Move new dashboards into the safe team's **Safenet** folder (one-time UI step; the API cannot assign folders, see [dune-api.md](dune-api.md)).

## Local use

Requires Node.js 22.18 or later (`.nvmrc`); Node runs the TypeScript sources directly.

```sh
npm ci
npm test                    # unit tests, including deploys against a fake Dune API
npm run validate            # offline checks of dune/
export DUNE_API_KEY=...     # a safe team key
npm run dune -- whoami
npm run plan                # dry run against Dune
npm run verify:transaction-checks
```

Deploy from CI rather than locally, so `dune/state.json` on `main` stays the record of what is deployed. If you do deploy locally, commit the updated `dune/state.json`.
