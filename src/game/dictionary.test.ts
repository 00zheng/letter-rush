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
    expect(DICTIONARY_METADATA.wordCount).toBe(173_528);
  });

  it.each([
    "crate",
    "cat",
    "house",
    "cats",
    "houses",
    "played",
    "running",
    "quixotic",
    "syzygy",
    "letterrush",
  ])(
    "accepts common words, plurals, verb forms, and approved additions: %s",
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
    "well-formed",
    "two words",
    "123",
    "",
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
