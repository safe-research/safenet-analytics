## Sentinels

Sentinels check every request and vote on it in two steps: they **commit** a hidden vote, then **reveal** it. Only a revealed vote is a **valid response**, counted as *secure* or *insecure*. A committed vote that is never revealed is a **missing response**. It is not an abstention, and its bond is slashed. A Sentinel that does not commit at all leaves no trace on chain, whether it abstained or was offline, so this is shown as **No commit (abstain or offline)**.

**Participation rate** = valid reveals ÷ eligible requests. A request is eligible if the Sentinel was a member during its commit window (on-chain membership history). Requests whose response window is still open count as *pending*, in neither part of the rate. Counts cover requests for Safes on the Charter's networks, as in Network & revenue. Fee rewards and bonds are in **USDC.e**, subsidies in **SAFE**, and the two are never added together. *Status* and balances are as of now; everything else is history.
