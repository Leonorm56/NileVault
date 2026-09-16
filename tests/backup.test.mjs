/**
 * Backup / restore tests.
 *
 * The failure these pin down actually shipped once: the backup dialog asked for
 * a backup password, validated it, and then encrypted the file with the *vault
 * passphrase* instead. The export looked fine, the backup-password box was
 * ignored, and restoring with the password the app had just asked for failed
 * with "Wrong passphrase or corrupted backup" — the file was only openable with
 * a different secret than the one the user was told to remember.
 *
 * So the central assertion here is negative: after exporting with a distinct
 * backup password, the *vault passphrase* must NOT open the file.
 *
 * Run with `npm test` (esbuild bundles the ESM sources; the app's package.json
 * is deliberately not `type: module` because the Electron main process is CJS,
 * so the bundle target has no top-level await).
 */

import assert from "node:assert/strict";

/* ── in-memory bridge ─────────────────────────────────────────────────────── */

/**
 * The renderer reaches its key-value store through `window.nilevault`, read
 * lazily on each call. Stubbing it here gives the vault a real store to write
 * to, which is what makes a genuine export → restore round trip possible.
 */
function installBridge() {
  const store = new Map();
  globalThis.window = {
    nilevault: {
      kvGet: async (key) => (store.has(key) ? structuredClone(store.get(key)) : undefined),
      kvSet: async (key, value) => {
        store.set(key, structuredClone(value));
        return { ok: true };
      },
      kvRemove: async (key) => {
        store.delete(key);
        return { ok: true };
      },
      kvGetAll: async () => Object.fromEntries(store),
    },
  };
}

const VAULT_PASS = "vault-passphrase-1";
const BACKUP_PASS = "backup-password-1";

