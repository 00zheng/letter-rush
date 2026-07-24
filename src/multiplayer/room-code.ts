export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type RoomCodeValidation =
  | { isValid: true; code: string }
  | { isValid: false; code: string; message: string };

export function normalizeRoomCode(value: string): string {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[\s-]+/g, "");
}

export function validateRoomCode(value: string): RoomCodeValidation {
  const code = normalizeRoomCode(value);

  if (code.length !== ROOM_CODE_LENGTH) {
    return {
      isValid: false,
      code,
      message: `Room codes contain ${ROOM_CODE_LENGTH} characters.`,
    };
  }

  const allowedCharacters = new RegExp(`^[${ROOM_CODE_ALPHABET}]+$`);

  if (!allowedCharacters.test(code)) {
    return {
      isValid: false,
      code,
      message: "That room code contains an invalid character.",
    };
  }

  return { isValid: true, code };
}
