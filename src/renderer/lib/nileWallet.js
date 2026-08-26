import { Address } from "@ton/core";
import { WalletContractV4 } from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";

import Encrypter from "./Encrypter.js";
import WalletInstance from "./WalletInstance.js";
import storage from "./storage.js";

/**
 * Client-side NileWallet — runs entirely in the Electron renderer.
 *
 * This is a port of the NileChain extension's `nileWallet.js`. The extension
 * ran the vault/wallet/token/transfer stack client-side and only pushed TON
 * Connect to its service worker (because the popup was ephemeral). NileVault's
 * BrowserWindow is persistent, so everything — including TON Connect — runs
 * here; `nileWalletConnectManager.js` hosts the bridge instances and reuses the
 * same in-memory vault key via {@link getKeyPair}.
 *
 * The seed material is encrypted with a raw AES-GCM key derived once from the
 * single vault passphrase; that key (`vaultKey`) lives only in this module's
 * memory and is cleared on lock / lost on app restart.
 */

const VAULT_STORAGE_KEY = "shared:nile-wallet:vault";
const VAULT_CHECK_PLAINTEXT = "nile-vault-ok";
/**
 * The picker registry. Repointed from the extension's `shared:accounts`
 * (owned by the NileChain core) to a NileVault-owned key, since NileVault owns
 * wallet lifecycle here. Entries: `{ id, name, created }`.
 */
const ACCOUNTS_STORAGE_KEY = "nilevault:wallets";
const BACKUP_VERSION = 1;
const BACKUP_CHAIN = "mainnet";

let vaultKey = null;
const walletCache = new Map();

export function getWallet(accountId) {
  if (!walletCache.has(accountId)) {
    walletCache.set(accountId, new WalletInstance({ storage, accountId }));
  }
  return walletCache.get(accountId);
}

async function getVaultConfig() {
  return await storage.get(VAULT_STORAGE_KEY, null);
}

function requireKey() {
  if (!vaultKey) throw new Error("needs-unlock");
  return vaultKey;
}

async function unlockVault(password) {
  if (!password) throw new Error("Passphrase required");

  let config = await getVaultConfig();

  if (!config) {
    const salt = Encrypter.generateSalt();
    const key = await Encrypter.scryptPass(password, salt);
    const check = await Encrypter.encryptWithKey({
      data: VAULT_CHECK_PLAINTEXT,
      key,
    });
    await storage.set(VAULT_STORAGE_KEY, { salt, check });
    vaultKey = key;
    return { configured: true, unlocked: true, created: true };
  }

  const key = await Encrypter.scryptPass(password, config.salt);
  try {
    const decrypted = await Encrypter.decryptWithKey({
      encrypted: config.check,
      key,
    });
    if (decrypted !== VAULT_CHECK_PLAINTEXT) throw new Error("mismatch");
  } catch {
    throw new Error("bad-passphrase");
  }

  vaultKey = key;
  return { configured: true, unlocked: true, created: false };
}

/**
 * Decrypt the account's mnemonic (requires unlock) and derive its keypair.
 * Exported so the TON Connect manager can attach signing keys to a connect
 * instance while sharing this module's single in-memory vault key.
 */
export async function getKeyPair(accountId) {
  const key = requireKey();
  const wallet = getWallet(accountId);
  const stored = await wallet.load();

  if (!stored?.encrypted) throw new Error("No wallet for this account");

  const phrase = await wallet.decryptSeed(stored.encrypted, key);
  const keyPair = await mnemonicToPrivateKey(phrase.split(" "));
  const contract = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });

  return { keyPair, phrase, contract };
}

function resolveSendParams(wallet, message) {
  const { kind, token, to, amount } = message;

  try {
    Address.parse(to);
  } catch {
    throw new Error("Invalid recipient address");
  }
  if (!amount) throw new Error("Enter an amount");

  let raw;
  let jetton = null;
  if (kind === "jetton") {
    if (!token?.jetton_wallet_address) throw new Error("Token not tracked");
    raw = wallet.parseAmountToRaw(amount, Number(token.decimals) || 9);
    jetton = token;
  } else {
    raw = wallet.parseAmountToRaw(amount, 9);
  }
  if (raw <= 0n) throw new Error("Amount must be greater than zero");

  return { to, raw, jetton };
}

