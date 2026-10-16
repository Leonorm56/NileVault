/**
 * Wallet naming tests (root-cause fix for duplicate default names).
 *
 * Two defects are covered here:
 *   1. The restore path generated a default label from the registry *length*
 *      (`Wallet ${wallets.length + 1}`). Length shrinks when a wallet is
 *      deleted, so the next restore re-issued a name that was already in use.
 *   2. Duplicate labels rendered as two identical tiles. Two wallets can share
 *      a label legitimately (the registry's only unique key is the id), so the
 *      grid needs a display label that stays distinct.
 *
 * Both helpers are pure — no storage, no IPC — so this runs in plain node.
 *
 * Run: esbuild bundle + node (see package.json test:registry), or `npm test`.
 */

import assert from "node:assert/strict";

import {
  disambiguateLabels,
  uniqueWalletName,
} from "../src/renderer/lib/walletName.js";

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const w = (name, id = name) => ({ id, name });

async function run() {
  section("uniqueWalletName");

  await test("empty registry starts at Wallet 1", () => {
    assert.equal(uniqueWalletName([]), "Wallet 1");
  });

  await test("next free index after a clean run", () => {
    assert.equal(
      uniqueWalletName([w("Wallet 1"), w("Wallet 2")]),
      "Wallet 3",
    );
  });

  await test("deleting a wallet causes no collision (the reported bug)", () => {
    // Registry held 1,2,3; Wallet 2 was deleted. `length + 1` would return
    // "Wallet 3" here — a duplicate. The allocator must fill the gap instead.
    const afterDelete = [w("Wallet 1"), w("Wallet 3")];
    const name = uniqueWalletName(afterDelete);
    assert.equal(name, "Wallet 2");
    assert.ok(
      !afterDelete.some((wallet) => wallet.name === name),
      "must not re-issue an existing name",
    );
  });

  await test("hand-named wallets do not block index 1", () => {
    assert.equal(uniqueWalletName([w("Main"), w("188")]), "Wallet 1");
  });

  await test("a hand-typed 'Wallet N' still reserves its index", () => {
    assert.equal(uniqueWalletName([w("Main"), w("Wallet 5")]), "Wallet 1");
    assert.equal(
      uniqueWalletName([w("Wallet 1"), w("Main"), w("Wallet 2")]),
      "Wallet 3",
    );
  });

  await test("an already-duplicated registry still yields a free index", () => {
    // Legacy data may already contain a collision; the allocator must not
    // compound it.
    assert.equal(
      uniqueWalletName([w("Wallet 1", "a"), w("Wallet 1", "b")]),
      "Wallet 2",
    );
  });

  await test("surrounding whitespace still counts as taken", () => {
    assert.equal(uniqueWalletName([w("  Wallet 1  ")]), "Wallet 2");
  });

  await test("malformed entries are ignored, never thrown on", () => {
    assert.equal(uniqueWalletName([null, {}, w(""), undefined]), "Wallet 1");
    assert.equal(uniqueWalletName(undefined), "Wallet 1");
  });

  section("disambiguateLabels — the two '188' tiles");

  await test("unique labels pass through untouched", () => {
    const labels = disambiguateLabels(
      [w("Main", "a"), w("Savings", "b")],
      { a: "UQAmh0S-J0Md5Ipv5ZWGsYg9itaS9CntVVVY20WpY44qW8Ig" },
    );
    assert.equal(labels.a, "Main");
    assert.equal(labels.b, "Savings");
  });

  await test("two wallets sharing a label render as two distinct labels", () => {
    const wallets = [w("188", "a"), w("188", "b")];
    const labels = disambiguateLabels(wallets, {
      a: "UQAmh0S-J0Md5Ipv5ZWGsYg9itaS9CntVVVY20WpY44qW8Ig",
      b: "EQDk2VTvn04SUKJrW7rXahzdF1eI3MB5x2m8WYo1yT2qNqWz",
    });
    assert.notEqual(
      labels.a,
      labels.b,
      "identical labels are the bug being fixed",
    );
    assert.ok(labels.a.startsWith("188"), "the label is kept, not replaced");
    assert.ok(labels.b.startsWith("188"));
  });

  await test("suffix uses the address tail when the address is known", () => {
    const labels = disambiguateLabels([w("188", "a"), w("188", "b")], {
      a: "UQAmh0S-J0Md5Ipv5ZWGsYg9itaS9CntVVVY20WpY44qW8Ig",
    });
    assert.ok(
      labels.a.endsWith("4qW8Ig"),
      `expected the address tail in "${labels.a}"`,
    );
  });

  await test("suffix falls back to the id when the address is missing", () => {
    const labels = disambiguateLabels([w("188", "wallet-aaaa"), w("188", "wallet-bbbb")], {});
    assert.notEqual(labels["wallet-aaaa"], labels["wallet-bbbb"]);
    assert.ok(labels["wallet-aaaa"].endsWith("aaaa"));
    assert.ok(labels["wallet-bbbb"].endsWith("bbbb"));
  });

  await test("a lone wallet is never suffixed, even with no address", () => {
    assert.equal(disambiguateLabels([w("188", "a")], {})["a"], "188");
  });

  await test("case-only collisions are treated as collisions", () => {
    const wallets = [w("Main", "a"), w("main", "b")];
    const labels = disambiguateLabels(wallets, {});
    assert.notEqual(labels.a, labels.b);
  });

  await test("three-way collision gives three distinct labels", () => {
    const wallets = [w("188", "a"), w("188", "b"), w("188", "c")];
    const labels = disambiguateLabels(wallets, {});
    assert.equal(new Set(Object.values(labels)).size, 3);
  });

  await test("entries without an id are skipped, not crashed on", () => {
    const labels = disambiguateLabels([{ name: "188" }, w("188", "b")], {});
    assert.deepEqual(Object.keys(labels), ["b"]);
    assert.equal(labels.b, "188");
  });

  section("results");

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const { name, error } of failures) {
      console.log(`\n✗ ${name}\n${error.stack}`);
    }
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
