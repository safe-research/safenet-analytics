### Definitions

- **Request**: a transaction submitted for checking, identified by its Sentinel Oracle request ID. Each request pays the fee. A Safe transaction submitted again in a later epoch is a new request but the same **unique Safe transaction**.
- **Sentinel response**: a revealed Sentinel vote. A committed vote that is never revealed is a missing response.
- **Completed result**: a request with a verdict, either from the Sentinels or from the arbitrator after a dispute. Timeouts, missing responses and pending requests are never completed and never counted as secure.
- **Unanimous secure / insecure**: every revealed vote approved, or every revealed vote denied. One revealed vote is enough; there is no quorum.
- **Disputed**: revealed votes disagreed. The request stays *disputed* after the arbitrator's ruling (secure, insecure, or no ruling), and a ruled dispute counts as a completed result. Disputed transactions are never attested.
- **Timed out**: no Sentinel revealed a vote. This is final, the fee is refunded, and it is not a result. **Pending**: not decided yet.
- **Attestation**: the validators' threshold signature on an approved, undisputed request.
- **Safes with completed checks** vs **Safes with requests**: unique Safes per network whose requests received a verdict, vs all Safes that requested one.
- **Guard-enabled Safes**: Safes whose current transaction guard is a SafenetGuard bound to the production Consensus. Using checks without the guard does not count. Shown as *not available* while no such guard is deployed.
- **Gross fees collected**: fees actually paid into the Sentinel Oracle, as recorded on each request. Refunds are shown separately and do not reduce it.
- **Network**: the network of the checked Safe, not Gnosis Chain where the Safenet contracts run.
- Flows are counted on the UTC day they happen. The result breakdown counts requests by proposal day in their **current** status.
- Origin (for example Safe{Wallet}) is not recorded on chain and is not shown.

[Full definitions, sources and limitations](https://github.com/safe-research/safenet-analytics/blob/main/docs/metrics/network-and-revenue.md)
