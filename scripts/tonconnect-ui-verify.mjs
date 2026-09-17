/**
 * Packaged-build UI verification of the TON Connect link flow.
 *
 * Drives the real `dist/win-unpacked/NileVault.exe` over the Chrome DevTools
 * protocol — no dev server, no browser mock — and walks the flow a user walks:
 * set a passphrase, create a wallet, paste a `tc://` link, read the approval
 * sheet, approve, reject, and paste a broken link.
 *
 * Every stage is asserted against the rendered DOM and captured as a PNG in
 * `dist/tonconnect-verify/`, so "it works" comes with something to look at.
 *
 * Safety: the app is launched with its own `--user-data-dir` under the temp
 * directory, so it reads and writes a throwaway vault and can never touch the
 * real one in `%APPDATA%/nile-vault`. The wallet it generates is disposable.
 *
 * Usage: npm run verify:ui
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { base64 } from "@scure/base";
import { Address } from "@ton/core";
import nacl from "tweetnacl";

const ROOT = process.cwd();
const EXE =
  process.env.NILEVAULT_EXE || path.join(ROOT, "dist", "win-unpacked", "NileVault.exe");
const PORT = Number(process.env.CDP_PORT || 9333);
const USER_DATA = path.join(tmpdir(), "nilevault-tonconnect-verify");
const SHOTS = path.join(ROOT, "dist", "tonconnect-verify");
const PASSPHRASE = "verify-passphrase-1";

/** The two reported links, unmodified. */
const LINKS = [
  {
    label: "link-1-sixseven",
    url: "tc://?v=2&id=dcb2bbdf5390e3a8a21e4e545532dae678d0746434a4306de271455ba16a6b00&r=%7B%22manifestUrl%22%3A%22https%3A%2F%2Fsixseven-dev-tgops.s3.eu-central-1.amazonaws.com%2Ftonconnect%2Fton-manifest.json%22%2C%22items%22%3A%5B%7B%22name%22%3A%22ton_addr%22%7D%2C%7B%22name%22%3A%22ton_proof%22%2C%22payload%22%3A%226f8f6532c4672aec000000006aab7be5a3cdf6409423025d57ddc8fd9f44eaaf4798fc9498524e7d0d16941bd54c8988%22%7D%5D%7D",
    expectApp: "Six Seven Club",
  },
  {
    label: "link-2-rignite",
    url: "tc://?v=2&id=a5350a20b2121748cd703da51976526d2bd0fabaf96b4078eeb24f36167f3578&trace_id=01a0addf-e14c-771e-8fe4-9e2828960d4a&r=%7B%22manifestUrl%22%3A%22https%3A%2F%2Fapp.rignite.app%2Ftonconnect-manifest.json%22%2C%22items%22%3A%5B%7B%22name%22%3A%22ton_addr%22%7D%2C%7B%22name%22%3A%22ton_proof%22%2C%22payload%22%3A%226a33e002435035329e97ca8b603dd5bd9e4bdad517fae2230c1e8a4746c8744d%22%7D%5D%7D",
    expectApp: "Rignite",
  },
];

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`  \u2717 ${msg}`);
};
const pass = (msg) => console.log(`  \u2713 ${msg}`);

/* ── minimal DevTools-protocol client ─────────────────────────────────────── */

/**
 * Kill the app (and its renderer children).
 *
 * `taskkill` is not always on PATH — it lives in System32 — and a surviving
 * instance would keep the debug port and the profile directory, so the next run
 * would attach to a half-driven window instead of a fresh one.
 */
function killApp(pid) {
  const taskkill = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "taskkill.exe",
  );
  const args = pid ? ["/PID", String(pid), "/T", "/F"] : ["/IM", "NileVault.exe", "/T", "/F"];
  const result = spawnSync(taskkill, args, { stdio: "ignore" });
  if (result.error) console.warn(`  (could not run taskkill: ${result.error.message})`);
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 0;

    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(event.data);
      const entry = frame.id && pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      if (frame.error) entry.reject(new Error(frame.error.message));
      else entry.resolve(frame.result);
    });
    socket.addEventListener("error", () => reject(new Error("CDP socket error")));
    socket.addEventListener("open", () =>
      resolve({
        send(method, params = {}) {
          nextId += 1;
          const id = nextId;
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close: () => socket.close(),
      }),
    );
  });
}

async function findPageTarget() {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find(
        (t) => t.type === "page" && t.webSocketDebuggerUrl && t.url.includes("index.html"),
      );
      if (page) return page;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("the packaged app never exposed a debuggable page target");
}

