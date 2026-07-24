import {
  GENERATED_DICTIONARY_BUCKETS,
  GENERATED_DICTIONARY_METADATA,
} from "../generated/dictionary/index";

import { DICTIONARY_VERSION } from "./ruleset";

export { GENERATED_DICTIONARY_METADATA as DICTIONARY_METADATA };

type BucketLetter = keyof typeof GENERATED_DICTIONARY_BUCKETS;

const bucketCache = new Map<BucketLetter, Promise<Set<string>>>();
const resolvedBucketCache = new Map<BucketLetter, Set<string>>();

export function normalizeDictionaryWord(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[a-z]+$/u.test(normalized) ? normalized : null;
}

async function loadBucket(letter: BucketLetter): Promise<Set<string>> {
  const existing = bucketCache.get(letter);
  if (existing) return existing;

  const pending = GENERATED_DICTIONARY_BUCKETS[letter]()
    .then((contents) => {
      const words = new Set(contents ? contents.split("\n") : []);
      resolvedBucketCache.set(letter, words);
      return words;
    })
    .catch((error: unknown) => {
      bucketCache.delete(letter);
      resolvedBucketCache.delete(letter);
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

/**
 * Reads an already-preloaded dictionary bucket without yielding to the event
 * loop. A null result means the caller must finish preloading before accepting
 * pointer input.
 */
export function isDictionaryWordCached(word: string): boolean | null {
  const normalized = normalizeDictionaryWord(word);
  if (!normalized) return false;

  const firstLetter = normalized[0] as BucketLetter;
  if (!(firstLetter in GENERATED_DICTIONARY_BUCKETS)) return false;

  const bucket = resolvedBucketCache.get(firstLetter);
  return bucket ? bucket.has(normalized) : null;
}

export async function preloadDictionaryBuckets(
  letters: Iterable<string | null>,
): Promise<void> {
  const buckets = new Set<BucketLetter>();
  for (const value of letters) {
    const letter = value?.trim().toLowerCase() as BucketLetter | undefined;
    if (letter && letter in GENERATED_DICTIONARY_BUCKETS) buckets.add(letter);
  }
  await Promise.all([...buckets].map((letter) => loadBucket(letter)));
}

export function assertDictionaryVersion(version: string): void {
  if (
    version !== DICTIONARY_VERSION ||
    version !== GENERATED_DICTIONARY_METADATA.version
  ) {
    throw new RangeError(`Unsupported dictionary version: ${version}`);
  }
}
