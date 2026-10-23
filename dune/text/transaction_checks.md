### What is counted

Production contracts only, by UTC day of each event:

- **Requests**: transactions proposed for checking (`TransactionProposed` on the production Consensus with the production Sentinel Oracle).
- **Completed checks**: requests that received a verdict, either approved or denied, by the Sentinels or after a dispute (`OracleResult`, `DisputeResolved`). Timeouts are not completed checks.
- **Attestations**: validator threshold signatures on approved transactions (`TransactionAttested`).

Requests for Safes on chains the Charter does not cover (anything other than Ethereum, Gnosis Chain and Arbitrum One) are likely tests; they are left out here and counted separately in the query results.

[Definition, sources and limitations](https://github.com/safe-research/safenet-analytics/blob/main/docs/metrics/transaction-checks.md)
