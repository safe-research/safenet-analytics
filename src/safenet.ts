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
  // Sentinel votes and payouts (SentinelOracleCommitments.sol, SentinelOracleRequests.sol)
  Committed: {
    signature: "Committed(bytes32,address,uint96)",
    topic0: "0x45acbf2626c7d2bd97eb2142a43d392e8f3364c9e140b3d022446155491819d6",
  },
  Revealed: {
    signature: "Revealed(bytes32,address,bool,uint96,string)",
    topic0: "0xd2cdead965dbd376703d9a79240f31f1228055ab42384b68353332fcd2af939a",
  },
  Claimed: {
    signature: "Claimed(bytes32,address,uint96,uint96)",
    topic0: "0x006f1d9d8ec7f5d7941e2363561ba0f1da911361b351d007f9b448d557e39e86",
  },
  // Governance (SentinelMap.sol, SentinelOracle.sol, BondConfig.sol); changes apply after a delay
  SentinelScheduled: {
    signature: "SentinelScheduled(address,uint256)",
    topic0: "0xce737c23e8e6ca890064e37caf80069010b1f755c3fae1708dd03974cc20967d",
  },
  SentinelRemoved: {
    signature: "SentinelRemoved(address)",
    topic0: "0x8e7ac62951d0ff2590efb434e0adfbb6b9c0f784993a523c48b42751bab6c5e8",
  },
  FeeScheduled: {
    signature: "FeeScheduled(uint96,uint64)",
    topic0: "0xdef70574d1d359737ee26a27f066606f6d82fa51e3698f243d987958ec6fdc1c",
  },
  DaoFeeShareScheduled: {
    signature: "DaoFeeShareScheduled(uint24,uint64)",
    topic0: "0xb6b8950d378d599036f40812984d24677cfeb9805467d2997651e3fdab8b9b77",
  },
  ProtocolFundsReceiverScheduled: {
    signature: "ProtocolFundsReceiverScheduled(address,uint64)",
    topic0: "0xd1eff884ebee7603c09e5563e22dfbb73c07549053cfe8ef14c1c95fc18ab70b",
  },
  BondConfigScheduled: {
    signature: "BondConfigScheduled(uint32,uint32,uint64)",
    topic0: "0xc7a39a5cff0bd7a6c707ae62778c7253bd05c8e0bcfdf9d4b0d74044ecba46a1",
  },
  // ERC-20 and Safe events read for fee flows and Guard status
  Transfer: {
    signature: "Transfer(address,address,uint256)",
    topic0: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  },
  // SAFE rewards distributor on Ethereum (CumulativeMerkleDrop, REWARDS_DISTRIBUTOR below). The
  // misspelling "Merkel" is the contract's own.
  RewardsClaimed: {
    signature: "Claimed(address,uint256)",
    topic0: "0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a",
  },
  MerkelRootUpdated: {
    signature: "MerkelRootUpdated(bytes32,bytes32)",
    topic0: "0x936fd71fceff3b4f98f4935ac269e4f94b4b25e3e38c519d3ff3db222a27117a",
  },
  // Safe GuardManager. 1.3.0 logs the guard in data, 1.4.1 and later as topic1; topic0 is the same.
  ChangedGuard: {
    signature: "ChangedGuard(address)",
    topic0: "0x1151116914515bc0891ff9047a6cb32cf902546f83066499bcf8ba33d2353fa2",
  },
  // SafenetGuard constructor (ISafenetGuard.sol); identifies guard deployments on any chain.
  EpochInitialized: {
    signature: "EpochInitialized(uint64,(uint256,uint256))",
    topic0: "0x07350219757b951e219da92d6cfcfbe2db9d097ed40b7aafb4ba3ca85d27143b",
  },
} as const;

// Sentinel Oracle money (docs/configuration.md "Sentinel Oracle Configuration"). Amounts on chain
// are USDC.e base units.
export const FEE_TOKEN = { symbol: "USDC.e", address: "0x2a22f9c3b484c3629090feed35f17ff8f88f76f0", decimals: 6 } as const;
export const PROTOCOL_FUNDS_RECEIVER = "0x9d02bed59170cde96782ea9a9b17f9bcf4916127";
export const ARBITRATOR = "0xc89ae48382edc81287acef0881e88deacad58348";
export const DAO_FEE_SHARE_DENOMINATOR = 100_000;

// Sentinel Oracle calls (SentinelOracle.sol at 4ed5101). A late or invalid commit or reveal reverts
// without an event; safenet_sentinel_failed_calls finds these reverted calls in the traces.
export const ORACLE_FUNCTIONS = {
  commit: { signature: "commit(bytes32,bytes32)", selector: "0xe3ce094d" },
  reveal: { signature: "reveal(bytes32,bool,bytes32,string)", selector: "0x386a15bc" },
} as const;

