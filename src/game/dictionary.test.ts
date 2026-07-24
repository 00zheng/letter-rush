import { describe, expect, it } from "vitest";

import {
  DICTIONARY_METADATA,
  isDictionaryWord,
  normalizeDictionaryWord,
} from "./dictionary";
import { DICTIONARY_VERSION } from "./ruleset";

describe("generated dictionary", () => {
  it("shares one pinned version between metadata and game rules", () => {
    expect(DICTIONARY_METADATA.version).toBe(DICTIONARY_VERSION);
    expect(DICTIONARY_METADATA.wordCount).toBeGreaterThan(170_000);
  });

  it.each(["cat", "cats", "played", "quixotic", "syzygy", "letterrush"])(
    "accepts representative source and custom words: %s",
    async (word) => {
      await expect(isDictionaryWord(word)).resolves.toBe(true);
    },
  );

  it.each([
    "Alice",
    "London",
    "FBI",
    "USA",
    "zymurgy",
    "can't",
    "two words",
    "123",
  ])(
    "rejects proper names, blocked words, punctuation, and malformed values: %s",
    async (word) => {
      await expect(isDictionaryWord(word)).resolves.toBe(false);
    },
  );

  it("normalizes case and surrounding whitespace only", () => {
    expect(normalizeDictionaryWord("  CaTs ")).toBe("cats");
    expect(normalizeDictionaryWord("cat!")).toBeNull();
  });
});
