import assert from "node:assert/strict";
import { test } from "node:test";
import { addressUrl, explorerBaseSql, safeTxUrl, txUrl } from "../src/links.ts";

const SAFE = "0xC89Ae48382edc81287AcEf0881E88DEacAD58348";
const HASH = `0x${"ab".repeat(32)}`;

test("addresses and transactions link to the explorer of their chain", () => {
  assert.equal(addressUrl(1, SAFE), `https://etherscan.io/address/${SAFE.toLowerCase()}`);
  assert.equal(addressUrl(100, SAFE), `https://gnosisscan.io/address/${SAFE.toLowerCase()}`);
  assert.equal(addressUrl(42161, SAFE), `https://arbiscan.io/address/${SAFE.toLowerCase()}`);
  assert.equal(txUrl(137, HASH), `https://polygonscan.com/tx/${HASH}`);
});

test("unknown chains get no link", () => {
  assert.equal(addressUrl(999, SAFE), null);
  assert.equal(txUrl(999, HASH), null);
  assert.ok(!explorerBaseSql("c").includes("999"));
  assert.match(explorerBaseSql("c"), / end$/); // no else branch: null for unknown chains
});

test("Safe transaction hashes link to the Safenet explorer transaction view", () => {
  assert.equal(safeTxUrl(100, HASH.toUpperCase().replace("0X", "0x")), `https://safenet-explorer.eth.limo/#/safeTx?chainId=100&safeTxHash=${HASH}`);
});
