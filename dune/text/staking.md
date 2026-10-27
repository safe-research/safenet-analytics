## Staking

SAFE staked toward Safenet validators in the [Staking contract](https://etherscan.io/address/0x115E78f160e1E3eF163B05C84562Fa16fA338509) on Ethereum. Stakers deposit toward one validator and can withdraw in two steps. A **withdrawal request** removes the stake from **active stake** at once. After the withdrawal delay (2 days), the request becomes **claimable**, and the staker **claims** it, which completes the withdrawal. Requests cannot be cancelled, and the contract has no slashing or redelegation.

The **counters, outstanding withdrawals and stake by validator** are current state. The **history charts** cover all time: Beta (grey) until the production start on **2026-10-07**, then production (blue). The same contract served both. Amounts are in SAFE, without USD values or APY.