async function handleTransferEstimate(accountId, message) {
  const wallet = getWallet(accountId);
  const { contract, keyPair } = await getKeyPair(accountId);
  const params = resolveSendParams(wallet, message);

  const { cell } = await wallet.buildSignedTransfer({
    contract,
    keyPair,
    to: params.to,
    amountRaw: params.raw,
    jetton: params.jetton,
  });
  const feeNano = await wallet.estimateTransferFee(
    contract.address.toString(),
    cell,
  );
  const funds = await wallet.checkTransferFunds({
    contract,
    amountRaw: params.raw,
    jetton: params.jetton,
    feeNano,
  });

  return {
    status: true,
    to: params.to,
    amountRaw: params.raw.toString(),
    feeNano: feeNano.toString(),
    insufficient: funds.sufficient ? null : funds.reason,
    tonBalanceRaw: funds.tonBalanceRaw,
    jettonBalanceRaw: funds.jettonBalanceRaw,
  };
}

async function handleTransferSend(accountId, message) {
  const wallet = getWallet(accountId);
  const { contract, keyPair } = await getKeyPair(accountId);
  const params = resolveSendParams(wallet, message);

  const { cell, seqno } = await wallet.buildSignedTransfer({
    contract,
    keyPair,
    to: params.to,
    amountRaw: params.raw,
    jetton: params.jetton,
  });
  const feeNano = await wallet.estimateTransferFee(
    contract.address.toString(),
    cell,
  );
  const funds = await wallet.checkTransferFunds({
    contract,
    amountRaw: params.raw,
    jetton: params.jetton,
    feeNano,
  });
  if (!funds.sufficient) throw new Error(funds.reason);

  const { hash } = await wallet.broadcastTransfer(cell);
  let status = "pending";
  try {
    await wallet.waitForSeqnoChange(contract.address.toString(), seqno);
    status = "confirmed";
  } catch {
    /* broadcast accepted; confirmation may lag */
  }

  return { status: true, hash, txStatus: status, seqno };
}

/* -------------------------------------------------------------------------- */
/* Wallet registry (the picker's list of NileWallet instances)                 */
/* -------------------------------------------------------------------------- */

/** Read the picker registry: `[{ id, name, created }]`. */
async function listWallets() {
  const wallets = await storage.get(ACCOUNTS_STORAGE_KEY, []);
  return Array.isArray(wallets) ? wallets : [];
}

/** Create a new (empty) NileWallet instance — seed is generated in-wallet. */
async function createWallet(name) {
  const wallets = await listWallets();
  const entry = {
    id: crypto.randomUUID(),
    name: String(name || "").trim() || "Wallet",
    created: Date.now(),
  };
  wallets.push(entry);
  await storage.set(ACCOUNTS_STORAGE_KEY, wallets);
  return { status: true, wallet: entry };
}

/** Rename a wallet in the registry. */
async function renameWallet(id, name) {
  const wallets = await listWallets();
  const idx = wallets.findIndex((w) => w.id === id);
  if (idx === -1) throw new Error("Wallet not found");
  wallets[idx] = {
    ...wallets[idx],
    name: String(name || "").trim() || wallets[idx].name,
  };
  await storage.set(ACCOUNTS_STORAGE_KEY, wallets);
  return { status: true, wallet: wallets[idx] };
}

/**
 * Remove a wallet from the registry and delete all of its stored data
 * (metadata + encrypted seed, tokens, TON Connect sessions). Distinct from
 * the in-wallet "empty this wallet" danger action, which only clears the seed.
 */
async function deleteWallet(id) {
  const wallets = await listWallets();
  const next = wallets.filter((w) => w.id !== id);
  await storage.set(ACCOUNTS_STORAGE_KEY, next);

  const wallet = getWallet(id);
  await wallet.clear(); // account-<id>:nile-wallet + :sessions
  await storage.remove(`account-${id}:nile-wallet:tokens`);
  walletCache.delete(id);

  return { status: true };
}

/* -------------------------------------------------------------------------- */
/* Change passphrase (net-new — the reference has no in-app change flow)        */
/* -------------------------------------------------------------------------- */

