import { cn } from "@/utils";

/**
 * Field — label, control and inline validation message.
 *
 * The message slot has a fixed minimum height, so validation text appearing or
 * changing never reflows the card around it (previously a validation line
 * shoved the whole form down on every keystroke). The message is keyed on its
 * own text, so replacing one message with another replays the short rise
 * animation instead of snapping.
 */
export default function Field({
  label,
  hint,
  error,
  success,
  trailing,
  className,
  inputClassName,
  children,
  as,
}) {
  // A <label> wrapping another interactive control would make clicks on it
  // focus the input instead, so any field with a trailing action renders as a
  // plain block.
  const Component = as || (trailing ? "div" : "label");
  const message = error || success || hint;
  const tone = error
    ? "text-red-400"
    : success
      ? "text-emerald-400 dark:text-emerald-400"
      : "text-neutral-500";

  return (
    <Component className={cn("flex flex-col gap-1.5", className)}>
      {label || trailing ? (
        <span className="flex items-center justify-between gap-2">
          {label ? <span className="nc-label">{label}</span> : <span />}
          {trailing}
        </span>
      ) : null}

      {children}

      <span
        className={cn(
          "nc-message flex items-center gap-1 transition-colors duration-[var(--nc-dur)]",
          tone,
          inputClassName,
        )}
        role={error ? "alert" : undefined}
        aria-live="polite"
      >
        {message ? (
          <span key={message} className="nc-anim-rise inline-block">
            {message}
          </span>
        ) : null}
      </span>
    </Component>
  );
}
