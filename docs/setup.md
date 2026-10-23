# Setup

## One-time setup

1. **Create a Dune API key for the `safe` team.** In Dune, switch to the `safe` team context, open *Settings → API*, and create a key with **Read/Write** scope.
   - It must be a team key. Dune assigns new queries and dashboards to the account that owns the key. Deploys check the key with Dune's `whoami` endpoint and refuse any key that is not a key of team `safe` (configured in `dune/project.yaml`).
   - The Dune plan must include API query management. Dune lists the queries endpoints under its paid API plans.
2. **Add the key to GitHub** as the repository secret `DUNE_API_KEY` (*Settings → Secrets and variables → Actions*).
3. **Optional:** add `GNOSIS_RPC_URL` as a secret to use a private Gnosis Chain RPC for verification instead of `https://rpc.gnosischain.com`.
4. **Let the Deploy workflow push.** After each deploy, the workflow commits `dune/state.json` (the resource IDs) to `main` using `GITHUB_TOKEN`. If `main` is protected, allow GitHub Actions to bypass the rule, or deploys succeed but fail to record IDs. A later deploy still finds the resources by name and slug and records them then; see [deployment.md](deployment.md).
5. **Run the first deployment:** *Actions → Deploy → Run workflow* on `main`, first with *dry run*, then without. Alternatively, merging any change under `dune/` deploys.
6. **Check the first deploy:**
   - The deploy log shows `Dune account: safe (team_…)` and records the Beta dashboard's IDs in `dune/state.json` under `protected`.
   - `https://dune.com/safe/safenet` exists and shows the intro, the chart and the definitions.
   - The *Refresh* workflow ran after the deploy, and its verification step reports `"mismatches": []`.
   - The layout looks as intended. The 6-column grid in `src/config.ts` is taken from the official CLI's examples and is not documented by Dune. If widths look wrong, adjust `GRID_COLUMNS` and the positions in `dune/dashboard.yaml`.

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
