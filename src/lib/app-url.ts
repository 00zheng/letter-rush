const DEVELOPMENT_APP_URL = "http://localhost:3000";

type ApplicationUrlOptions = {
  configuredUrl?: string;
  nodeEnvironment?: string;
};

function configurationError(message: string): Error {
  return new Error(`Invalid NEXT_PUBLIC_APP_URL: ${message}`);
}

export function validateApplicationUrl(
  value: string,
  nodeEnvironment: string = process.env.NODE_ENV,
): URL {
  let parsed: URL;

  try {
    parsed = new URL(value.trim());
  } catch {
    throw configurationError("provide an absolute http or https URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw configurationError("only http and https URLs are supported.");
  }

  if (nodeEnvironment === "production" && parsed.protocol !== "https:") {
    throw configurationError("production deployments must use https.");
  }

  if (parsed.username || parsed.password) {
    throw configurationError("credentials are not allowed in the public URL.");
  }

  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw configurationError(
      "configure an origin only, without a path, query, or fragment.",
    );
  }

  return new URL(parsed.origin);
}

export function getApplicationUrl(options: ApplicationUrlOptions = {}): URL {
  const nodeEnvironment = options.nodeEnvironment ?? process.env.NODE_ENV;
  const configuredUrl =
    options.configuredUrl ?? process.env.NEXT_PUBLIC_APP_URL?.trim();

  if (!configuredUrl) {
    if (nodeEnvironment === "production") {
      throw configurationError(
        "set it to the public application origin for production builds.",
      );
    }

    return new URL(DEVELOPMENT_APP_URL);
  }

  return validateApplicationUrl(configuredUrl, nodeEnvironment);
}

export function createInviteUrl(
  roomCode: string,
  applicationUrl = getApplicationUrl(),
): string {
  const inviteUrl = new URL(applicationUrl);
  inviteUrl.searchParams.set("room", roomCode);
  return inviteUrl.toString();
}
