import {
  GENERATED_DICTIONARY_BUCKETS,
  GENERATED_DICTIONARY_METADATA,
} from "../generated/dictionary/index";

import { DICTIONARY_VERSION } from "./ruleset";

export { GENERATED_DICTIONARY_METADATA as DICTIONARY_METADATA };

type BucketLetter = keyof typeof GENERATED_DICTIONARY_BUCKETS;

const bucketCache = new Map<BucketLetter, Promise<Set<string>>>();

export function normalizeDictionaryWord(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[a-z]+$/u.test(normalized) ? normalized : null;
}

async function loadBucket(letter: BucketLetter): Promise<Set<string>> {
  const existing = bucketCache.get(letter);
  if (existing) return existing;

  const pending = GENERATED_DICTIONARY_BUCKETS[letter]()
    .then((contents) => new Set(contents ? contents.split("\n") : []))
    .catch((error: unknown) => {
      bucketCache.delete(letter);
      throw error;
    });
  bucketCache.set(letter, pending);
  return pending;
}

/**
 * Loads only the submitted word's first-letter chunk. This keeps the complete
 * 173k-word lexicon out of the initial phone bundle and main-thread startup.
 */
export async function isDictionaryWord(word: string): Promise<boolean> {
  const normalized = normalizeDictionaryWord(word);
  if (!normalized) return false;

  const firstLetter = normalized[0] as BucketLetter;
  if (!(firstLetter in GENERATED_DICTIONARY_BUCKETS)) return false;

  return (await loadBucket(firstLetter)).has(normalized);
}

export function assertDictionaryVersion(version: string): void {
  if (
    version !== DICTIONARY_VERSION ||
    version !== GENERATED_DICTIONARY_METADATA.version
  ) {
    throw new RangeError(`Unsupported dictionary version: ${version}`);
  }
}
