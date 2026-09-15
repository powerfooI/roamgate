import { X } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";
import "./CloseButton.css";

type CloseButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label" | "children" | "type"
> & {
  label?: string;
  variant?: "dialog" | "toast";
};

export function CloseButton({
  label = "Close",
  variant = "dialog",
  className,
  title,
  ...buttonProps
}: CloseButtonProps) {
  const classes = ["close-button", `close-button-${variant}`, className]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      {...buttonProps}
      type="button"
      className={classes}
      aria-label={label}
      title={title ?? label}
    >
      <X
        size={variant === "toast" ? 15 : 17}
        strokeWidth={2.2}
        aria-hidden="true"
      />
    </button>
  );
}
