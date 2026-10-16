import {
  HiOutlineArrowPath,
  HiOutlineEye,
  HiOutlineEyeSlash,
} from "react-icons/hi2";

import AddressRow from "@/components/AddressRow";
import AmountValue from "@/components/AmountValue";
import Button from "@/components/Button";
import IconButton from "@/components/IconButton";
import { Skeleton } from "@/components/Skeleton";
import { HIDDEN_MASK, buildHomeModel } from "@/lib/walletHome.js";
import TonCoinIcon from "@/assets/images/toncoin-ton-logo.svg";

/**
 * WalletCard — balance hero (S03), evolved from the old BalanceCard.
 *
 * Total comes from buildHomeModel (exact BigInt math, one masked display
 * path). Visible figures keep the animated AmountValue; hidden mode shows
 * the mask and never renders a figure.
 */
export default function WalletCard({
  address,
  shortened,
  balanceNano,
  isLoading,
  error,
  isFetching,
  onRefresh,
  actions = [],
  hidden = false,
  onToggleHidden,
  assetCount = 0,
}) {
  const model = buildHomeModel({
    holdings:
      balanceNano != null
        ? [{ symbol: "TON", balanceRaw: balanceNano, decimals: 9 }]
        : [],
    hidden,
  });

  return (
    <section aria-label="Wallet balance" className="nc-card-hero">
      <div className="nc-stack">
        <div className="flex items-center gap-2">
          <img src={TonCoinIcon} className="size-6" alt="" />
          <span className="nc-caption">Balance</span>
          {assetCount > 0 && !hidden ? (
            <span className="nc-caption tabular-nums opacity-70">
              +{assetCount} token{assetCount === 1 ? "" : "s"}
            </span>
          ) : null}
          <span className="ml-auto flex items-center gap-1">
            <IconButton
              label={hidden ? "Show balances" : "Hide balances"}
              onClick={onToggleHidden}
              aria-pressed={hidden}
            >
              {hidden ? (
                <HiOutlineEyeSlash className="size-4" />
              ) : (
                <HiOutlineEye className="size-4" />
              )}
            </IconButton>
            <IconButton
              label="Refresh balance"
              onClick={onRefresh}
              loading={isFetching}
            >
              <HiOutlineArrowPath className="size-4" />
            </IconButton>
          </span>
        </div>

        <div className="nc-balance text-foreground" aria-live="polite">
          {isLoading ? (
            // Matches the tightened .nc-balance line box, so the figure does
            // not shift when the skeleton resolves.
            <Skeleton className="h-9 w-48" />
          ) : error ? (
            <span className="text-neutral-500" title={error}>
              —
            </span>
          ) : hidden ? (
            <span aria-label="Balance hidden">{HIDDEN_MASK}</span>
          ) : (
            <AmountValue value={model.totalRaw} suffix=" TON" />
          )}
        </div>

        {address ? (
          <>
            <AddressRow address={address} display={shortened} />
            <p className="nc-caption -mt-1">
              Non-bounceable (UQ…) · tap to copy
            </p>
          </>
        ) : null}

        {actions.length > 0 ? (
          <div className="flex gap-2 pt-1">
            {actions.map((action, index) => (
              // One primary action per view: the first action is the gold CTA and
              // the rest are secondary. This used to hand-roll its own button
              // styles, which drifted from the Button component.
              <Button
                key={action.id}
                variant={index === 0 ? "default" : "secondary"}
                onClick={action.onClick}
                className="flex-1"
              >
                {action.icon ? <action.icon className="size-4" /> : null}
                {action.label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
