/**
 * Wallet ordering tests (drag-to-reorder persistence).
 *
 * The order is stored as a list of ids and must survive the two things that
 * happen to a registry constantly: wallets being added, and wallets being
 * deleted. A positional (index-based) order fails both — this suite is what
 * pins the id-based behaviour.
 *
 * Pure functions only: no storage, no dnd-kit, no DOM.
 *
 * Run: esbuild bundle + node (see package.json test:order), or `npm test`.
 */

import assert from "node:assert/strict";

import {
  applyWalletOrder,
  reorderIds,
  visibleIds,
} from "../src/renderer/lib/walletOrder.js";

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

const w = (id) => ({ id, name: id });

async function run() {
  section("applyWalletOrder");

  await test("no saved order leaves the registry order alone", () => {
    const wallets = [w("a"), w("b"), w("c")];
    assert.deepEqual(
      applyWalletOrder(wallets, []).map((x) => x.id),
      ["a", "b", "c"],
    );
  });

  await test("a saved order wins", () => {
    const wallets = [w("a"), w("b"), w("c")];
    assert.deepEqual(
      applyWalletOrder(wallets, ["c", "a", "b"]).map((x) => x.id),
      ["c", "a", "b"],
    );
  });

  await test("a newly added wallet lands at the end, not in the middle", () => {
    const wallets = [w("a"), w("b"), w("new"), w("c")];
    assert.deepEqual(
      applyWalletOrder(wallets, ["c", "a", "b"]).map((x) => x.id),
      ["c", "a", "b", "new"],
    );
  });

  await test("a deleted wallet's id is dropped, not resurrected", () => {
    const wallets = [w("a"), w("c")];
    const ordered = applyWalletOrder(wallets, ["c", "b", "a"]);
    assert.deepEqual(ordered.map((x) => x.id), ["c", "a"]);
    assert.equal(ordered.length, 2);
  });

  await test("input is not mutated", () => {
    const wallets = [w("a"), w("b")];
    const saved = ["b", "a"];
    applyWalletOrder(wallets, saved);
    assert.deepEqual(wallets.map((x) => x.id), ["a", "b"]);
    assert.deepEqual(saved, ["b", "a"]);
  });

  await test("duplicate ids in the saved order cannot duplicate wallets", () => {
    const wallets = [w("a"), w("b")];
    assert.deepEqual(
      applyWalletOrder(wallets, ["b", "b", "a"]).map((x) => x.id),
      ["b", "a"],
    );
  });

  await test("malformed input never throws", () => {
    assert.deepEqual(applyWalletOrder(undefined, ["a"]), []);
    assert.deepEqual(applyWalletOrder([w("a")], null).map((x) => x.id), ["a"]);
    // Saved-order wallets come first; anything the order has not seen follows,
    // including a malformed entry — it is kept as-is, never silently dropped.
    const ordered = applyWalletOrder([null, w("a")], ["a"]);
    assert.equal(ordered.length, 2, "a malformed entry is kept, not dropped");
    assert.equal(ordered[0].id, "a");
    assert.equal(ordered[1], null);
  });

  section("reorderIds");

  await test("moves an id down", () => {
    assert.deepEqual(reorderIds(["a", "b", "c"], "a", "c"), ["b", "c", "a"]);
  });

  await test("moves an id up", () => {
    assert.deepEqual(reorderIds(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
  });

  await test("unknown ids are a no-op", () => {
    assert.deepEqual(reorderIds(["a", "b"], "a", "zz"), ["a", "b"]);
    assert.deepEqual(reorderIds(["a", "b"], "zz", "a"), ["a", "b"]);
  });

  await test("dropping an item on itself is a no-op", () => {
    assert.deepEqual(reorderIds(["a", "b"], "a", "a"), ["a", "b"]);
  });

  await test("the input array is not mutated", () => {
    const ids = ["a", "b", "c"];
    reorderIds(ids, "a", "c");
    assert.deepEqual(ids, ["a", "b", "c"]);
  });

  await test("a filtered drag maps onto the full list", () => {
    // Full order a,b,c,d; view hides b. Dragging d above c must move d in the
    // *full* list, so clearing the filter still shows b where it was.
    const full = ["a", "b", "c", "d"];
    const shown = visibleIds(
      full.map(w),
      (wallet) => wallet.id !== "b",
    );
    assert.deepEqual(shown, ["a", "c", "d"]);
    const nextShown = reorderIds(shown, "d", "c");
    assert.deepEqual(nextShown, ["a", "d", "c"]);
    const nextFull = reorderIds(full, "d", "c");
    assert.deepEqual(nextFull, ["a", "b", "d", "c"]);
  });

  section("visibleIds");

  await test("keeps full-list order and drops unknown ids", () => {
    assert.deepEqual(visibleIds([w("a"), {}, w("b")]), ["a", "b"]);
    assert.deepEqual(visibleIds(undefined), []);
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
