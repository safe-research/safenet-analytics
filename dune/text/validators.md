## Validators

Validators sign Safenet attestations on Gnosis Chain as a threshold group. Each epoch (a few hours) gets a new signing group: its members form the **attestation set**. Staking happens separately, in the Ethereum [Staking contract](https://etherscan.io/address/0x115E78f160e1E3eF163B05C84562Fa16fA338509). A validator can be **registered for staking** without being in the attestation set, and the dashboard shows both.

**Signing participation** counts a validator's signature share only when it belongs to the completed signature. An aggregate attestation alone never counts for any one validator. Days or windows without an eligible ceremony show *n/a*, not 0%. Stake amounts follow the Staking section. *Now* panels are current state; the others are history. Amounts are in SAFE, without USD values or APY.
