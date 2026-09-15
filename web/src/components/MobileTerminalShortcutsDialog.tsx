import { useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, Plus, RotateCcw, Trash2 } from "lucide-react";
import {
  MAX_MOBILE_TERMINAL_SHORTCUTS_PER_ROW,
  MAX_MOBILE_TERMINAL_SIDE_SHORTCUTS,
  MOBILE_TERMINAL_SHORTCUT_OPTIONS,
  defaultMobileTerminalShortcutRows,
  defaultMobileTerminalSideShortcuts,
  mobileTerminalShortcutOption,
  normalizeMobileTerminalShortcutRows,
  normalizeMobileTerminalSideShortcuts,
  type MobileTerminalShortcut,
  type MobileTerminalShortcutAction,
  type MobileTerminalShortcutRows,
  type MobileTerminalSideShortcuts,
} from "../mobileTerminalShortcuts";
import { CloseButton } from "./CloseButton";
import { focusDialogElement } from "./dialogFocus";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import "./MobileTerminalShortcutsDialog.css";

const OPTION_GROUPS = ["Control", "Basic", "Navigation", "Modified"] as const;
let nextShortcutId = 1;

type SelectedSlot =
  | {
      area: "panel";
      rowIndex: number;
      slotIndex: number;
    }
  | {
      area: "side";
      slotIndex: number;
    };

function cloneRows(
  rows: MobileTerminalShortcutRows,
): MobileTerminalShortcutRows {
  return rows.map((row) =>
    Array.from(
      { length: MAX_MOBILE_TERMINAL_SHORTCUTS_PER_ROW },
      (_, slotIndex) => {
        const shortcut = row[slotIndex];
        return shortcut ? { ...shortcut } : null;
      },
    ),
  ) as MobileTerminalShortcutRows;
}

function cloneSideShortcuts(
  shortcuts: MobileTerminalSideShortcuts,
): MobileTerminalSideShortcuts {
  return Array.from(
    { length: MAX_MOBILE_TERMINAL_SIDE_SHORTCUTS },
    (_, slotIndex) => {
      const shortcut = shortcuts[slotIndex];
      return shortcut ? { ...shortcut } : null;
    },
  );
}

function newShortcut(): MobileTerminalShortcut {
  return {
    id: `custom-${Date.now()}-${nextShortcutId++}`,
    label: "Esc",
    action: "escape",
  };
}

