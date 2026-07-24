import { describe, expect, it } from "vitest";

import {
  friendlyAuthError,
  getPasswordStrength,
  isAnonymousUser,
  safeNextPath,
  validateEmail,
} from "./auth";

describe("auth helpers", () => {
  it("normalizes plausible email addresses", () => {
    expect(validateEmail(" Player@Example.com ")).toBe("player@example.com");
    expect(validateEmail("not-an-email")).toBeNull();
  });

  it("requires a useful password floor", () => {
    expect(getPasswordStrength("short").isAcceptable).toBe(false);
    expect(getPasswordStrength("Longer!Pass123").isAcceptable).toBe(true);
  });

  it("detects legacy and current anonymous upgrade states", () => {
    expect(isAnonymousUser({ is_anonymous: true })).toBe(true);
    expect(isAnonymousUser({ app_metadata: { provider: "anonymous" } })).toBe(
      true,
    );
    expect(isAnonymousUser({ app_metadata: { provider: "email" } })).toBe(
      false,
    );
  });

  it("allows only same-origin relative redirects", () => {
    expect(safeNextPath("/quick-match?again=1")).toBe("/quick-match?again=1");
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("https://evil.example")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
  });

  it("does not surface raw authentication messages", () => {
    expect(friendlyAuthError({ code: "invalid_credentials" })).toMatch(
      /not recognized/,
    );
    expect(
      friendlyAuthError({
        code: "unknown",
        message: "secret database detail",
      }),
    ).not.toContain("secret database detail");
  });
});
