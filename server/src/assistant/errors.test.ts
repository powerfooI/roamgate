import { expect, test } from "bun:test";
import { UnsupportedPlatformError } from "../connections/unix-only";
import { AssistantUserError, surfaceAssistantUserError } from "./errors";

test("user-facing and platform errors surface while others stay masked", () => {
  for (const error of [
    new AssistantUserError("Invalid task input"),
    new UnsupportedPlatformError("Ranger diff read"),
  ])
    expect(() => surfaceAssistantUserError(error, "masked")).toThrow(error);
  expect(() =>
    surfaceAssistantUserError(new Error("ssh: /private/socket"), "masked"),
  ).toThrow(/^masked$/);
});