function ShortcutKeySelect({
  value,
  ariaLabel,
  openRequest,
  onChange,
}: {
  value: MobileTerminalShortcutAction;
  ariaLabel: string;
  openRequest: number;
  onChange: (action: MobileTerminalShortcutAction) => void;
}) {
  const currentItemRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeValue, setActiveValue] = useState(() => String(value));
  const currentOption = mobileTerminalShortcutOption(value);

  const setSelectorOpen = (next: boolean) => {
    setOpen(next);
    setSearch("");
    if (next) setActiveValue(valueRef.current);
  };

  useEffect(() => {
    if (openRequest === 0) return;
    setOpen(true);
    setSearch("");
    setActiveValue(valueRef.current);
  }, [openRequest]);

  return (
    <Popover open={open} onOpenChange={setSelectorOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`mobile-shortcut-key-trigger ${open ? "is-open" : ""}`}
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
        >
          <span>{currentOption?.label ?? value}</span>
          <ChevronsUpDown size={13} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="mobile-shortcut-key-popover"
        align="start"
        sideOffset={4}
        collisionPadding={12}
        data-mobile-shortcut-key-picker
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => currentItemRef.current?.focus());
        }}
      >
        <Command
          className="mobile-shortcut-key-command"
          loop
          value={activeValue}
          onValueChange={setActiveValue}
        >
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder="Search keys..."
            aria-label="Search terminal keys"
          />
          <CommandList>
            <CommandEmpty>No matching keys.</CommandEmpty>
            {OPTION_GROUPS.map((group) => (
              <CommandGroup heading={group} key={group}>
                {MOBILE_TERMINAL_SHORTCUT_OPTIONS.filter(
                  (option) => option.group === group,
                ).map((option) => {
                  const current = option.id === value;
                  return (
                    <CommandItem
                      ref={current ? currentItemRef : undefined}
                      tabIndex={current ? 0 : -1}
                      className="mobile-shortcut-key-option"
                      value={option.id}
                      keywords={[
                        option.label,
                        option.defaultButtonLabel,
                        group,
                      ]}
                      data-current={current ? "true" : "false"}
                      aria-label={`${option.label}${current ? ", selected" : ""}`}
                      key={option.id}
                      onSelect={() => {
                        onChange(option.id);
                        setSelectorOpen(false);
                      }}
                    >
                      <span>{option.label}</span>
                      <kbd>{option.defaultButtonLabel}</kbd>
                      <Check size={13} aria-hidden="true" />
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function MobileTerminalShortcutsDialog({
  open,
  rows,
  sideShortcuts,
  onChange,
  onSideChange,
  onClose,
}: {
  open: boolean;
  rows: MobileTerminalShortcutRows;
  sideShortcuts: MobileTerminalSideShortcuts;
  onChange: (rows: MobileTerminalShortcutRows) => void;
  onSideChange: (shortcuts: MobileTerminalSideShortcuts) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef(rows);
  const sideShortcutsRef = useRef(sideShortcuts);
  const onCloseRef = useRef(onClose);
  rowsRef.current = rows;
  sideShortcutsRef.current = sideShortcuts;
  onCloseRef.current = onClose;
  const [draft, setDraft] = useState<MobileTerminalShortcutRows>(() =>
    cloneRows(rows),
  );
  const [sideDraft, setSideDraft] = useState<MobileTerminalSideShortcuts>(() =>
    cloneSideShortcuts(sideShortcuts),
  );
  const [selectedSlot, setSelectedSlot] = useState<SelectedSlot | null>(null);
  const [keySelectorOpenRequest, setKeySelectorOpenRequest] = useState(0);

  useEffect(() => {
    if (!open) return;
    setDraft(cloneRows(rowsRef.current));
    setSideDraft(cloneSideShortcuts(sideShortcutsRef.current));
    setSelectedSlot(null);
    setKeySelectorOpenRequest(0);
    const cancelFocus = focusDialogElement(dialogRef.current);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (
        document.querySelector(
          '[data-mobile-shortcut-key-picker][data-state="open"]',
        )
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      cancelFocus();
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [open]);

  if (!open) return null;

  const selectPanelSlot = (rowIndex: number, slotIndex: number) => {
    setDraft((current) => {
      if (current[rowIndex][slotIndex]) return current;
      const next = cloneRows(current);
      next[rowIndex][slotIndex] = newShortcut();
      return next;
    });
    setSelectedSlot({ area: "panel", rowIndex, slotIndex });
    setKeySelectorOpenRequest((request) => request + 1);
  };

  const selectSideSlot = (slotIndex: number) => {
    setSideDraft((current) => {
      if (current[slotIndex]) return current;
      const next = cloneSideShortcuts(current);
      next[slotIndex] = newShortcut();
      return next;
    });
    setSelectedSlot({ area: "side", slotIndex });
    setKeySelectorOpenRequest((request) => request + 1);
  };

  const updateSelectedShortcut = (
    update: (shortcut: MobileTerminalShortcut) => MobileTerminalShortcut,
  ) => {
    if (!selectedSlot) return;
    if (selectedSlot.area === "side") {
      setSideDraft((current) => {
        const shortcut = current[selectedSlot.slotIndex];
        if (!shortcut) return current;
        const next = cloneSideShortcuts(current);
        next[selectedSlot.slotIndex] = update(shortcut);
        return next;
      });
      return;
    }
    setDraft((current) => {
      const shortcut = current[selectedSlot.rowIndex][selectedSlot.slotIndex];
      if (!shortcut) return current;
      const next = cloneRows(current);
      next[selectedSlot.rowIndex][selectedSlot.slotIndex] = update(shortcut);
      return next;
    });
  };

  const clearSelectedSlot = () => {
    if (!selectedSlot) return;
    if (selectedSlot.area === "side") {
      setSideDraft((current) => {
        const next = cloneSideShortcuts(current);
        next[selectedSlot.slotIndex] = null;
        return next;
      });
    } else {
      setDraft((current) => {
        const next = cloneRows(current);
        next[selectedSlot.rowIndex][selectedSlot.slotIndex] = null;
        return next;
      });
    }
    setSelectedSlot(null);
  };

  const selectedShortcut = selectedSlot
    ? selectedSlot.area === "side"
      ? sideDraft[selectedSlot.slotIndex]
      : draft[selectedSlot.rowIndex][selectedSlot.slotIndex]
    : null;
  const selectedOption = selectedShortcut
    ? mobileTerminalShortcutOption(selectedShortcut.action)
    : null;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal mobile-shortcuts-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Mobile terminal shortcuts"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>Mobile Terminal Shortcuts</h2>
            <p>
              Select any slot to add or edit a button. Configure the 2-by-8
              panel and up to four right-side buttons.
            </p>
          </div>
          <CloseButton onClick={onClose} />
        </div>

        <div className="mobile-shortcut-slot-board" aria-label="Shortcut slots">
          {draft.map((row, rowIndex) => (
            <section
              className="mobile-shortcut-slot-row"
              key={`row-${rowIndex}`}
            >
              <div className="mobile-shortcut-slot-row-label">
                <strong>Row {rowIndex + 1}</strong>
                <span>
                  {row.filter(Boolean).length} /{" "}
                  {MAX_MOBILE_TERMINAL_SHORTCUTS_PER_ROW}
                </span>
              </div>
              <div className="mobile-shortcut-slot-grid">
                {row.map((shortcut, slotIndex) => {
                  const selected =
                    selectedSlot?.area === "panel" &&
                    selectedSlot.rowIndex === rowIndex &&
                    selectedSlot.slotIndex === slotIndex;
                  const option = shortcut
                    ? mobileTerminalShortcutOption(shortcut.action)
                    : null;
                  return (
                    <button
                      type="button"
                      className={`mobile-shortcut-slot ${
                        shortcut ? "is-filled" : "is-empty"
                      } ${selected ? "is-selected" : ""}`}
                      aria-label={
                        shortcut
                          ? `Edit row ${rowIndex + 1} slot ${slotIndex + 1}, ${shortcut.label}, ${option?.label ?? shortcut.action}`
                          : `Add button to row ${rowIndex + 1} slot ${slotIndex + 1}`
                      }
                      aria-pressed={selected}
                      title={
                        shortcut
                          ? `${shortcut.label} · ${option?.label ?? shortcut.action}`
                          : `Add button to slot ${slotIndex + 1}`
                      }
                      onClick={() => selectPanelSlot(rowIndex, slotIndex)}
                      key={`slot-${rowIndex}-${slotIndex}`}
                    >
                      {shortcut ? (
                        <>
                          <strong>{shortcut.label}</strong>
                          <span>{option?.label ?? shortcut.action}</span>
                        </>
                      ) : (
                        <>
                          <Plus size={15} aria-hidden="true" />
                          <span>{slotIndex + 1}</span>
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <section
          className="mobile-shortcut-side-board"
          aria-label="Right-side shortcut slots"
        >
          <div className="mobile-shortcut-side-head">
            <div>
              <strong>Right-side buttons</strong>
              <span>Original Up / Dn position, top to bottom</span>
            </div>
            <span>{sideDraft.filter(Boolean).length} / 4</span>
          </div>
          <div className="mobile-shortcut-side-grid">
            {sideDraft.map((shortcut, slotIndex) => {
              const selected =
                selectedSlot?.area === "side" &&
                selectedSlot.slotIndex === slotIndex;
              const option = shortcut
                ? mobileTerminalShortcutOption(shortcut.action)
                : null;
              return (
                <button
                  type="button"
                  className={`mobile-shortcut-slot mobile-shortcut-side-slot ${
                    shortcut ? "is-filled" : "is-empty"
                  } ${selected ? "is-selected" : ""}`}
                  aria-label={
                    shortcut
                      ? `Edit side slot ${slotIndex + 1}, ${shortcut.label}, ${option?.label ?? shortcut.action}`
                      : `Add button to side slot ${slotIndex + 1}`
                  }
                  aria-pressed={selected}
                  title={
                    shortcut
                      ? `${shortcut.label} · ${option?.label ?? shortcut.action}`
                      : `Add side button ${slotIndex + 1}`
                  }
                  onClick={() => selectSideSlot(slotIndex)}
                  key={`side-slot-${slotIndex}`}
                >
                  {shortcut ? (
                    <>
                      <strong>{shortcut.label}</strong>
                      <span>{option?.label ?? shortcut.action}</span>
                    </>
                  ) : (
                    <>
                      <Plus size={15} aria-hidden="true" />
                      <span>{slotIndex + 1}</span>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </section>

        <section
          className={`mobile-shortcut-slot-editor ${
            selectedShortcut ? "is-active" : ""
          }`}
          aria-live="polite"
        >
          {selectedShortcut && selectedSlot ? (
            <>
              <div className="mobile-shortcut-slot-editor-head">
                <div>
                  <strong>
                    {selectedSlot.area === "side"
                      ? `Right-side slot ${selectedSlot.slotIndex + 1}`
                      : `Row ${selectedSlot.rowIndex + 1}, slot ${selectedSlot.slotIndex + 1}`}
                  </strong>
                  <span>Edit this button in place</span>
                </div>
                <button
                  type="button"
                  className="ghost is-danger"
                  onClick={clearSelectedSlot}
                >
                  <Trash2 size={14} />
                  Clear slot
                </button>
              </div>
              <div className="mobile-shortcut-slot-editor-fields">
                <label>
                  <span>Label</span>
                  <input
                    value={selectedShortcut.label}
                    maxLength={10}
                    aria-label={
                      selectedSlot.area === "side"
                        ? `Side slot ${selectedSlot.slotIndex + 1} label`
                        : `Row ${selectedSlot.rowIndex + 1} slot ${selectedSlot.slotIndex + 1} label`
                    }
                    onChange={(event) =>
                      updateSelectedShortcut((current) => ({
                        ...current,
                        label: event.target.value,
                      }))
                    }
                  />
                </label>
                <div className="mobile-shortcut-field">
                  <span>Key</span>
                  <ShortcutKeySelect
                    value={selectedShortcut.action}
                    openRequest={keySelectorOpenRequest}
                    ariaLabel={
                      selectedSlot.area === "side"
                        ? `Side slot ${selectedSlot.slotIndex + 1} key`
                        : `Row ${selectedSlot.rowIndex + 1} slot ${selectedSlot.slotIndex + 1} key`
                    }
                    onChange={(action) => {
                      const nextOption = mobileTerminalShortcutOption(action);
                      updateSelectedShortcut((current) => ({
                        ...current,
                        action,
                        label:
                          !current.label.trim() ||
                          current.label === selectedOption?.defaultButtonLabel
                            ? (nextOption?.defaultButtonLabel ?? current.label)
                            : current.label,
                      }));
                    }}
                  />
                </div>
              </div>
            </>
          ) : (
            <div className="mobile-shortcut-slot-editor-empty">
              Select a filled button to edit it, or select an empty + slot to
              add one.
            </div>
          )}
        </section>

        <div className="modal-actions mobile-shortcuts-actions">
          <button
            type="button"
            className="ghost mobile-shortcuts-restore"
            onClick={() => {
              setDraft(defaultMobileTerminalShortcutRows());
              setSideDraft(defaultMobileTerminalSideShortcuts());
              setSelectedSlot(null);
            }}
          >
            <RotateCcw size={14} />
            Restore defaults
          </button>
          <span />
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              onChange(normalizeMobileTerminalShortcutRows(draft));
              onSideChange(normalizeMobileTerminalSideShortcuts(sideDraft));
              onClose();
            }}
          >
            Save shortcuts
          </button>
        </div>
      </div>
    </div>
  );
}
