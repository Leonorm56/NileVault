/**
 * Build-integrity check.
 *
 * Unit tests prove the *source* is correct. They say nothing about the artifact
 * you are about to install. A funded live test was once spent against a build
 * that predated the send fixes, and the failure looked like a code bug rather
 * than a stale binary.
 *
 * This inspects the real production bundle (and the packaged asar when present)
 * and fails if a known-bad construct is still in there, or if a required part of
 * the send stack is missing. Run it after `vite build`; `npm run build` and
 * `npm run check:build` are wired together for that reason.
 *
 * Property names survive minification (esbuild does not mangle members by
 * default), and URL paths are template-literal fragments, so both are stable
 * markers to grep for.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const ASSET_DIR = path.join(ROOT, "app", "assets");
const ASAR = path.join(ROOT, "dist", "win-unpacked", "resources", "app.asar");

/** Constructs that must never appear in a shipped bundle. */
const FORBIDDEN = [
  {
    needle: "storeMaybeCustomPayload",
    why: "not a @ton/core Builder method — throws on every Jetton send",
  },
  {
    needle: "362c90ee",
    why: "non-standard outer opcode that wrapped the TEP-74 body",
  },
  {
    needle: "blockchains/accounts",
    why: "plural path; tonapi only serves /blockchain/accounts (singular)",
  },
  {
    needle: "JETTON_GAS_RESERVE",
    why: "counted the jetton attachment a second time as a gas reserve",
  },
];

/** Constructs that must be present for the send stack to work. */
const REQUIRED = [
  { needle: "blockchain/accounts", why: "the real run-method path for getSeqno" },
  { needle: "methods/getSeqno", why: "the seqno run method" },
  { needle: "jetton", why: "jetton support" },
  { needle: "nilewallet-backup", why: "backup/restore file format" },
  { needle: "blockchain/message", why: "broadcast endpoint (sendBoc was removed from tonapi)" },
  { needle: "walletStates", why: "the single-snapshot state read (toncenter v3)" },
  { needle: "estimateFee", why: "the live fee estimate" },
  { needle: "get_wallet_address", why: "master-derived jetton wallet address" },
  { needle: "get_wallet_data", why: "reverse verification of the jetton wallet" },
  { needle: "source_fees", why: "the nested fee fields the estimate actually returns" },
  { needle: "Token contract being called", why: "the confirmation names the jetton wallet" },
  { needle: "nc-address", why: "long addresses wrap instead of overflowing" },
];

/** The TEP-74 opcode, however the minifier chose to write it. */
const TEP74_FORMS = ["260734629", "0xf8a7ea5", "0x0f8a7ea5"];

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`  \u2717 ${msg}`);
};
const pass = (msg) => console.log(`  \u2713 ${msg}`);

function findBundles() {
  if (!existsSync(ASSET_DIR)) return [];
  return readdirSync(ASSET_DIR)
    .filter((f) => f.endsWith(".js"))
    .filter((f) => statSync(path.join(ASSET_DIR, f)).size > 200_000)
    .map((f) => path.join(ASSET_DIR, f));
}

const bundles = findBundles();
if (bundles.length === 0) {
  console.error("No production bundle found in app/assets — run `vite build` first.");
  process.exit(1);
}

console.log(`checking ${bundles.length} production bundle(s)`);

const sources = bundles.map((file) => ({
  file: path.basename(file),
  text: readFileSync(file, "utf8"),
}));

if (existsSync(ASAR)) {
  console.log(`also checking the packaged asar (${path.relative(ROOT, ASAR)})`);
  sources.push({ file: "app.asar", text: readFileSync(ASAR, "latin1") });
} else {
  console.log("(no packaged asar present — checking the web bundle only)");
}

for (const { file, text } of sources) {
  console.log(`\n${file} (${(text.length / 1024).toFixed(0)} KB)`);

  for (const { needle, why } of FORBIDDEN) {
    if (text.includes(needle)) fail(`contains "${needle}" — ${why}`);
    else pass(`no "${needle}"`);
  }

  for (const { needle, why } of REQUIRED) {
    if (text.includes(needle)) pass(`has "${needle}"`);
    else fail(`missing "${needle}" — ${why}`);
  }

  if (TEP74_FORMS.some((form) => text.includes(form))) pass("has the TEP-74 transfer opcode");
  else fail("missing the TEP-74 transfer opcode (0x0f8a7ea5)");

  // The old parser read `.seqno` off a run-method response, which never has it.
  if (/data\.seqno/.test(text)) fail('still reads `data.seqno` from a run-method response');
  else pass("does not read a non-existent `data.seqno`");
}

console.log("\nresults");
if (failures) {
  console.log(`\n${failures} problem(s) — do NOT ship this build.`);
  process.exit(1);
}
console.log("\nbuild looks correct: the send fixes are present and the old bugs are not.");
