### Sentinel definitions

- **Membership**: from the Sentinel Oracle's own events. A scheduled Sentinel may commit from its activation block (scheduling plus a delay of about 3 days). Removal takes effect immediately. Names come from [safenet-data](https://github.com/safe-fndn/safenet-data/blob/main/assets/sentinel-info.json) and are labels only. Unknown Sentinels show their address.
- **Eligible request**: the Sentinel was a member during the request's commit window. Joining or leaving changes only the requests made while it was a member.
- **Valid response**: a revealed vote. **Missing response**: committed, never revealed. **No commit**: abstained or offline. **Pending**: the commit or reveal window is still open.
- **Reverted calls**: late, early or invalid commits and reveals. They revert without an event and are read from transaction traces.
- **Coverage**: valid responses per request, including requests with none. Requests still in their response window are not counted yet.
- **Disputes**: Sentinel votes, the Oracle result (none when votes differ) and the arbitrator's ruling are separate. A ruling is not the Sentinels' consensus, and disputed transactions are never attested. Reasons and rulings are shown as recorded on chain.
- **Fee rewards (USDC.e)**: the winning revealers share each decided request's fee. *Accrued* when decided, *claimed* when paid, and the difference is *outstanding*.
- **SAFE subsidies**: as published by the Safe Foundation for the Ethereum rewards distributor. The earnings table shows one amount per address for every reward type. Nothing is estimated, and *no allocation published* is not 0.
- **Bonds (USDC.e)**: each commit locks the request's bond until the Sentinel claims. *Available* is the USDC.e in the Sentinel's own account. A slash applies to a missing response, if another Sentinel revealed, or to a revealed vote that lost a ruled dispute. It is confirmed by the Sentinel's claim.
- **Realized APR**: per completed two-week reward period, (fee rewards − slashes + the published Sentinel grant in SAFE × the SAFE/USD price of the period's last day) ÷ the average USDC.e capital × 365/14. Capital is *locked* bonds in the oracle, or *locked + available* in the Sentinel's own account, weighted by the seconds held. USDC.e counts as 1 USD. It is non-compounded and historical, not a projection. The SAFE price is the only USD value on this dashboard.

[Full definitions, sources and limitations](https://github.com/safe-research/safenet-analytics/blob/main/docs/metrics/sentinels.md)
