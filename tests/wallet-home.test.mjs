/**
 * Wallet-home view-model tests (vertical slice: S03).
 *
 * The home screen aggregates token holdings into a total + sorted asset rows.
 * All money math stays in BigInt base units — the display formatter is the
 * only place a decimal string appears. Hidden-balance mode must never leak a
 * figure into any display field.
 *
 * Run: esbuild bundle + node (see package.json test:home), or `npm test`.
 */

import assert from "node:assert/strict";

import { buildHomeModel } from "../src/renderer/lib/walletHome.js";

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

async function run() {
  section("buildHomeModel");

  await test("empty holdings give an empty state, zero total", () => {
    const model = buildHomeModel({ holdings: [], hidden: false });
    assert.equal(model.isEmpty, true);
    assert.equal(model.totalRaw, 0n);
    assert.deepEqual(model.rows, []);
  });

  await test("native total sums base units exactly (no float)", () => {
    const model = buildHomeModel({
      holdings: [
        { symbol: "TON", balanceRaw: "1000000000", decimals: 9, pinned: false },
        { symbol: "TON", balanceRaw: "500000000", decimals: 9, pinned: false },
      ],
      hidden: false,
    });
    assert.equal(model.totalRaw, 1500000000n);
    assert.equal(model.totalDisplay, "1.5");
  });

  await test("pinned rows sort first, then balance descending", () => {
    const model = buildHomeModel({
      holdings: [
        { symbol: "BIG", balanceRaw: "9000000000", decimals: 9, pinned: false },
        { symbol: "PIN", balanceRaw: "1000000000", decimals: 9, pinned: true },
        { symbol: "MID", balanceRaw: "2000000000", decimals: 9, pinned: false },
      ],
      hidden: false,
    });
    assert.deepEqual(
      model.rows.map((r) => r.symbol),
      ["PIN", "BIG", "MID"],
    );
  });

  await test("hidden mode masks every display figure", () => {
    const model = buildHomeModel({
      holdings: [
        { symbol: "TON", balanceRaw: "1000000000", decimals: 9, pinned: false },
      ],
      hidden: true,
    });
    assert.equal(model.totalDisplay, "••••");
    assert.ok(
      model.rows.every((r) => r.balanceDisplay === "••••"),
      "no row leaks a figure",
    );
    // Raw math still exact behind the mask.
    assert.equal(model.totalRaw, 1000000000n);
  });

  await test("malformed balances fall back to zero, never throw", () => {
    const model = buildHomeModel({
      holdings: [
        { symbol: "BAD", balanceRaw: "not-a-number", decimals: 9, pinned: false },
      ],
      hidden: false,
    });
    assert.equal(model.rows[0].balanceRaw, 0n);
    assert.equal(model.totalRaw, 0n);
  });

  await test("holding ids pass through to sorted rows", () => {
    const model = buildHomeModel({
      holdings: [
        { id: "b", symbol: "BIG", balanceRaw: "9000000000", decimals: 9 },
        { id: "s", symbol: "SMALL", balanceRaw: "1000000000", decimals: 9 },
      ],
      hidden: false,
    });
    assert.deepEqual(
      model.rows.map((r) => r.id),
      ["b", "s"],
    );
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
