import {
  createRuleset,
  serializeRuleset,
  validateRuleset,
  type GameRuleset,
} from "@/game/ruleset";

export const RANKED_RULESET_VERSION = "ranked-v1";

/**
 * Quick Match always uses this exact snapshot. Private lobbies continue to use
 * their own immutable rulesets and never affect ranked statistics.
 */
export const RANKED_RULESET: GameRuleset = createRuleset(4, 4, "rectangle", 60);

const SERIALIZED_RANKED_RULESET = serializeRuleset(RANKED_RULESET);

export function isRankedRuleset(value: unknown): value is GameRuleset {
  const validation = validateRuleset(value);
  return (
    validation.isValid &&
    serializeRuleset(validation.ruleset) === SERIALIZED_RANKED_RULESET
  );
}
