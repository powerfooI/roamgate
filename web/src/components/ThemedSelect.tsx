import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../utils";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import "./ThemedSelect.css";

export type ThemedSelectOption = {
  value: string;
  label: string;
  detail?: string;
  keywords?: string[];
};

// Themed replacement for the native <select>: cmdk provides arrow/Home/End/
// Enter keyboard support and the popover handles Escape and outside clicks,
// so the dropdown matches the command menu instead of the OS popup.
export function ThemedSelect({
  value,
  options,
  onChange,
  icon,
  className,
  align = "start",
  "aria-label": ariaLabel,
  title,
  placeholder,
  disabled = false,
  searchPlaceholder,
  emptyText = "No models found",
  side,
  contentClassName,
  onSelectedClose,
}: {
  value: string;
  options: ThemedSelectOption[];
  onChange: (value: string) => void;
  icon?: ReactNode;
  className?: string;
  align?: "start" | "center" | "end";
  "aria-label"?: string;
  title?: string;
  placeholder?: string;
  disabled?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  side?: "top" | "bottom";
  contentClassName?: string;
  onSelectedClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(value);
  const selected = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener("popstate", close);
    return () => window.removeEventListener("popstate", close);
  }, []);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const current = options.find((option) => option.value === value);
  return (
    <Popover
      open={open && !disabled}
      onOpenChange={(next) => {
        setOpen(next && !disabled);
        if (next && !disabled) {
          selected.current = false;
          setHighlighted(value);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn("themed-select-trigger", className)}
          aria-label={ariaLabel}
          title={title}
          disabled={disabled}
        >
          {icon ?? (
            <>
              <span className="themed-select-value">
                {current?.label ?? placeholder ?? value}
              </span>
              <ChevronDown size={13} aria-hidden="true" />
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={cn("themed-select-content", contentClassName)}
        align={align}
        side={side}
        collisionPadding={8}
        onOpenAutoFocus={(event) => {
          if (!searchPlaceholder) {
            event.preventDefault();
            listRef.current?.focus();
          }
        }}
        onCloseAutoFocus={(event) => {
          if (selected.current && onSelectedClose) {
            event.preventDefault();
            onSelectedClose();
          }
          selected.current = false;
        }}
        onEscapeKeyDown={(event) => event.stopPropagation()}
      >
        <Command
          loop
          shouldFilter={!!searchPlaceholder}
          tabIndex={-1}
          value={highlighted}
          onValueChange={setHighlighted}
          aria-label={ariaLabel}
        >
          {searchPlaceholder ? (
            <CommandInput
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
            />
          ) : null}
          <CommandList ref={listRef} label={ariaLabel}>
            {searchPlaceholder ? (
              <CommandEmpty>{emptyText}</CommandEmpty>
            ) : null}
            {options.map((option) => (
              <CommandItem
                key={option.value}
                value={option.value}
                keywords={[
                  option.label,
                  option.detail ?? "",
                  ...(option.keywords ?? []),
                ]}
                onSelect={() => {
                  if (disabled) return;
                  selected.current = true;
                  setOpen(false);
                  onChange(option.value);
                }}
              >
                <span className="command-item-icon">
                  {option.value === value ? (
                    <Check size={14} aria-hidden="true" />
                  ) : null}
                </span>
                <span className="command-item-text">
                  <span className="command-item-title">{option.label}</span>
                  {option.detail ? (
                    <span className="command-item-detail">{option.detail}</span>
                  ) : null}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
