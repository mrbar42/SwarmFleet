export interface AuthStatusResponse {
  authenticated: boolean;
  hasCredentials: boolean;
}

export interface LoginBeginResponse {
  options: unknown;
  challengeId: string;
}

export interface RegisterBeginResponse {
  options: unknown;
  challengeId: string;
}

export interface OkResponse {
  ok: true;
}

export interface EnrollmentQrResponse {
  url: string;
  expiresAt: string;
}

export interface CredentialRecord {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface CredentialsResponse {
  credentials: CredentialRecord[];
}

export class AuthFetchError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    const bodyError =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : "";
    const message =
      bodyError && bodyError.length < 160
        ? bodyError
        : `Request failed with status ${status}`;
    super(message);
    this.name = "AuthFetchError";
    this.status = status;
    this.body = body;
  }
}

export async function authFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { error: text };
    }
  }

  if (!response.ok) {
    throw new AuthFetchError(response.status, body);
  }

  return body as T;
}

export function getAuthStatus(): Promise<AuthStatusResponse> {
  return authFetch<AuthStatusResponse>("/auth/status");
}

export function beginLogin(): Promise<LoginBeginResponse> {
  return authFetch<LoginBeginResponse>("/auth/login/begin", {
    method: "POST",
  });
}

export function finishLogin(
  challengeId: string,
  response: unknown,
): Promise<OkResponse> {
  return authFetch<OkResponse>("/auth/login/finish", {
    method: "POST",
    body: JSON.stringify({ challengeId, response }),
  });
}

export function beginRegistration(
  enrollmentToken: string,
): Promise<RegisterBeginResponse> {
  return authFetch<RegisterBeginResponse>("/auth/register/begin", {
    method: "POST",
    body: JSON.stringify({ enrollmentToken }),
  });
}

export function finishRegistration(
  enrollmentToken: string,
  response: unknown,
  label: string,
): Promise<OkResponse> {
  return authFetch<OkResponse>("/auth/register/finish", {
    method: "POST",
    body: JSON.stringify({ enrollmentToken, response, label }),
  });
}

export function logout(): Promise<OkResponse> {
  return authFetch<OkResponse>("/auth/logout", {
    method: "POST",
  });
}

export function createEnrollmentQr(): Promise<EnrollmentQrResponse> {
  return authFetch<EnrollmentQrResponse>("/auth/enroll/qr", {
    method: "POST",
  });
}

export function getCredentials(): Promise<CredentialsResponse> {
  return authFetch<CredentialsResponse>("/auth/credentials");
}

export function removeCredential(id: string): Promise<OkResponse> {
  return authFetch<OkResponse>(`/auth/credentials/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
