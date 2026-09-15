import { Check, ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "../utils";
import { Command, CommandItem, CommandList } from "./ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import "./ThemedSelect.css";

export type ThemedSelectOption = {
  value: string;
  label: string;
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
}: {
  value: string;
  options: ThemedSelectOption[];
  onChange: (value: string) => void;
  icon?: ReactNode;
  className?: string;
  align?: "start" | "center" | "end";
  "aria-label"?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(value);
  const current = options.find((option) => option.value === value);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setHighlighted(value);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn("themed-select-trigger", className)}
          aria-label={ariaLabel}
          title={title}
        >
          {icon ?? (
            <>
              <span className="themed-select-value">
                {current?.label ?? value}
              </span>
              <ChevronDown size={13} aria-hidden="true" />
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="themed-select-content" align={align}>
        <Command
          loop
          shouldFilter={false}
          value={highlighted}
          onValueChange={setHighlighted}
          aria-label={ariaLabel}
        >
          <CommandList>
            {options.map((option) => (
              <CommandItem
                key={option.value}
                value={option.value}
                onSelect={() => {
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
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