/* ── page-side helpers ────────────────────────────────────────────────────── */

/**
 * Installed inside the renderer. React ignores `el.value = x`, so input values
 * are set through the prototype descriptor and announced with a real `input`
 * event — the same thing a paste does.
 */
const PRELUDE = `window.__nc = {
  text: () => document.body.innerText,
  /*
    Buttons are matched by visible label, but an open dialog owns the click:
    clicking a button *behind* a modal is never what a user means, and an open
    modal renders later in the DOM than the page it covers. Exact matching is
    available for labels that are substrings of others ("Create" vs
    "Create a wallet").
  */
  button: (label, exact = false) => {
    const live = [...document.querySelectorAll("button")].filter((b) => !b.disabled);
    const test = (b) => {
      const text = (b.textContent || "").trim();
      return exact ? text === label : text.includes(label);
    };
    const dialog = document.querySelector('[role="dialog"]');
    if (dialog) {
      const inside = live.filter((b) => dialog.contains(b)).find(test);
      if (inside) return inside;
    }
    return live.filter((b) => !dialog || !dialog.contains(b)).find(test) || null;
  },
  click: (label, exact = false) => {
    const b = window.__nc.button(label, exact);
    if (!b) return false;
    b.click();
    return true;
  },
  setValue: (el, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
    descriptor.set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  fill: (selector, value, index = 0) => {
    const el = document.querySelectorAll(selector)[index];
    if (!el) return false;
    window.__nc.setValue(el, value);
    return true;
  },
  /* The manifest icon is a remote image: report whether it is actually drawn. */
  sheetIcons: () => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return { count: 0, loaded: false };
    const remote = [...dialog.querySelectorAll("img")].filter((i) => /^https?:/.test(i.src));
    return {
      count: remote.length,
      loaded:
        remote.length > 0 && remote.every((i) => i.complete && i.naturalWidth > 0),
    };
  },
  /* Live toast text only — page text keeps matches from earlier states. */
  toasts: () => {
    const nodes = new Set();
    document.querySelectorAll('[role="status"], [aria-live]').forEach((n) => nodes.add(n));
    return [...nodes].map((n) => n.innerText || "").join(" | ");
  },
}; "ready"`;

