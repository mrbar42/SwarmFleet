const nativeFetch: typeof window.fetch = window.fetch.bind(window);

type FetchInput = Parameters<typeof window.fetch>[0];

const protectedPathPrefixes = ["/api/", "/auth/"];

function toUrl(input: FetchInput): URL | null {
  try {
    if (typeof input === "string" || input instanceof URL) {
      return new URL(input, window.location.href);
    }

    return new URL(input.url, window.location.href);
  } catch {
    return null;
  }
}

function isAppOrigin(url: URL): boolean {
  return (
    url.origin === window.location.origin ||
    (url.protocol === window.location.protocol &&
      url.hostname === window.location.hostname)
  );
}

function isProtectedAppRequest(input: FetchInput): boolean {
  const url = toUrl(input);
  if (!url || !isAppOrigin(url)) return false;
  return protectedPathPrefixes.some((prefix) =>
    url.pathname.startsWith(prefix),
  );
}

function hasExplicitCredentials(
  input: FetchInput,
  init: RequestInit | undefined,
): boolean {
  if (init?.credentials !== undefined) return true;
  return (
    typeof Request !== "undefined" &&
    input instanceof Request &&
    input.credentials !== "same-origin"
  );
}

window.fetch = ((input, init) => {
  if (!isProtectedAppRequest(input) || hasExplicitCredentials(input, init)) {
    return nativeFetch(input, init);
  }

  return nativeFetch(input, {
    ...init,
    credentials: "include",
  });
}) as typeof window.fetch;
