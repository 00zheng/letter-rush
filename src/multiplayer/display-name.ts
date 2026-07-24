export const MIN_DISPLAY_NAME_LENGTH = 2;
export const MAX_DISPLAY_NAME_LENGTH = 24;

export type DisplayNameValidation =
  | { isValid: true; displayName: string }
  | { isValid: false; displayName: string; message: string };

export function sanitizeDisplayName(value: string): string {
  return Array.from(
    value
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N} _'-]/gu, "")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, MAX_DISPLAY_NAME_LENGTH)
    .join("");
}

export function validateDisplayName(value: string): DisplayNameValidation {
  const displayName = sanitizeDisplayName(value);

  if (displayName.length < MIN_DISPLAY_NAME_LENGTH) {
    return {
      isValid: false,
      displayName,
      message: `Use at least ${MIN_DISPLAY_NAME_LENGTH} letters or numbers.`,
    };
  }

  return { isValid: true, displayName };
}

export function createGuestName(userId: string): string {
  const leadingHex = userId.replaceAll("-", "").slice(0, 8);
  const numericId = Number.parseInt(leadingHex, 16);
  const guestNumber = (Number.isFinite(numericId) ? numericId : 0) % 9_000;

  return `Guest ${(guestNumber + 1_000).toString().padStart(4, "0")}`;
}