/**
 * Re-key the vault: verify the old passphrase, then re-encrypt every account's
 * seed under a key derived from a fresh salt + the new passphrase.
 *
 * Safety: all seeds are decrypted with the old key up front and the whole
 * operation aborts if any decryption fails — so a bad state can never be
 * half-written. Only after every seed decrypts do we re-encrypt + persist,
 * rewriting the `{salt, check}` verifier last and swapping the in-memory key.
 */
async function changePassphrase({ oldPassword, newPassword }) {
  if (!newPassword) throw new Error("New passphrase required");
  const config = await getVaultConfig();
  if (!config) throw new Error("Vault not configured");

  const oldKey = await Encrypter.scryptPass(oldPassword, config.salt);
  try {
    const decrypted = await Encrypter.decryptWithKey({
      encrypted: config.check,
      key: oldKey,
    });
    if (decrypted !== VAULT_CHECK_PLAINTEXT) throw new Error("mismatch");
  } catch {
    throw new Error("bad-passphrase");
  }

  // Decrypt every stored seed with the old key first — abort before any write.
  const ids = await listAccountIds();
  const pending = [];
  for (const id of ids) {
    const wallet = getWallet(id);
    const stored = await wallet.load();
    if (!stored?.encrypted) continue;
    let phrase;
    try {
      phrase = await wallet.decryptSeed(stored.encrypted, oldKey);
    } catch {
      throw new Error("Could not re-encrypt an existing wallet; passphrase unchanged");
    }
    pending.push({ id, stored, phrase });
  }

  const newSalt = Encrypter.generateSalt();
  const newKey = await Encrypter.scryptPass(newPassword, newSalt);

  for (const { id, stored, phrase } of pending) {
    const wallet = getWallet(id);
    const encrypted = await wallet.encryptSeed(phrase, newKey);
    await wallet.save({
      address: stored.address,
      rawAddress: stored.rawAddress,
      publicKey: stored.publicKey,
      encrypted,
    });
  }

  const check = await Encrypter.encryptWithKey({
    data: VAULT_CHECK_PLAINTEXT,
    key: newKey,
  });
  await storage.set(VAULT_STORAGE_KEY, { salt: newSalt, check });
  vaultKey = newKey;

  return { status: true, count: pending.length };
}

/* -------------------------------------------------------------------------- */
/* Backup / restore                                                            */
/* -------------------------------------------------------------------------- */

/** Every account id currently in the picker registry. */
async function listAccountIds() {
  const accounts = await storage.get(ACCOUNTS_STORAGE_KEY, []);
  if (!Array.isArray(accounts)) return [];
  return accounts
    .filter((a) => a && typeof a.id === "string" && a.id)
    .map((a) => a.id);
}

async function assertVaultPassword(password) {
  if (!password) throw new Error("Passphrase required");
  const config = await getVaultConfig();
  if (!config) throw new Error("Vault not configured");
  const key = await Encrypter.scryptPass(password, config.salt);
  let decrypted;
  try {
    decrypted = await Encrypter.decryptWithKey({
      encrypted: config.check,
      key,
    });
  } catch {
    throw new Error("bad-passphrase");
  }
  if (decrypted !== VAULT_CHECK_PLAINTEXT) throw new Error("bad-passphrase");
}

function parseBackup(json) {
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("Not a valid backup file");
  }
  if (!data || data.type !== "nilewallet-backup") {
    throw new Error("Not a NileWallet backup file");
  }
  if (data.version !== BACKUP_VERSION) {
    throw new Error(`Unsupported backup version: ${data.version}`);
  }
  if (typeof data.salt !== "string" || !data.salt) {
    throw new Error("Backup is missing its encryption salt");
  }
  if (!Array.isArray(data.entries) || data.entries.length === 0) {
    throw new Error("Backup contains no wallets");
  }

  data.entries.forEach((entry, index) => {
    const label = `Entry ${index + 1}`;
    if (!entry || typeof entry !== "object") throw new Error(`${label}: invalid`);
    if (typeof entry.account_id !== "string" || !entry.account_id) {
      throw new Error(`${label}: missing account_id`);
    }
    if (typeof entry.mnemonic_encrypted !== "string" || !entry.mnemonic_encrypted) {
      throw new Error(`${label}: missing encrypted mnemonic`);
    }
    if (typeof entry.address !== "string" || !entry.address) {
      throw new Error(`${label}: missing address`);
    }
    try {
      Address.parse(entry.address);
    } catch {
      throw new Error(`${label}: invalid address`);
    }
    if (entry.added_tokens !== undefined && !Array.isArray(entry.added_tokens)) {
      throw new Error(`${label}: invalid added_tokens`);
    }
  });

  return data;
}