// Sentinel membership (SentinelMap.sol): a scheduled Sentinel may commit from activeAtBlock, which
// is the scheduling block plus this delay; SentinelRemoved takes effect at once.
export const SENTINEL_GOVERNANCE_DELAY_BLOCKS = 51_840;

// Safe Foundation's SAFE rewards distributor on Ethereum ("Safenet Aegis Rewards",
// CumulativeMerkleDrop, verified on Etherscan and Sourcify). Rewards, Sentinel subsidies included,
// are published as Merkle proofs in safe-fndn/safenet-data assets/rewards (src/sentinel-rewards.ts).
export const REWARDS_DISTRIBUTOR = {
  chain: "ethereum",
  address: "0xe5139fc0fb8eae81e30d8a85c22e88c6757120f2",
  deployBlock: 24749707,
  deployDate: "2026-03-27",
} as const;
export const SAFE_TOKEN = { symbol: "SAFE", address: "0x5afe3855358e112b5647b952709e6165e1c1eeee", decimals: 18 } as const;

// Safenet Staking on Ethereum (safe-research/safenet contracts/src/Staking.sol at 4ed5101; not a
// proxy). One contract since 2026-03-04, used by Beta and production alike. Dune decodes it as
// safe_ethereum.Staking_evt_<Event> (docs/decoding.md); the topic0 values are for the RPC
// verification (scripts/verify-staking.ts). Definitions: docs/metrics/staking.md.
export const STAKING = {
  chain: "ethereum",
  address: "0x115e78f160e1e3ef163b05c84562fa16fa338509",
  deployBlock: 24585750,
  deployDate: "2026-03-04",
  decodedSchema: "safe_ethereum",
  events: {
    StakeIncreased: {
      signature: "StakeIncreased(address,address,uint256)",
      topic0: "0x835b6b05d09416215e9d638808ff68a75b79bb61e485812125e29950d722de5e",
      table: "safe_ethereum.Staking_evt_StakeIncreased",
    },
    WithdrawalInitiated: {
      signature: "WithdrawalInitiated(address,address,uint64,uint256)",
      topic0: "0xe77a460de02956e5b769dc1b86f3dedb6471a5a1480b18e5e60c025d3842a134",
      table: "safe_ethereum.Staking_evt_WithdrawalInitiated",
    },
    WithdrawalClaimed: {
      signature: "WithdrawalClaimed(address,uint64,uint256)",
      topic0: "0x6ee1930b1249317355da0ca051522261bf0c5287979ae2907223ac0a03017ba6",
      table: "safe_ethereum.Staking_evt_WithdrawalClaimed",
    },
    ValidatorUpdated: {
      signature: "ValidatorUpdated(address,bool)",
      topic0: "0x763b63b30e91c843bb39e4379603697003d3b7c1f192619cd782fa33bdc44396",
      table: "safe_ethereum.Staking_evt_ValidatorUpdated",
    },
    WithdrawDelayChanged: {
      signature: "WithdrawDelayChanged(uint256,uint256)",
      topic0: "0x675b321b815964c5762534007d46e2c87681ec7cca84b6fc979e979470ca522c",
      table: "safe_ethereum.Staking_evt_WithdrawDelayChanged",
    },
    TokensRecovered: {
      signature: "TokensRecovered(address,address,uint256)",
      topic0: "0x401f439d865a766757ec78675925bd67198d5e78805aa41691b34b5d6a6cbbe6",
      table: "safe_ethereum.Staking_evt_TokensRecovered",
    },
  },
} as const;

// Consensus.ValidatorStakerSet(address indexed validator, address staker) on the production
// Consensus (Gnosis Chain): the Ethereum account that puts up the validator's own stake
// (safenet docs/configuration.md "Staking"). Self-stake is this account's stake on its validator.
export const VALIDATOR_STAKER_SET = {
  signature: "ValidatorStakerSet(address,address)",
  topic0: "0xf0a005469b11e09422034ffe29da663a2969918f3663a27fae9fd5eed38778bb",
} as const;

// Start of production in the continuous staking history: the production Consensus deployment on
// Gnosis Chain (PRODUCTION.consensus.deployBlock, mined at this UTC time). Staking before it backed Beta.
export const PRODUCTION_START_TIME = "2026-10-07 13:51:55";

// EIP-712 domain separator of the production Consensus: keccak256(abi.encode(
// keccak256("EIP712Domain(uint256 chainId,address verifyingContract)"), 100, Consensus)).
// Equals Consensus.domainSeparator() on chain. A SafenetGuard bound to production stores it.
export const CONSENSUS_DOMAIN_SEPARATOR = "0x0a60fd26a8c4c3ecdbc033b1ebaf0af39dacc9965079bd37b21f4af2251fb097";

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
  { name: "Staking", chain: "ethereum", address: STAKING.address },
  { name: "CumulativeMerkleDrop (SAFE rewards)", chain: "ethereum", address: REWARDS_DISTRIBUTOR.address },
] as const;
