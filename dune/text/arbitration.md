## Arbitration

When revealed Sentinel votes disagree, the Oracle **freezes** the request (`DisputeTriggered`, emitted by `finalize`) and the Security Council's arbitrator decides. Arbitration ends with a **ruling**, secure or insecure (`DisputeResolved`), as **out of scope** (`DisputeOutOfScope`, no ruling), or with an **arbitration timeout** (`ArbitrationTimedOut`, no ruling, after about 28 days).

- **Arbitration rate**: requests that entered arbitration ÷ requests. Counts requests proposed in the window on the Charter's chains, as in Network & revenue, each once and in its latest state. Requests still being voted on can still be disputed, so recent rates can rise.
- **Resolution time**: from the freeze to the ruling. Only ruled cases count, selected by ruling time. Out-of-scope and timed-out cases are not rulings and are listed separately. Open cases are excluded.
- **Open**: frozen without an outcome yet. Its age is as of the latest refresh.

[Definitions and sources](https://github.com/safe-research/safenet-analytics/blob/main/docs/metrics/sentinels.md#arbitration-rate-and-resolution-time)