async function decryptBackupEntry(entry, password, salt) {
  let phrase;
  try {
    phrase = await getWallet(entry.account_id).decryptFromBackup(
      entry.mnemonic_encrypted,
      password,
      salt,
    );
  } catch {
    throw new Error("Wrong passphrase or corrupted backup");
  }

  const derived = await getWallet(entry.account_id).importFromPhrase(phrase);
  const recorded = Address.parse(entry.address);
  if (!Address.parse(derived.address).equals(recorded)) {
    throw new Error("Backup entry address does not match its mnemonic");
  }
  return phrase;
}

/**
 * Export every stored wallet as a passphrase-encrypted JSON backup. Always
 * returns the JSON string to the caller (the renderer saves it via a Blob
 * download) — the extension's `chrome.downloads` path does not apply here.
 */
async function handleWalletBackup(message) {
  const vKey = requireKey();
  await assertVaultPassword(message.password);

  const salt = Encrypter.generateSalt();
  const entries = [];

  for (const id of await listAccountIds()) {
    const wallet = getWallet(id);
    const stored = await wallet.load();
    if (!stored?.encrypted) continue;

    const phrase = await wallet.decryptSeed(stored.encrypted, vKey);
    const mnemonic_encrypted = await wallet.encryptForBackup(
      phrase,
      message.password,
      salt,
    );

    entries.push({
      account_id: id,
      farm_id: null,
      address: stored.address,
      chain: BACKUP_CHAIN,
      mnemonic_encrypted,
      added_tokens: await wallet.listTokens(),
    });
  }

  if (entries.length === 0) throw new Error("No wallets to back up");

  const backup = {
    version: BACKUP_VERSION,
    type: "nilewallet-backup",
    created_at: Date.now(),
    salt,
    entries,
  };

  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const filename = `nilewallet-backup-${date}.json`;

  return {
    status: true,
    filename,
    count: entries.length,
    json: JSON.stringify(backup, null, 2),
  };
}

async function handleRestorePreview(message) {
  const backup = parseBackup(message.json);
  const entries = [];

  for (const entry of backup.entries) {
    await decryptBackupEntry(entry, message.password, backup.salt);
    const existing = await getWallet(entry.account_id).load();
    entries.push({
      account_id: entry.account_id,
      address: entry.address,
      chain: entry.chain || BACKUP_CHAIN,
      token_count: Array.isArray(entry.added_tokens) ? entry.added_tokens.length : 0,
      exists: Boolean(existing?.encrypted),
    });
  }

  return { status: true, created_at: backup.created_at, entries };
}

