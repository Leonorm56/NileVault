import { mnemonicNew, mnemonicToPrivateKey, mnemonicValidate } from "@ton/crypto";
import { Address, beginCell, toNano, fromNano } from "@ton/core";
import { WalletContractV4 } from "@ton/ton";
import Encrypter from "./Encrypter.js";

const API_BASE = "https://tonapi.io/v2";
const TOKENS_KEY_PREFIX = "account-";
const TOKENS_SUFFIX = ":nile-wallet:tokens";
const WALLET_KEY_PREFIX = "account-";
const WALLET_SUFFIX = ":nile-wallet";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default class WalletInstance {
  constructor({ storage, accountId }) {
    this.storage = storage;
    this.accountId = accountId;
    this._walletKey = `${WALLET_KEY_PREFIX}${accountId}${WALLET_SUFFIX}`;
    this._tokensKey = `${TOKENS_KEY_PREFIX}${accountId}${TOKENS_SUFFIX}`;
  }

  async load() {
    return (await this.storage.get(this._walletKey, null)) || null;
  }

  async save(data) {
    await this.storage.set(this._walletKey, data);
  }

  async clear() {
    await this.storage.remove(this._walletKey);
    await this.storage.remove(this._tokensKey);
  }

  async generate() {
    const phrase = (await mnemonicNew(24)).join(" ");
    return this.importFromPhrase(phrase);
  }

  async importFromPhrase(phrase) {
    const words = phrase.trim().split(/\s+/);
    if (words.length !== 24) throw new Error("Recovery phrase must be 24 words");
    const valid = await mnemonicValidate(words);
    if (!valid) throw new Error("Invalid recovery phrase");

    const keyPair = await mnemonicToPrivateKey(words);
    const contract = WalletContractV4.create({
      workchain: 0,
      publicKey: keyPair.publicKey,
    });
    const address = contract.address.toString({ urlSafe: true, bounceable: false });
    const rawAddress = contract.address.toRawString();

    return {
      phrase: words.join(" "),
      address,
      rawAddress,
      publicKey: keyPair.publicKey.toString("hex"),
    };
  }

  async encryptSeed(phrase, key) {
    return Encrypter.encryptWithKey({ data: phrase, key });
  }

  async decryptSeed(encrypted, key) {
    return Encrypter.decryptWithKey({ encrypted, key });
  }

  async encryptForBackup(phrase, password, salt) {
    return Encrypter.encryptData({ data: phrase, password, salt });
  }

  async decryptFromBackup(encrypted, password, salt) {
    return Encrypter.decryptData({ encrypted, password, salt });
  }

  async getBalance(address) {
    try {
      const url = `${API_BASE}/accounts/${Address.parse(address).toString()}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.error("[getBalance]", res.status, body);
        return "0";
      }
      const data = await res.json();
      return fromNano(data.balance || 0);
    } catch (err) {
      console.error("[getBalance] error:", err);
      return "0";
    }
  }

  async listTokens() {
    return (await this.storage.get(this._tokensKey, [])) || [];
  }

  async addToken(jettonMasterAddress) {
    const addr = Address.parse(jettonMasterAddress);
    const tokens = await this.listTokens();
    if (tokens.some((t) => t.jetton_master_address === addr.toString())) {
      throw new Error("Token already tracked");
    }

    const res = await fetch(`${API_BASE}/jettons/${addr.toString()}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || body.error || `Token not found (${res.status})`);
    }
    const data = await res.json();
    const meta = data.metadata || data;

    const token = {
      jetton_master_address: addr.toString(),
      name: meta.name || data.name || "Unknown",
      symbol: meta.symbol || data.symbol || "???",
      decimals: Number(meta.decimals ?? data.decimals) || 9,
      icon_url: meta.image || data.image || data.preview || null,
    };

    tokens.push(token);
    await this.storage.set(this._tokensKey, tokens);
    return token;
  }

  async removeToken(jettonMasterAddress) {
    const tokens = await this.listTokens();
    const next = tokens.filter((t) => t.jetton_master_address !== jettonMasterAddress);
    await this.storage.set(this._tokensKey, next);
  }

  async getJettonBalance(jettonWalletAddress, _undefined, jettonMasterAddress) {
    try {
      const stored = await this.load();
      if (!stored?.address) return "0";

      const ownerAddr = Address.parse(stored.address).toString();
      const url = `${API_BASE}/accounts/${ownerAddr}/jettons`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.error("[getJettonBalance]", res.status, body);
        return "0";
      }
      const data = await res.json();

      const jettons = data.balances || data.jettons || [];
      for (const j of jettons) {
        const master = j.jetton?.address || j.jetton_address;
        if (master && Address.parse(master).toString() === Address.parse(jettonMasterAddress).toString()) {
          return j.balance || "0";
        }
      }
      return "0";
    } catch (err) {
      console.error("[getJettonBalance] error:", err);
      return "0";
    }
  }

  parseAmountToRaw(amount, decimals) {
    const s = String(amount).trim();
    if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Invalid amount");
    const [whole, fraction = ""] = s.split(".");
    const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
  }

  async buildSignedTransfer({ contract, keyPair, to, amountRaw, jetton }) {
    const toAddr = Address.parse(to);
    const seqno = await this._getSeqno(contract.address.toString());

    let body;
    if (jetton) {
      const payload = beginCell()
        .storeUint(0x0f8a7ea5, 32)
        .storeUint(0, 64)
        .storeCoins(BigInt(amountRaw))
        .storeAddress(toAddr)
        .storeAddress(null)
        .storeMaybeCustomPayload(null)
        .storeCoins(0n)
        .storeUint(0, 1)
        .endCell();

      body = beginCell()
        .storeUint(0x362c90ee, 32)
        .storeUint(0, 64)
        .storeCoins(toNano("0.05"))
        .storeRef(payload)
        .endCell();
    } else {
      body = beginCell().storeUint(0, 1).endCell();
    }

    const transfer = await contract.createTransfer({
      seqno,
      secretKey: keyPair.secretKey,
      messages: [
        {
          to: jetton ? Address.parse(jetton.jetton_wallet_address || to) : toAddr,
          value: jetton ? toNano("0.05") : BigInt(amountRaw),
          body,
        },
      ],
    });

    return { cell: transfer, seqno };
  }

  async estimateTransferFee(address, cell) {
    return 5000000n;
  }

  async checkTransferFunds({ contract, amountRaw, jetton, feeNano }) {
    const address = contract.address.toString();
    const balance = await this.getBalance(address);
    const balanceNano = toNano(balance || "0");
    const totalNeeded = BigInt(amountRaw) + BigInt(feeNano || 5000000n);

    if (!jetton) {
      if (balanceNano < totalNeeded) {
        return {
          sufficient: false,
          reason: `Insufficient TON balance (${balance} TON)`,
          tonBalanceRaw: balanceNano.toString(),
          jettonBalanceRaw: null,
        };
      }
    }

    return {
      sufficient: true,
      tonBalanceRaw: balanceNano.toString(),
      jettonBalanceRaw: null,
    };
  }

  async broadcastTransfer(cell) {
    const boc = cell.toBoc().toString("base64");
    const res = await fetch(`${API_BASE}/blockchain/sendBoc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boc }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Broadcast failed: ${res.status}`);
    }
    const data = await res.json().catch(() => ({}));
    return { hash: data.message_hash || cell.hash().toString("hex") };
  }

  async waitForSeqnoChange(address, oldSeqno, maxWait = 30000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const seqno = await this._getSeqno(address);
      if (seqno > oldSeqno) return seqno;
      await sleep(2000);
    }
    throw new Error("Timeout waiting for confirmation");
  }

  async _getSeqno(address) {
    try {
      const raw = Address.parse(address).hash.toString("hex");
      const res = await fetch(`${API_BASE}/blockchains/accounts/${raw}/methods/getSeqno`);
      if (!res.ok) return 0;
      const data = await res.json();
      return data.seqno || 0;
    } catch {
      return 0;
    }
  }
}
