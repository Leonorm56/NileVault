# Working Agreement

Follow this process for every feature, fix, or change. Do not skip steps
for "small" changes.

## 1. Plan first
Before writing any code, write a short plan: what will change, which files
are affected, what the approach is. Get explicit confirmation on the plan
before implementing.

## 2. Test first (TDD)
- Write a failing test that reproduces the bug or defines the new behavior
  (RED).
- Implement the minimal code to make it pass (GREEN).
- Refactor for clarity once it's passing.

## 3. Implement
Only after plan + failing test exist. Keep changes scoped to what the plan
described — no unrelated cleanup mixed into the same change.

## 4. Self-review
Before calling anything done, review your own diff as if you were seeing it
fresh: look for regressions, leftover debug code, unhandled edge cases, and
whether the change actually matches the original plan.

## 5. Verify
- Run the test suite and confirm it passes.
- For anything touching wallet logic, TON Connect, key handling, sessions,
  or proxies (NileVault, NileWallet, NileChain connect/send flows): manual
  verification in the PACKAGED BUILD (not dev mode) with real mainnet
  transactions is required. Unit tests alone are not sufficient — this
  project has a documented history of critical bugs (blank screen, send
  crashes) that only appeared in the packaged .exe despite 45/45 unit
  tests passing.
- No commits until verified against this standard.

## 6. Report
One final report at the end of the task — what changed, what was verified,
and how. No mid-task check-ins unless something blocks progress entirely.

## 7. AIZEN — the ship trigger
"AIZEN" is the codeword for ship: commit, cut the release, deploy to the
server. It is the explicit user ask that section 5's no-commit rule waits for.

- Only on the word. Never run it on your own initiative, and never treat it as
  the natural end of "finishing" a task. No word, no ship.
- Section 5 must already be satisfied. Unverified work is not shippable, and a
  passing unit test suite is not verification for wallet, TON Connect, key
  handling, session or proxy changes.
- Then, in order:
  1. Review `git status` and `git diff` first, and commit only the files this
     change touched — never `git add -A`, and never commit changes you did not
     make. Match the repository's existing commit message style.
  2. Bump the version, because AIZEN is the explicit ask for it (see section 8).
  3. Build the release artifacts using the project's existing release script or
     build config, not an improvised one.
  4. Deploy to the project's server and restart its process — use the deployed
     project's own service manager, and confirm the process came back up.
  5. Verify the deployed version is actually the new one and is serving, then
     report the commit, the release, and the deploy, naming what you verified.
- If the project has no server, AIZEN stops after the release. If a step needs
  credentials, permissions, or a decision you do not have, stop and ask — do not
  improvise, and do not re-run a deploy to "make it work".

## 8. Version bumps — only on request
- Never bump a version on your own initiative. Not after a fix, not after a
  rebuild, not to make a new artifact distinguishable from the last one.
- Bump only when the user explicitly says to bump. AIZEN (section 7) is such an
  ask; a green test run, a finished task, or a rebuild is not.
- Rebuilds keep the existing version. Build the same version again and say
  plainly that the version did not change.
- Same rule for installers, releases, tags, and artifact/zip names: touch them
  only when asked, and never invent a version number to label them.
- If a version was bumped without being asked, say so in the report rather than
  quietly keeping it.
