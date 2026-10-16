# Build log

One line per screen (replica-build). Fresh copy throughout, no original assets.

- S03 wallet home shell + hero + asset rows — 2026-10-11 — partial. AppShell left-nav (Settings disabled, later slice), WalletCard hero (exact total, hide toggle, no % change yet), AssetRow exact base-unit rows (no fiat yet). Send/receive/backup logic untouched. Harder than expected: nothing — queries shared cache keys so no extra fetches.
- UI restyle pass (shadcn structure, navy kept) — 2026-10-11 — done. Semantic tokens (background/foreground/card/muted/border/ring) in index.css; flat solid cards, hairline borders, pulse skeletons; gradients, glows, glass blur, lifts and gold floods removed. Gold remains on: primary buttons, focus rings, wordmark, sidebar active icon, pinned star, selected pills. Contrast 13/13 AA (destructive split into text-red #e5484d + button-red #c62f34 after the checker proved one red can't do both).
