import type * as React from "react";
import { Command as CommandPrimitive } from "cmdk";

import { cn } from "../../utils";
import "./command.css";
import { passwordManagerIgnore } from "../../passwordManagerIgnore";

const Command = ({
  className,
  ...props
}: React.ComponentPropsWithRef<typeof CommandPrimitive>) => (
  <CommandPrimitive className={cn("command", className)} {...props} />
);
Command.displayName = CommandPrimitive.displayName;

const CommandInput = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithRef<typeof CommandPrimitive.Input>) => (
  <CommandPrimitive.Input
    className={cn("command-input", className)}
    autoComplete="off"
    {...passwordManagerIgnore}
    {...props}
    ref={(input: HTMLInputElement | null) => {
      // cmdk renders type="text" over ours; a search field is what keeps
      // Bitwarden's menu away.
      if (input) input.type = passwordManagerIgnore.type;
      if (typeof ref === "function") ref(input);
      else if (ref) ref.current = input;
    }}
  />
);
CommandInput.displayName = CommandPrimitive.Input.displayName;

const CommandList = ({
  className,
  ...props
}: React.ComponentPropsWithRef<typeof CommandPrimitive.List>) => (
  <CommandPrimitive.List className={cn("command-list", className)} {...props} />
);
CommandList.displayName = CommandPrimitive.List.displayName;

const CommandEmpty = ({
  className,
  ...props
}: React.ComponentPropsWithRef<typeof CommandPrimitive.Empty>) => (
  <CommandPrimitive.Empty
    className={cn("command-empty", className)}
    {...props}
  />
);
CommandEmpty.displayName = CommandPrimitive.Empty.displayName;

const CommandGroup = ({
  className,
  ...props
}: React.ComponentPropsWithRef<typeof CommandPrimitive.Group>) => (
  <CommandPrimitive.Group
    className={cn("command-group", className)}
    {...props}
  />
);
CommandGroup.displayName = CommandPrimitive.Group.displayName;

const CommandItem = ({
  className,
  ...props
}: React.ComponentPropsWithRef<typeof CommandPrimitive.Item>) => (
  <CommandPrimitive.Item className={cn("command-item", className)} {...props} />
);
CommandItem.displayName = CommandPrimitive.Item.displayName;

const CommandShortcut = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) => {
  return <span className={cn("command-shortcut", className)} {...props} />;
};
CommandShortcut.displayName = "CommandShortcut";

export {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
};
