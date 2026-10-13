import { UnsupportedPlatformError } from "../connections/unix-only";

/**
 * An assistant error whose message is safe and useful to show the model and
 * the user. Tool wrappers surface these messages verbatim and keep masking
 * any other failure, which can carry transport details such as socket paths
 * or credentials.
 */
export class AssistantUserError extends Error {}

function surfaced(error: unknown) {
  return (
    error instanceof AssistantUserError ||
    error instanceof UnsupportedPlatformError
  );
}

/**
 * Rethrow user-facing errors verbatim and mask any other failure behind the
 * given generic message. Masked errors intentionally carry neither the
 * original message nor a `cause`, which could leak transport details.
 */
export function surfaceAssistantUserError(
  error: unknown,
  masked: string,
): never {
  if (surfaced(error)) throw error;
  throw new Error(masked);
}
