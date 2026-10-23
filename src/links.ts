// Links for addresses and transaction hashes shown on the dashboards.
//
//   - Onchain addresses and transaction hashes link to the block explorer of their chain.
//   - Safe transaction hashes (safeTxHash) link to the Safenet explorer's transaction view, which
//     shows the Safenet proposals, checks and attestations of that Safe transaction.
//
// The SQL in dune/queries/safenet_events builds the URLs with the CASE expressions generated here;
// test/links.test.ts checks that it uses exactly these.

export const EXPLORERS: Record<number, string> = {
  1: "https://etherscan.io",
  100: "https://gnosisscan.io",
  137: "https://polygonscan.com",
  42161: "https://arbiscan.io",
};

// Production Safenet explorer (safe-research/safenet-beta-wallet-extension src/constants.ts,
// production network). It uses hash routing; the route is explorer/src/routes/safeTx.tsx.
export const SAFENET_EXPLORER = "https://safenet-explorer.eth.limo";

export const addressUrl = (chainId: number, address: string) =>
  EXPLORERS[chainId] ? `${EXPLORERS[chainId]}/address/${address.toLowerCase()}` : null;

export const txUrl = (chainId: number, hash: string) => (EXPLORERS[chainId] ? `${EXPLORERS[chainId]}/tx/${hash.toLowerCase()}` : null);

export const safeTxUrl = (chainId: number, safeTxHash: string) =>
  `${SAFENET_EXPLORER}/#/safeTx?chainId=${chainId}&safeTxHash=${safeTxHash.toLowerCase()}`;

// SQL expression for the explorer base URL of a chain id column; null for unknown chains.
export function explorerBaseSql(chainIdColumn: string): string {
  const whens = Object.entries(EXPLORERS)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([id, url]) => `when ${id} then '${url}'`)
    .join(" ");
  return `case ${chainIdColumn} ${whens} end`;
}

// SQL expressions for the URL columns of safenet_events. `||` with null yields null, so unknown
// chains get no link and dashboards show the plain value.
export const LINK_SQL = {
  safe_url: `${explorerBaseSql("safe_chain_id")} || '/address/0x' || lower(to_hex(safe_address))`,
  tx_url: `'${EXPLORERS[100]}/tx/0x' || lower(to_hex(tx_hash))`,
  safe_tx_url: `'${SAFENET_EXPLORER}/#/safeTx?chainId=' || cast(safe_chain_id as varchar) || '&safeTxHash=0x' || lower(to_hex(safe_tx_hash))`,
} as const;
