import { describe, expect, test } from "bun:test";
import {
  KEY,
  MOD_ALT,
  MOD_CONTROL,
  MOD_SHIFT,
  VtInputClassifier,
} from "../../server/src/bridge/vt-input-classifier";
import { mobileTerminalKeyCombinationBytes } from "./mobileTerminalKeyCombination";

describe("mobile terminal key identity", () => {
  test.each([
    ["/", true, false, false, KEY.Char, 47, MOD_CONTROL],
    ["/", true, false, true, KEY.Char, 63, MOD_CONTROL | MOD_SHIFT],
    ["/", true, true, false, KEY.Char, 47, MOD_CONTROL | MOD_ALT],
    ["/", true, true, true, KEY.Char, 63, MOD_CONTROL | MOD_ALT | MOD_SHIFT],
    ["[", true, true, false, KEY.Char, 91, MOD_CONTROL | MOD_ALT],
    ["@", true, true, false, KEY.Char, 64, MOD_CONTROL | MOD_ALT],
    [";", true, true, false, KEY.Char, 59, MOD_CONTROL | MOD_ALT],
    [",", true, true, false, KEY.Char, 44, MOD_CONTROL | MOD_ALT],
    ["6", true, true, true, KEY.Char, 94, MOD_CONTROL | MOD_ALT | MOD_SHIFT],
    ["Backspace", true, false, false, KEY.Backspace, undefined, MOD_CONTROL],
    [
      "Backspace",
      true,
      true,
      false,
      KEY.Backspace,
      undefined,
      MOD_CONTROL | MOD_ALT,
    ],
    ["Backspace", false, true, false, KEY.Backspace, undefined, MOD_ALT],
    ["Escape", false, true, false, KEY.Esc, undefined, MOD_ALT],
    ["[", false, true, false, KEY.Char, 91, MOD_ALT],
    ["O", false, true, false, KEY.Char, 79, MOD_ALT],
    ["o", false, true, true, KEY.Char, 79, MOD_ALT | MOD_SHIFT],
    ["x", true, false, true, KEY.Char, 88, MOD_CONTROL | MOD_SHIFT],
    ["x", true, true, true, KEY.Char, 88, MOD_CONTROL | MOD_ALT | MOD_SHIFT],
    ["Enter", false, false, true, KEY.Enter, undefined, MOD_SHIFT],
    ["Delete", false, true, false, KEY.Delete, undefined, MOD_ALT],
    ["ArrowLeft", false, true, false, KEY.Left, undefined, MOD_ALT],
  ] as const)(
    "preserves %s (Ctrl=%s Alt=%s Shift=%s) and the following input",
    (key, ctrl, alt, shift, code, char, modifiers) => {
      const bytes = Buffer.from(
        mobileTerminalKeyCombinationBytes({ key, ctrl, alt, shift }),
      );
      for (let split = 1; split <= bytes.length; split++) {
        const classifier = new VtInputClassifier();
        const events = [
          ...classifier.feed(bytes.subarray(0, split)),
          ...classifier.feed(
            Buffer.concat([bytes.subarray(split), Buffer.from("z")]),
          ),
          ...classifier.flush(),
        ];
        expect(events).toMatchObject([
          { type: "key", code, char, modifiers },
          { type: "text", text: "z" },
        ]);
        expect(events).toHaveLength(2);
      }
    },
  );

  test.each([
    ["i", false, "\t"],
    ["m", false, "\r"],
    ["[", false, "\x1b"],
    ["_", false, "\x1f"],
    ["Space", false, "\x00"],
    ["2", false, "\x00"],
    ["3", false, "\x1b"],
    ["4", false, "\x1c"],
    ["5", false, "\x1d"],
    ["6", false, "\x1e"],
    ["7", false, "\x1f"],
    ["8", false, "\x7f"],
    ["6", true, "\x1e"],
  ] as const)(
    "retains the Ctrl+%s legacy alias (Shift=%s)",
    (key, shift, sequence) => {
      for (const alt of [false, true]) {
        // Alt+Ctrl punctuation is disambiguated; plain Ctrl and numeric
        // aliases retain their legacy bytes.
        if (alt && (key === "[" || key === "_" || shift)) continue;
        expect(
          mobileTerminalKeyCombinationBytes({ key, ctrl: true, alt, shift }),
        ).toEqual(Array.from(Buffer.from(`${alt ? "\x1b" : ""}${sequence}`)));
      }
    },
  );

  test("keeps unsupported Tab and shifted Backspace combinations disabled", () => {
    for (const key of ["Tab", "Backspace"]) {
      for (const ctrl of [false, true]) {
        for (const alt of [false, true]) {
          for (const shift of [false, true]) {
            if (key === "Tab" ? ctrl || alt : shift) {
              expect(
                mobileTerminalKeyCombinationBytes({ key, ctrl, alt, shift }),
              ).toEqual([]);
            }
          }
        }
      }
    }
  });
});
