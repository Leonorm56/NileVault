import { cn } from "@/utils";

/**
 * AppShell — desktop wallet chrome (S03 shell, My-Wallet-pattern left nav).
 *
 * Wide windows get a fixed 232px sidebar; narrow windows get a horizontal bar
 * under the header. Labels and structure are NileVault's own; only the UX
 * pattern (persistent section nav beside content) follows the recon map.
 */
export default function AppShell({ items = [], activeId, onSelect, children }) {
  return (
    <div className="flex w-full flex-col gap-4 px-5 py-4 lg:flex-row">
      <nav
        aria-label="Wallet sections"
        className="shrink-0 lg:sticky lg:top-[68px] lg:h-fit lg:w-58"
      >
        <ul className="flex gap-1.5 overflow-x-auto lg:flex-col">
          {items.map((item) => {
            const Icon = item.icon;
            const active = item.id === activeId;
            return (
              <li key={item.id} className="shrink-0 lg:shrink">
                <button
                  type="button"
                  onClick={() => onSelect?.(item.id)}
                  disabled={item.disabled}
                  aria-current={active ? "page" : undefined}
                  title={item.disabled ? "Coming in a later slice" : undefined}
                  className={cn(
                    "nc-press relative flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-sm font-medium",
                    // Selection is signalled once, by the gold marker. The icon
                    // used to tint gold as well, which spent the accent twice
                    // on the same state.
                    active
                      ? "border-border bg-accent text-foreground before:absolute before:left-0 before:top-1/2 before:h-4 before:w-[3px] before:-translate-y-1/2 before:rounded-r-full before:bg-primary"
                      : "border-transparent text-muted-foreground hover:border-input hover:text-accent-foreground",
                    item.disabled && "cursor-not-allowed opacity-40",
                  )}
                >
                  {Icon ? <Icon className="size-4 shrink-0" /> : null}
                  <span className="whitespace-nowrap">{item.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="min-w-0 grow">{children}</div>
    </div>
  );
}
