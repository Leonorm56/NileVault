import { forwardRef, useState } from "react";
import { MdVisibility, MdVisibilityOff } from "react-icons/md";

import Input from "./Input";
import IconButton from "./IconButton";

/**
 * Password input with a reveal toggle.
 *
 * The toggle previously had no hover state and was positioned with
 * `top-0 right-0 h-full`, which pushed it out of alignment with the field's
 * rounded corners. It is now a shared IconButton, vertically centred, with its
 * own accessible name reflecting what the next click will do.
 */
const PasswordInput = forwardRef(function PasswordInput(
  { className, iconClassName, ...props },
  ref,
) {
  const [shown, setShown] = useState(false);

  return (
    <div className="relative">
      <Input
        {...props}
        ref={ref}
        type={shown ? "text" : "password"}
        className={`pr-11 ${className || ""}`}
      />
      <div className="absolute inset-y-0 right-1 flex items-center">
        <IconButton
          label={shown ? "Hide password" : "Show password"}
          tabIndex={-1}
          disabled={props.disabled}
          onClick={() => setShown((value) => !value)}
          className={iconClassName}
        >
          {shown ? (
            <MdVisibility className="size-4" />
          ) : (
            <MdVisibilityOff className="size-4" />
          )}
        </IconButton>
      </div>
    </div>
  );
});

export default PasswordInput;
