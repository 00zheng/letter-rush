import { describe, expect, it } from "vitest";

import {
  createInviteUrl,
  getApplicationUrl,
  validateApplicationUrl,
} from "./app-url";

describe("application URL configuration", () => {
  it("uses localhost when development has no configured URL", () => {
    expect(
      getApplicationUrl({
        configuredUrl: "",
        nodeEnvironment: "development",
      }).toString(),
    ).toBe("http://localhost:3000/");
  });

  it("normalizes the configured production origin", () => {
    expect(
      validateApplicationUrl(
        "https://letter-rush-tau.vercel.app/",
        "production",
      ).toString(),
    ).toBe("https://letter-rush-tau.vercel.app/");
  });

  it("requires an explicit secure origin in production", () => {
    expect(() =>
      getApplicationUrl({
        configuredUrl: "",
        nodeEnvironment: "production",
      }),
    ).toThrow(/NEXT_PUBLIC_APP_URL/);
    expect(() =>
      validateApplicationUrl("http://example.com", "production"),
    ).toThrow(/https/);
  });

  it.each([
    "ftp://example.com",
    "https://user:password@example.com",
    "https://example.com/game",
    "https://example.com/?source=test",
    "https://example.com/#play",
  ])("rejects an invalid public origin: %s", (value) => {
    expect(() => validateApplicationUrl(value, "development")).toThrow(
      /NEXT_PUBLIC_APP_URL/,
    );
  });

  it("builds encoded invite links from the configured origin", () => {
    expect(
      createInviteUrl("ABC234", new URL("https://letter-rush-tau.vercel.app/")),
    ).toBe("https://letter-rush-tau.vercel.app/?room=ABC234");
  });
});
