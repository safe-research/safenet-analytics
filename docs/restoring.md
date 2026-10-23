# Restoring a previous configuration

Every deployed state of the dashboard is a commit on `main`. Restoring means deploying an older version of `dune/` again. Resource IDs and the dashboard URL do not change, because the deployer updates the existing resources in place.

## Revert a change (preferred)

```sh
git revert <commit>                 # or a merge commit: git revert -m 1 <merge-commit>
git push origin HEAD:revert-<topic> # open a pull request and merge it
```

The merge deploys the reverted configuration. If someone edited the dashboard in Dune in the meantime, the deploy stops with a conflict; see [deployment.md](deployment.md#resolving-a-conflict).

## Restore everything to an older commit

```sh
git switch -c restore-<date> origin/main
git rm -rq dune/queries dune/text   # drops queries and text added after <good-commit>
git checkout <good-commit> -- dune/queries dune/dashboard.yaml dune/text dune/project.yaml
git commit -m "Restore Dune configuration from <good-commit>"
```

Open a pull request; merging it deploys. **Do not restore `dune/state.json`.** It must keep the current IDs, and the Deploy workflow maintains it.

## Undo removals

- **Queries** removed from `dune/` are archived, not deleted. Restoring their directory does not unarchive them: the state entry was dropped and archived queries are skipped when looking up existing ones, so the deployer creates a new query. To keep the old ID instead, unarchive it in Dune first. The deployer then finds it by name and managed tag and adopts it if it matches GitHub, or reports a conflict if it does not.
- **Visualizations** removed from `dune/` are deleted in Dune. Restoring their config creates them again with new IDs; the dashboard is updated to use them.

## Recover lost IDs

If `dune/state.json` is lost or reset, the next deploy finds the existing query, visualizations and dashboard by name and slug. It adopts them if they match GitHub, or reports conflicts if they differ, and records their IDs again. It creates nothing twice. A visualization's options only need to be contained in Dune's copy (Dune may add defaults); the other fields must match exactly.