function makeDriver(cdp) {
  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
    }
    return result.result.value;
  };

  const screenshot = async (name) => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    const file = path.join(SHOTS, `${name}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    return path.relative(ROOT, file);
  };

  return {
    evaluate,
    screenshot,
    /**
     * Poll from Node, not from the page.
     *
     * A window that is not in the foreground has its renderer timers throttled —
     * severely once it has been backgrounded for a few minutes — so a page-side
     * `setTimeout` loop can take minutes to finish. Node's timers are never
     * throttled, and each poll is a synchronous expression in the page.
     */
    async waitFor(expression, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let value = false;
        try {
          value = await evaluate(expression);
        } catch {
          value = false;
        }
        if (value) return value;
        if (Date.now() > deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    },
    click: (label, exact = false) =>
      evaluate(`window.__nc.click(${JSON.stringify(label)}, ${exact})`),
    fill: (selector, value, index = 0) =>
      evaluate(`window.__nc.fill(${JSON.stringify(selector)}, ${JSON.stringify(value)}, ${index})`),
    text: () => evaluate("window.__nc.text()"),
  };
}

/* ── the flow ─────────────────────────────────────────────────────────────── */

/** Paste a link into the Connect field and press Connect. */
async function pasteLink(driver, url) {
  await driver.waitFor('!!document.querySelector(\'input[placeholder="tc://..."]\')');
  const filled = await driver.fill('input[placeholder="tc://..."]', url);
  if (!filled) throw new Error("the Connect-via-link field is not on the page");
  await driver.click("Connect");
}

/** How many "Wallet connected" toasts are on screen right now. */
const connectedToasts = (text) => (text.match(/Wallet connected/g) || []).length;

/**
 * Press Approve and wait for that approval to actually finish.
 *
 * Waiting on "a toast says Wallet connected" is not enough: an unfocused window
 * pauses react-hot-toast's dismiss timer, so an earlier approval's toast can
 * still be on screen and would satisfy the wait instantly — letting the next
 * stage run while this approval was still in flight. So the wait is on a *new*
 * toast *and* on the sheet closing, which is what "approval completed" means.
 */
async function approveAndConfirm(driver) {
  const baseline = connectedToasts(await driver.evaluate("window.__nc.toasts()"));

  const clicked = await driver.click("Approve");
  if (!clicked) {
    fail("the Approve button was not available");
    return false;
  }

  const closed = await driver.waitFor(
    '!document.body.innerText.includes("Connect Wallet")',
    30_000,
  );
  if (!closed) {
    fail("the sheet stayed open after Approve");
    return false;
  }

  const toasted = await driver.waitFor(
    `window.__nc.toasts().split("Wallet connected").length - 1 > ${baseline}`,
    30_000,
  );
  if (toasted) pass('approval completed — "Wallet connected"');
  else fail("approval never reported success (the old crash)");

  return true;
}

async function main() {
  if (!existsSync(EXE)) {
    console.error(`No packaged app at ${EXE} — run \`npx electron-builder --win\` first.`);
    process.exit(1);
  }

  // Any instance from an earlier run would hold both the profile and the port.
  killApp(null);
  await new Promise((resolve) => setTimeout(resolve, 900));

  rmSync(USER_DATA, { recursive: true, force: true });
  rmSync(SHOTS, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });

  console.log("TON Connect UI verification against the packaged build");
  console.log(`  exe:      ${path.relative(ROOT, EXE)}`);
  console.log(`  vault:    ${USER_DATA} (throwaway)`);
  console.log(`  shots:    ${path.relative(ROOT, SHOTS)}\n`);

  const child = spawn(
    EXE,
    [`--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${PORT}`, "--no-first-run"],
    { stdio: "ignore" },
  );

  // A GUI harness must not hang forever: bail out and clean up instead.
  const watchdog = setTimeout(() => {
    console.error("\nharness timed out after 5 minutes — killing the app\n");
    killApp(child.pid);
    process.exit(1);
  }, 300_000);

  let cdp;
  try {
    const target = await findPageTarget();
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    const driver = makeDriver(cdp);

    // Foreground the window: it keeps the renderer unthrottled and makes
    // focus-dependent UI (toast dismissal) behave as it does for a user.
    await cdp.send("Page.enable");
    await cdp.send("Page.bringToFront").catch(() => {});
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    await driver.evaluate(PRELUDE);

    /* ── bring the app up on a disposable vault ──────────────────────── */

    console.log("first run");

    if (await driver.waitFor('!!window.__nc.button("Continue")', 30_000)) {
      await driver.click("Continue");
      pass("network check offered Continue");
    } else {
      fail("the network check never offered Continue");
    }

    if (await driver.waitFor('document.querySelectorAll(\'input[type="password"]\').length > 0')) {
      await driver.fill('input[type="password"]', PASSPHRASE, 0);
      await driver.fill('input[type="password"]', PASSPHRASE, 1);
      await driver.click("Set passphrase");
      pass("vault passphrase set");
    } else {
      fail("the passphrase form never appeared");
    }

    if (await driver.waitFor('document.body.innerText.includes("Your vault is empty")')) {
      await driver.click("Create a wallet");
      await driver.waitFor('!!document.querySelector(\'input[placeholder="e.g. Main"]\')');
      await driver.fill('input[placeholder="e.g. Main"]', "Verify");
      await driver.click("Create", true);

      if (await driver.waitFor('document.body.innerText.includes("Set up your wallet")')) {
        pass("wallet created and opened");
      } else {
        const text = await driver.text();
        fail(`the new wallet did not open — page said:\n${text.slice(0, 400)}`);
      }
    } else {
      fail("the wallet picker never showed its empty state");
    }

    if (await driver.waitFor('!!window.__nc.button("Generate new wallet")')) {
      await driver.click("Generate new wallet");
      pass("recovery phrase generated");
    } else {
      const text = await driver.text();
      fail(`the wallet setup step never appeared — page said:\n${text.slice(0, 400)}`);
    }

    if (await driver.waitFor('!!document.querySelector(\'input[placeholder="tc://..."]\')')) {
      pass("wallet page is rendered with the Connect-via-link field");
    } else {
      fail("the wallet page never rendered the link field");
    }
    console.log(`  → screenshot ${await driver.screenshot("00-wallet-page")}`);

    /* ── both real links ─────────────────────────────────────────────── */

    const approved = [];

    for (const { label, url, expectApp } of LINKS) {
      console.log(`\n${label}`);

      try {
        await pasteLink(driver, url);
      } catch (error) {
        fail(`paste failed: ${error.message}`);
        continue;
      }

      const opened = await driver.waitFor('document.body.innerText.includes("Connect Wallet")');
      if (!opened) {
        fail("no approval sheet appeared");
        console.log(`  → screenshot ${await driver.screenshot(`${label}-no-sheet`)}`);
        continue;
      }
      pass("approval sheet opened");

      const sheet = await driver.evaluate(
        `(() => {
          const dialog = document.querySelector('[role="dialog"]');
          return dialog ? dialog.innerText : "";
        })()`,
      );
      if (sheet.includes(expectApp)) pass(`sheet names the dApp from its manifest: "${expectApp}"`);
      else fail(`sheet does not name "${expectApp}" — text was:\n${sheet}`);

      const host = expectApp === "Rignite" ? "app.rignite.app" : "prod.6sixseven7.club";
      if (sheet.includes(host)) pass(`sheet shows the requesting host (${host})`);
      else fail(`sheet does not show the host ${host}`);

      // The sheet renders the account through `truncateAddress`, so the match is
      // on the prefix, not on the whole 48-character form.
      if (/[EU]Q[A-Za-z0-9_-]{4,}|-?\d+:[0-9a-fA-F]{8,}/.test(sheet)) {
        pass("sheet shows the account being connected");
      } else {
        fail("sheet does not show the account address");
      }

      if (sheet.includes("signed proof of ownership")) {
        pass("sheet discloses the requested ton_proof");
      } else {
        fail("sheet does not mention the requested ton_proof");
      }

      // A URL in the manifest is not the same as a rendered icon: the remote
      // image still has to load under the app's CSP, and some dApps ship
      // 200 KB icons — wait for it before calling it broken.
      const iconLoaded = await driver.waitFor("window.__nc.sheetIcons().loaded", 15_000);
      const icons = await driver.evaluate("window.__nc.sheetIcons()");
      if (icons.count === 0) fail("the sheet did not render the manifest icon");
      else if (iconLoaded) pass("the manifest icon is loaded in the sheet");
      else fail("the manifest icon element is present but never loaded");

      console.log(`  → screenshot ${await driver.screenshot(`${label}-approval-sheet`)}`);

      await approveAndConfirm(driver);

      const after = await driver.text();
      const address = (after.match(/[EU]Q[A-Za-z0-9_-]{46}/) || [])[0];
      if (address) {
        approved.push({ label, address });
        pass(`wallet address shown in the app: ${address}`);
      } else {
        fail("no wallet address is visible after approving");
      }

      // The Connected-apps query is invalidated by the approval; give it a tick
      // before reading the list.
      if (await driver.waitFor(`document.body.innerText.includes(${JSON.stringify(expectApp)})`, 15_000)) {
        pass(`${expectApp} is listed under Connected apps`);
      } else {
        fail(`${expectApp} is not listed under Connected apps`);
      }

      console.log(`  → screenshot ${await driver.screenshot(`${label}-approved`)}`);
    }

    /* ── reject ──────────────────────────────────────────────────────── */

    console.log("\nreject");

    try {
      /*
        Compare against the state *before* rejecting rather than insisting the
        page is clean: an unfocused window pauses react-hot-toast's dismiss
        timer, so the earlier "Wallet connected" toast can still be on screen.
        What matters is that rejecting does not add another one.
      */
      const toastsBefore = await driver.evaluate("window.__nc.toasts()");
      const sessionsBefore = (await driver.text()).split("Disconnect").length - 1;

      await pasteLink(driver, LINKS[0].url);
      if (await driver.waitFor('document.body.innerText.includes("Connect Wallet")')) {
        // A busy sheet disables both buttons, and the page behind it still has
        // clickable buttons — so confirm Reject is live before pressing it.
        const rejectable = await driver.waitFor('!!window.__nc.button("Reject")', 20_000);
        const clicked = rejectable ? await driver.click("Reject") : false;
        if (!clicked) fail("the Reject button was not available to press");

        const closed = await driver.waitFor(
          '!document.body.innerText.includes("Connect Wallet")',
          15_000,
        );
        if (clicked && closed) pass("reject closed the sheet without a crash");
        else if (!clicked) fail("reject left the sheet to something else");
        else fail("reject left the sheet open");

        const text = await driver.text();
        const toastsAfter = await driver.evaluate("window.__nc.toasts()");
        if (connectedToasts(toastsAfter) > connectedToasts(toastsBefore)) {
          fail(`reject reported a successful connection — live toasts: ${toastsAfter}`);
        } else {
          pass("reject did not report a connection");
        }

        const sessionsAfter = text.split("Disconnect").length - 1;
        if (sessionsAfter === sessionsBefore) {
          pass("reject left no new session behind");
        } else {
          fail("reject added a session to Connected apps");
        }

        if (text.includes("Connect via link")) pass("the app is still usable after rejecting");
        else fail("the page did not survive the reject");

        console.log(`  → screenshot ${await driver.screenshot("reject-after")}`);
      } else {
        fail("the sheet never opened for the reject test");
      }
    } catch (error) {
      fail(`reject failed: ${error.message}`);
    }

    /* ── malformed link ─────────────────────────────────────────────── */

    console.log("\nmalformed link");

    try {
      await pasteLink(driver, LINKS[0].url.slice(0, 200));
      const reported = await driver.waitFor(
        'document.body.innerText.includes("Invalid connect link")',
        15_000,
      );
      if (reported) pass('reported "Invalid connect link" instead of crashing');
      else {
        const text = await driver.text();
        fail(`no validation message appeared — page said:\n${text.slice(0, 400)}`);
      }
      console.log(`  → screenshot ${await driver.screenshot("malformed-link")}`);
    } catch (error) {
      fail(`malformed link handling threw: ${error.message}`);
    }

    /* ── what the bridge actually received ──────────────────────────── */

    console.log("\ntransport");

    const dApp = nacl.box.keyPair();
    const dAppPublicKey = Buffer.from(dApp.publicKey).toString("hex");
    const payload = "deadbeef000000016aab7be5a3cdf6409423025d57ddc8fd9f44eaaf";
    const link = `tc://?${new URLSearchParams({
      v: "2",
      id: dAppPublicKey,
      trace_id: "01a0addf-e14c-771e-8fe4-9e2828960d4a",
      r: JSON.stringify({
        manifestUrl: "https://app.rignite.app/tonconnect-manifest.json",
        items: [{ name: "ton_addr" }, { name: "ton_proof", payload }],
      }),
    })}`;

    const controller = new AbortController();
    const readBack = (async () => {
      const res = await fetch(
        `https://bridge.tonapi.io/bridge/events?client_id=${dAppPublicKey}`,
        { signal: controller.signal },
      );
      if (!res.ok || !res.body) return null;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              const data = JSON.parse(line.slice(5).trim());
              if (data?.message) return data;
            } catch {
              /* heartbeat */
            }
          }
        }
      }
    })().catch(() => null);

    try {
      await pasteLink(driver, link);
      await driver.waitFor('document.body.innerText.includes("Connect Wallet")');
      await approveAndConfirm(driver);

      const received = await Promise.race([
        readBack,
        new Promise((resolve) => setTimeout(() => resolve(null), 25_000)),
      ]);
      controller.abort();

      if (!received) {
        fail("the bridge did not deliver the ConnectEvent published by the app");
      } else {
        const full = base64.decode(received.message);
        const plain = nacl.box.open(
          full.slice(24),
          full.slice(0, 24),
          Buffer.from(received.from, "hex"),
          dApp.secretKey,
        );
        if (!plain) {
          fail("the published ConnectEvent is not decryptable");
        } else {
          const event = JSON.parse(new TextDecoder().decode(plain));
          pass(`the app published a "${event.event}" event the dApp can decrypt`);

          const tonAddr = event.payload.items.find((i) => i.name === "ton_addr");
          const proof = event.payload.items.find((i) => i.name === "ton_proof");
          const expected = approved[0]?.address;

          if (expected && Address.parse(tonAddr.address).toRawString() === Address.parse(expected).toRawString()) {
            pass(`ton_addr matches the account shown in the UI (${tonAddr.address})`);
          } else {
            fail("ton_addr does not match the account shown in the UI");
          }
          if (proof?.proof?.payload === payload) pass("ton_proof echoes the requested payload");
          else fail("ton_proof payload mismatch");

          console.log(`  → screenshot ${await driver.screenshot("transport-approved")}`);
        }
      }
    } catch (error) {
      controller.abort();
      fail(`transport check threw: ${error.message}`);
    }

    /* ── summary ────────────────────────────────────────────────────── */

    console.log("\nresults");
    for (const { label, address } of approved) {
      console.log(`  approved ${label}: ${address}`);
    }

    if (failures) {
      console.log(`\n${failures} problem(s) — the packaged build is not verified.\n`);
    } else {
      console.log("\nthe packaged build parsed, approved and published both links.\n");
    }
  } finally {
    clearTimeout(watchdog);
    if (cdp) cdp.close();
    killApp(child.pid);
  }

  setTimeout(() => process.exit(failures ? 1 : 0), 50);
}

main().catch((error) => {
  console.error("\nharness crashed:\n", error);
  killApp(null);
  process.exit(1);
});