async function main() {
  /* ── harness ────────────────────────────────────────────────────────────── */

  let passed = 0;
  const failures = [];

  async function test(name, fn) {
    try {
      await fn();
      passed += 1;
      console.log(`  \u2713 ${name}`);
    } catch (error) {
      failures.push({ name, error });
      console.log(`  \u2717 ${name}\n      ${error.message}`);
    }
  }

  function section(title) {
    console.log(`\n${title}`);
  }

  installBridge();

  const { default: nileWallet, MIN_BACKUP_PASSWORD_LENGTH } = await import(
    "../src/renderer/lib/nileWallet.js"
  );

  /* ── one shared vault, built once ───────────────────────────────────────── */

  const created = await nileWallet.createWallet("Main");
  const ACCOUNT_ID = created.wallet.id;

  await nileWallet.unlock(VAULT_PASS);
  const generated = await nileWallet.generate(ACCOUNT_ID);
  const ORIGINAL_ADDRESS = generated.address;

  /** Fresh export, made with a backup password distinct from the vault one. */
  const exported = await nileWallet.backup({
    password: VAULT_PASS,
    backupPassword: BACKUP_PASS,
  });

  /* ── tests ──────────────────────────────────────────────────────────────── */

  section("backup: file shape");

  await test("export produces a versioned NileWallet backup", () => {
    const parsed = JSON.parse(exported.json);
    assert.equal(parsed.type, "nilewallet-backup");
    assert.equal(typeof parsed.version, "number");
    assert.ok(parsed.salt, "backup carries its own salt");
    assert.equal(parsed.entries.length, 1);
  });

  await test("export never contains the plaintext recovery phrase", () => {
    const parsed = JSON.parse(exported.json);
    for (const entry of parsed.entries) {
      assert.ok(entry.mnemonic_encrypted, "phrase is stored encrypted");
      assert.equal(entry.mnemonic_encrypted.includes(" "), false);
    }
    assert.ok(
      !/^\s*\w+(\s+\w+){11,23}\s*$/m.test(exported.json),
      "no bare 12-24 word phrase anywhere in the file",
    );
  });

  await test("file records which secret opens it", () => {
    assert.equal(JSON.parse(exported.json).encrypted_with, "backup-password");
  });

  await test("export reports a filename and wallet count for the save dialog", () => {
    assert.match(exported.filename, /^nilewallet-backup-\d{4}-\d{2}-\d{2}\.json$/);
    assert.equal(exported.count, 1);
  });

  section("restore: the backup password is the secret that works");

  await test("the backup password decrypts the export", async () => {
    const preview = await nileWallet.restorePreview({
      password: BACKUP_PASS,
      json: exported.json,
    });
    assert.equal(preview.status, true);
    assert.equal(preview.entries.length, 1);
    assert.equal(preview.encryptedWith, "backup-password");
  });

  await test("regression: the vault passphrase does NOT open a backup-password export", async () => {
    await assert.rejects(
      () => nileWallet.restorePreview({ password: VAULT_PASS, json: exported.json }),
      /Wrong passphrase or corrupted backup/,
    );
  });

  await test("a wrong password is rejected, not silently tolerated", async () => {
    await assert.rejects(
      () =>
        nileWallet.restorePreview({ password: "not-the-password", json: exported.json }),
      /Wrong passphrase or corrupted backup/,
    );
  });

  await test("preview flags entries that already exist on this machine", async () => {
    const preview = await nileWallet.restorePreview({
      password: BACKUP_PASS,
      json: exported.json,
    });
    assert.equal(preview.entries[0].exists, true);
    assert.equal(preview.entries[0].address, ORIGINAL_ADDRESS);
  });

  section("backup: vault-passphrase fallback");

  await test("omitting the backup password falls back to the vault passphrase", async () => {
    const fallback = await nileWallet.backup({ password: VAULT_PASS });
    const parsed = JSON.parse(fallback.json);
    assert.equal(parsed.encrypted_with, "vault-passphrase");
    const preview = await nileWallet.restorePreview({
      password: VAULT_PASS,
      json: fallback.json,
    });
    assert.equal(preview.status, true);
  });

  await test("a too-short backup password is refused up front", async () => {
    await assert.rejects(
      () => nileWallet.backup({ password: VAULT_PASS, backupPassword: "short" }),
      new RegExp(`at least ${MIN_BACKUP_PASSWORD_LENGTH} characters`),
    );
  });

  await test("backing up with the wrong vault passphrase is refused", async () => {
    await assert.rejects(
      () =>
        nileWallet.backup({ password: "wrong-vault-pass", backupPassword: BACKUP_PASS }),
      (error) => /passphrase/i.test(error.message),
    );
  });

  section("restore: malformed files fail with a readable reason");

  await test("rejects a file that is not JSON", async () => {
    await assert.rejects(
      () => nileWallet.restorePreview({ password: BACKUP_PASS, json: "{{{" }),
      /Not a valid backup file/,
    );
  });

  await test("rejects JSON that is not a NileWallet backup", async () => {
    await assert.rejects(
      () => nileWallet.restorePreview({ password: BACKUP_PASS, json: '{"hello":1}' }),
      /Not a NileWallet backup file/,
    );
  });

  await test("rejects a backup with no entries", async () => {
    await assert.rejects(
      () =>
        nileWallet.restorePreview({
          password: BACKUP_PASS,
          json: JSON.stringify({
            type: "nilewallet-backup",
            version: 1,
            salt: "abc",
            entries: [],
          }),
        }),
      /contains no wallets/,
    );
  });

  await test("rejects a backup missing its salt", async () => {
    await assert.rejects(
      () =>
        nileWallet.restorePreview({
          password: BACKUP_PASS,
          json: JSON.stringify({
            type: "nilewallet-backup",
            version: 1,
            entries: [{ account_id: "a" }],
          }),
        }),
      /missing its encryption salt/,
    );
  });

  section("restore: applying a backup");

  await test("applying with overwrite replaces the wallet and reports a count", async () => {
    const result = await nileWallet.restoreApply({
      password: BACKUP_PASS,
      json: exported.json,
      overwrite: { [ACCOUNT_ID]: true },
    });
    assert.equal(result.status, true);
    assert.equal(result.restored, 1);
    assert.equal(result.skipped, 0);
  });

  await test("restored wallet derives to the same address it was exported with", async () => {
    await nileWallet.lock();
    await nileWallet.unlock(VAULT_PASS);
    const wallet = await nileWallet.get(ACCOUNT_ID);
    assert.equal(wallet.address, ORIGINAL_ADDRESS);
  });

  await test("existing wallets are skipped unless explicitly overwritten", async () => {
    const result = await nileWallet.restoreApply({
      password: BACKUP_PASS,
      json: exported.json,
    });
    assert.equal(result.restored, 0);
    assert.equal(result.skipped, 1);
  });

  /* ── summary ─────────────────────────────────────────────────────────────── */

  console.log("\nresults");

  if (failures.length) {
    console.log(`\n${passed} passed, ${failures.length} failed\n`);
    for (const { name, error } of failures) {
      console.log(`  FAILED: ${name}\n  ${error.stack}\n`);
    }
    process.exit(1);
  }

  console.log(`\n${passed} passed, 0 failed\n`);
}

main().catch((error) => {
  console.error("\nharness crashed:\n", error);
  process.exit(1);
});
