/**
 * Send serialization for TON wallets.
 *
 * A TON wallet contract signs against a `seqno` that it reads from its own
 * data: the contract accepts a message only if the `seqno` inside it equals the
 * current one, and increments by exactly one afterwards. Two transfers signed
 * against the same `seqno` therefore cannot both land — validators take one and
 * drop the other, with no error surfaced to the sender.
 *
 * That race is reachable in this app from several directions at once: the send
 * form, a second window, and an inbound TON Connect request all reach the
 * signing step independently. This module makes them a queue:
 *
 *  - `withoutTransferConcurrency(key, task)` runs `task` only after the previous
 *    task for the same key has finished *and* whatever follow-up work it
 *    registered has finished. The follow-up matters: after broadcasting, a send
 *    keeps watching the chain until the wallet's `seqno` actually advances, and
 *    the next send must not read the old value in the meantime.
 *  - `markTransferInFlight` / `clearTransferInFlight` publish "a send is
 *    happening for this address" so cached wallet state (balance + seqno) is
 *    ignored while it is true. A cached `seqno` that is one behind is precisely
 *    how a signed transfer gets silently dropped.
 */

/** key → promise that resolves when the queue for that key is free. */
const gates = new Map();

/** Addresses with a transfer in progress. */
const inFlight = new Set();

function makeGate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * Run `task` with exclusive access to `key`.
 *
 * `task` receives `keepAlive(promise)`: any promise handed to it keeps the queue
 * closed until it settles, even after `task` itself has returned. Use it for the
 * post-broadcast seqno wait.
 */
export function withoutTransferConcurrency(key, task) {
  const previous = gates.get(key) ?? Promise.resolve();
  const gate = makeGate();

  const pending = []; // follow-up work registered via keepAlive
  let foregroundSettled = false;
  let released = false;

  const releaseIfDone = () => {
    if (released || !foregroundSettled) return;
    if (pending.some((entry) => !entry.settled)) return;
    released = true;
    gate.release();
  };

  const keepAlive = (promise) => {
    const entry = { settled: false };
    pending.push(entry);
    Promise.resolve(promise)
      .catch(() => {})
      .then(() => {
        entry.settled = true;
        releaseIfDone();
      });
  };

  const result = previous.then(() => task(keepAlive));
  result.then(
    () => {
      foregroundSettled = true;
      releaseIfDone();
    },
    () => {
      foregroundSettled = true;
      releaseIfDone();
    },
  );

  gates.set(key, gate.promise);
  return result;
}

/** Mark that a transfer is being built/signed/broadcast for this address. */
export function markTransferInFlight(address) {
  inFlight.add(String(address));
}

/** Clear the in-flight mark (always in a `finally`). */
export function clearTransferInFlight(address) {
  inFlight.delete(String(address));
}

/** True while a transfer is in progress for this address. */
export function isTransferInFlight(address) {
  return inFlight.has(String(address));
}

/** Test hook: drop all queue state. */
export function resetTransferQueue() {
  gates.clear();
  inFlight.clear();
}
