# Adding a metric

1. **Define it first.** Write `docs/metrics/<name>.md` with:
   - what is counted;
   - which production contracts and events are used, with sources;
   - how test traffic is handled;
   - known limitations.

   Use production contracts only (see [transaction-checks.md](metrics/transaction-checks.md#sources)), and do not reuse Beta definitions. Beta ran different contracts.
2. **Add the query** as `dune/queries/<key>/query.sql`. `<key>` is lowercase with underscores and must stay stable: renaming the directory creates a new Dune query and archives the old one. Use [Dune's SQL](https://docs.dune.com/query-engine/overview). Read events from [`safenet_events`](../dune/queries/safenet_events/query.sql) with `{{query:safenet_events}}` instead of decoding raw logs again ([decoding.md](decoding.md)); add new event types there. References to other managed queries use the same `{{query:<key>}}` form and are remapped per environment ([deployment.md](deployment.md#query-references)). Put constants such as addresses and topic0 values in [`src/safenet.ts`](../src/safenet.ts), and add a test like `test/safenet.test.ts` that checks the SQL uses them. Use the URL columns of `safenet_events` for links, and `safenet_participant_labels` for participant names.
3. **Describe it** in `dune/queries/<key>/query.yaml`:

   ```yaml
   name: "Safenet: <title>"        # unique; shown in Dune
   description: >
     What it measures, and where it is defined (docs/metrics/<name>.md).
   private: false
   tags: [safenet]
   refresh: daily                  # or: none
   performance: medium             # or: large
   parameters: []                  # queries with parameters cannot be scheduled
   visualizations:
     <viz_key>:
       name: <chart title>         # unique per query
       type: chart                 # chart, table, counter, pivot, ...
       options: { ... }            # Dune visualization options, see below
   ```

4. **Place it** on its section's dashboard, `dune/dashboards/<section>.yaml`, as `visualization: <key>/<viz_key>` with a `position` on the 6-column grid (`row`, `col`, `size_x`, `size_y`). Only headline numbers and key charts also go on the overview (`dune/dashboards/overview.yaml`); the same visualization may be placed on both. Text goes in `dune/text/*.md` and is referenced with `text_file`, or inline with `text`. Link to another dashboard with `{{dashboard:<key>}}`, never with a hard-coded `dune.com` URL: the link then points to the preview dashboard in a preview and to production in production.
5. **Check locally:** `npm test && npm run validate`. Validation catches overlapping widgets, unknown references, undeclared `{{parameters}}`, chart columns that do not appear in the SQL, visualizations that are on no production dashboard, unknown or hard-coded dashboard links, and dashboards that do not link to all the others.
6. **Open a pull request.** CI plans the production deployment, runs the new SQL on Dune and deploys a private preview ([preview.md](preview.md)); check the pull request comment. After merging, *Deploy* creates the query and chart, and *Refresh* runs the query.
7. **Verify** the numbers against the underlying events, as `scripts/verify-transaction-checks.ts` does for the first metric. Record the result in the metric's doc.

## Visualization options

The Dune API takes the same options JSON as the Dune UI, but Dune does not publish a schema. The shapes below come from the official CLI (`dune viz create --help`). Column names must match the query's result columns.

- **Line, column, area or scatter chart** (`type: chart`):

  ```yaml
  options:
    globalSeriesType: line          # line, column, area, scatter
    sortX: true
    legend: { enabled: true }
    # series: { stacking: normal }  # stacked; omit for side by side
    xAxis: { title: { text: Day } }
    yAxis: [{ title: { text: Count } }]
    columnMapping: { day: x, requests: y }
    seriesOptions:
      requests: { type: line, yAxis: 0, zIndex: 0, name: Requests }
  ```

- **Counter:** `type: counter`, options `{ counterColName: requests, rowNumber: 1, stringDecimal: 0, counterLabel: Requests }`.
- **Table:** `type: table`, options `{ itemsPerPage: 25, columns: [{ name: day, title: Day, type: normal, alignContent: left, isHidden: false }] }`.

- **Pivot table:** `type: pivot`, options in Dune's own format:

  ```yaml
  rows: [{ column_name: sentinel }]
  columns: [{ column_name: day }]
  values: [{ column_name: participation_pct, agg_type: AVG, numberFormat: "0.0" }]
  ```

  Dune's CLI documents no pivot format. This is what Dune's pivot editor stores, read back from a pivot made in the UI. Do **not** use the PivotTable.js settings (`cols`, `vals`, `rendererName`, `aggregatorName`, `controls`). Dune ignores them and its renderer then fails on the missing `columns` and `values`. Every page showing the widget crashed with `Cannot read properties of undefined (reading 'map')`, as dune.com/safe/safenet did in October 2026. Validation rejects that format. Dune's pivot has no heatmap colouring.

To copy settings from a chart built in the Dune UI, run `npm run dune -- pull` for a managed query and copy the options from `dune/.remote/<key>/query.yaml`. For a visualization that is not managed yet, `npm run dune -- diagnose` (or the preview comment) lists the stored options of every visualization on the dashboards' queries that GitHub does not manage.
