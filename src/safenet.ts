// Safenet production ("Aegis") contracts on Gnosis Chain and the events the metrics use.
// Sources for every value are listed in docs/metrics/transaction-checks.md.

export const GNOSIS_CHAIN_ID = 100;

export const PRODUCTION = {
  consensus: {
    address: "0xc855761d619f6002923507ce68b84d7689c2aa96",
    deployBlock: 48635843,
  },
  sentinelOracle: {
    address: "0x4f61b8832978e83b80d69551aef07557dbe41d03",
    deployBlock: 48635850,
  },
} as const;

// Safe chains covered by the Safenet Charter. Requests for Safes on other chains are
// reported separately as likely test traffic.
export const COVERED_SAFE_CHAINS = [1, 100, 42161] as const;

// Canonical Solidity signatures (custom types expanded to their ABI types) and topic0.
// test/safenet.test.ts recomputes every topic0 from its signature.
export const EVENTS = {
  TransactionProposed: {
    signature:
      "TransactionProposed(bytes32,bytes32,address,uint64,bytes,(uint256,address,address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256))",
    topic0: "0x47d867ce4d91d0487fa4d2ac80b13e7466ce53dd018a8eef564fc60c92b53d03",
  },
  TransactionAttested: {
    signature: "TransactionAttested(bytes32,bytes32,address,uint64,bytes32,bytes32,((uint256,uint256),uint256))",
    topic0: "0x1980afd018b6bb99a313d3b7a88274259621396f9b8acaa712ef114872977357",
  },
  NewRequest: {
    signature: "NewRequest(bytes32,address,uint96,uint96,uint24,uint96,uint64,uint64)",
    topic0: "0x8ec61272960f97d43d7f8f85ed630aa512818577f3d1e548e7627b06dbbbda86",
  },
  OracleResult: {
    signature: "OracleResult(bytes32,address,bytes,bool)",
    topic0: "0x7843c453c4f7442b00e1bf3873e741f18f3447e18a13304c58bef95efd311757",
  },
  DisputeTriggered: {
    signature: "DisputeTriggered(bytes32,uint64)",
    topic0: "0x86e8b85731e4787f033d85108356db1e068dea243be32d422e6dc5681ff49cc1",
  },
  DisputeResolved: {
    signature: "DisputeResolved(bytes32,uint8,uint128,string)",
    topic0: "0x7e739d167696b2e67be44f7ceb3afa7ad9e8ad5ee53d016de97ae7ab0b416a70",
  },
  DisputeOutOfScope: {
    signature: "DisputeOutOfScope(bytes32,string)",
    topic0: "0xe32b95dcf423c9ed3915554e30a0db65ad08358b5e5bdb1138c98dcb745dbe81",
  },
  ArbitrationTimedOut: {
    signature: "ArbitrationTimedOut(bytes32)",
    topic0: "0x5f19817b3ad988fdb5a7fb3f657a755e58a107bf47431574b7c516a6dc1551e6",
  },
  RequestTimedOut: {
    signature: "RequestTimedOut(bytes32)",
    topic0: "0xf1ca1e9147be737b04a2b018a79405f687a97de8dd8a2559bbe62357343af414",
  },
} as const;

// SentinelOracleRequest.State values used in DisputeResolved.outcome.
export const ORACLE_STATE = { RESOLVED_APPROVED: 3, RESOLVED_DENIED: 4 } as const;

// Production contracts that may be decoded on Dune (docs/decoding.md). `check-decoded` looks them
// up in Dune's contract tables. Addresses: safe-research/safenet docs/configuration.md.
export const DECODING_CANDIDATES = [
  { name: "Consensus", chain: "gnosis", address: PRODUCTION.consensus.address },
  { name: "SentinelOracle", chain: "gnosis", address: PRODUCTION.sentinelOracle.address },
  // Shared by production and the Aegis testnet; its events cannot be attributed to production alone.
  { name: "FROSTCoordinator", chain: "gnosis", address: "0xc6b34da4c99c043a093214d58423a8be39585b78" },
  { name: "Safenet7702Executor", chain: "gnosis", address: "0x4dfe88adf2d7c3fbd2e334ce820b9adfa541215c" },
  { name: "Staking", chain: "ethereum", address: "0x115e78f160e1e3ef163b05c84562fa16fa338509" },
] as const;
