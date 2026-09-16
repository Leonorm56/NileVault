import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind class names, de-duplicating conflicts. */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
