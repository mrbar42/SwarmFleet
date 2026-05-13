import { useEffect } from "react";
import { create } from "zustand";
import { AuthFetchError, getAuthStatus, logout as logoutRequest } from "./api";

type AuthStatus = "loading" | "authenticated" | "unauthenticated" | "error";

interface AuthStatusStore {
  status: AuthStatus;
  hasCredentials: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

function describeAuthStatusError(error: unknown): string {
  if (error instanceof AuthFetchError) {
    return `Backend returned ${error.status}`;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Could not reach the backend.";
}

export const useAuthStatus = create<AuthStatusStore>((set, get) => ({
  status: "loading",
  hasCredentials: true,
  error: null,
  refresh: async () => {
    try {
      const authStatus = await getAuthStatus();
      if (
        typeof authStatus.authenticated !== "boolean" ||
        typeof authStatus.hasCredentials !== "boolean"
      ) {
        throw new Error("Invalid auth status response");
      }
      set({
        status: authStatus.authenticated ? "authenticated" : "unauthenticated",
        hasCredentials: authStatus.hasCredentials,
        error: null,
      });
    } catch (error) {
      set({
        status: "error",
        hasCredentials: true,
        error: describeAuthStatusError(error),
      });
    }
  },
  logout: async () => {
    await logoutRequest();
    await get().refresh();
  },
}));

export function useAuthBootstrap(): void {
  const refresh = useAuthStatus((state) => state.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);
}