async function handleRestoreApply(message) {
  const vKey = requireKey();
  const backup = parseBackup(message.json);
  const overwrite = message.overwrite || {};

  let restored = 0;
  let skipped = 0;

  for (const entry of backup.entries) {
    const wallet = getWallet(entry.account_id);
    const existing = await wallet.load();

    if (existing?.encrypted && overwrite[entry.account_id] !== true) {
      skipped++;
      continue;
    }

    const phrase = await decryptBackupEntry(entry, message.password, backup.salt);
    const derived = await wallet.importFromPhrase(phrase);
    const encrypted = await wallet.encryptSeed(phrase, vKey);

    await wallet.save({
      address: derived.address,
      rawAddress: derived.rawAddress,
      publicKey: derived.publicKey,
      encrypted,
    });
    await storage.set(
      `account-${entry.account_id}:nile-wallet:tokens`,
      Array.isArray(entry.added_tokens) ? entry.added_tokens : [],
    );

    // Ensure the restored account is present in the picker registry.
    const wallets = await listWallets();
    if (!wallets.some((w) => w.id === entry.account_id)) {
      wallets.push({
        id: entry.account_id,
        name: `Wallet ${wallets.length + 1}`,
        created: Date.now(),
      });
      await storage.set(ACCOUNTS_STORAGE_KEY, wallets);
    }

    restored++;
  }

  return { status: true, restored, skipped };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

const nileWallet = {
  vaultStatus: async () => {
    const config = await getVaultConfig();
    return { configured: Boolean(config), unlocked: Boolean(vaultKey) };
  },

  unlock: (password) => unlockVault(password),

  lock: () => {
    vaultKey = null;
    return { status: true };
  },

  changePassphrase: (message) => changePassphrase(message),

  /* ---- wallet registry (picker) ---- */
  listWallets: () => listWallets(),
  createWallet: (name) => createWallet(name),
  renameWallet: (id, name) => renameWallet(id, name),
  deleteWallet: (id) => deleteWallet(id),

  get: async (accountId) => {
    const wallet = getWallet(accountId);
    const stored = await wallet.load();
    return {
      status: Boolean(stored),
      address: stored?.address || null,
      rawAddress: stored?.rawAddress || null,
      publicKey: stored?.publicKey || null,
      platform: stored?.platform || "v4r2",
    };
  },

  generate: async (accountId) => {
    const key = requireKey();
    const wallet = getWallet(accountId);
    const stored = await wallet.load();
    if (stored?.encrypted) throw new Error("Wallet already exists");

    const { phrase, address, rawAddress, publicKey } = await wallet.generate();
    const encrypted = await wallet.encryptSeed(phrase, key);
    await wallet.save({ address, rawAddress, publicKey, encrypted });
    return { status: true, address, rawAddress, publicKey };
  },

  importWallet: async (accountId, phrase) => {
    const key = requireKey();
    const wallet = getWallet(accountId);
    const stored = await wallet.load();
    if (stored?.encrypted) throw new Error("Wallet already exists");

    const result = await wallet.importFromPhrase(phrase);
    const encrypted = await wallet.encryptSeed(result.phrase, key);
    await wallet.save({
      address: result.address,
      rawAddress: result.rawAddress,
      publicKey: result.publicKey,
      encrypted,
    });
    return {
      status: true,
      address: result.address,
      rawAddress: result.rawAddress,
      publicKey: result.publicKey,
    };
  },

  revealSeed: async (accountId) => {
    const key = requireKey();
    const wallet = getWallet(accountId);
    const stored = await wallet.load();
    if (!stored?.encrypted) throw new Error("No wallet for this account");
    const phrase = await wallet.decryptSeed(stored.encrypted, key);
    return { phrase };
  },

  clear: async (accountId) => {
    const wallet = getWallet(accountId);
    await wallet.clear();
    return { status: true };
  },

  balance: async (accountId) => {
    const wallet = getWallet(accountId);
    const stored = await wallet.load();
    if (!stored?.address) return { balance: "0", error: "no-wallet" };
    const balance = await wallet.getBalance(stored.address);
    return { balance };
  },

  listTokens: async (accountId) => {
    const wallet = getWallet(accountId);
    return { status: true, tokens: await wallet.listTokens() };
  },

  addToken: async (accountId, address) => {
    const wallet = getWallet(accountId);
    const token = await wallet.addToken(address);
    return { status: true, token };
  },

  removeToken: async (accountId, address) => {
    const wallet = getWallet(accountId);
    await wallet.removeToken(address);
    return { status: true };
  },

  tokenBalance: async (accountId, token) => {
    const wallet = getWallet(accountId);
    const balance = await wallet.getJettonBalance(
      token.jetton_wallet_address,
      undefined,
      token.jetton_master_address,
    );
    return {
      status: true,
      jetton_master_address: token.jetton_master_address,
      balance,
    };
  },

  estimateTransfer: (accountId, params) =>
    handleTransferEstimate(accountId, params),

  sendTransfer: (accountId, params) => handleTransferSend(accountId, params),

  backup: (message) => handleWalletBackup(message),

  restorePreview: (message) => handleRestorePreview(message),

  restoreApply: (message) => handleRestoreApply(message),
};

export default nileWallet;
