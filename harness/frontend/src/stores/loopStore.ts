import { create } from "zustand";
import type { LoopConfig, CreateLoopRequest, UpdateLoopRequest, LoopStatusInfo } from "@shared/types";
import { getLoopsUrl, getLoopUrl, getLoopPlayUrl, getLoopPauseUrl } from "../config/api";

interface CountdownState {
  loopId: string;
  sessionId: string;
  endsAt: number;
}

interface LoopStore {
  loops: Map<string, LoopConfig>;
  loading: boolean;
  error: string | null;
  countdown: CountdownState | null;

  fetchLoop: (sessionId: string) => Promise<LoopConfig | null>;
  createLoop: (req: CreateLoopRequest) => Promise<LoopConfig>;
  updateLoop: (loopId: string, req: UpdateLoopRequest) => Promise<LoopConfig>;
  playLoop: (loopId: string) => Promise<LoopConfig>;
  pauseLoop: (loopId: string) => Promise<LoopConfig>;
  deleteLoop: (loopId: string, sessionId: string) => Promise<void>;
  setLoopFromStatus: (sessionId: string, info: LoopStatusInfo | null) => void;
  startCountdown: (loopId: string, sessionId: string) => void;
  clearCountdown: () => void;
  clearError: () => void;
}

const COUNTDOWN_DURATION_MS = 10_000;

export const useLoopStore = create<LoopStore>()((set, get) => ({
  loops: new Map(),
  loading: false,
  error: null,
  countdown: null,

  fetchLoop: async (sessionId) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(getLoopsUrl(sessionId));
      if (!res.ok) throw new Error(`Failed to fetch loop: ${res.status} ${res.statusText}`);
      const data = (await res.json()) as { loops: LoopConfig[] };
      const loop = data.loops[0] ?? null;
      const loops = new Map(get().loops);
      if (loop) {
        loops.set(sessionId, loop);
      } else {
        loops.delete(sessionId);
      }
      set({ loops, loading: false });
      return loop;
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : "Failed to fetch loop" });
      return null;
    }
  },

  createLoop: async (req) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(getLoopsUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error(`Failed to create loop: ${res.status} ${res.statusText}`);
      const loop = (await res.json()) as LoopConfig;
      const loops = new Map(get().loops);
      loops.set(loop.sessionId, loop);
      set({ loops, loading: false });
      return loop;
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : "Failed to create loop" });
      throw error;
    }
  },

  updateLoop: async (loopId, req) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(getLoopUrl(loopId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error(`Failed to update loop: ${res.status} ${res.statusText}`);
      const loop = (await res.json()) as LoopConfig;
      const loops = new Map(get().loops);
      loops.set(loop.sessionId, loop);
      set({ loops, loading: false });
      return loop;
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : "Failed to update loop" });
      throw error;
    }
  },

  playLoop: async (loopId) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(getLoopPlayUrl(loopId), { method: "POST" });
      if (!res.ok) throw new Error(`Failed to play loop: ${res.status} ${res.statusText}`);
      const loop = (await res.json()) as LoopConfig;
      const loops = new Map(get().loops);
      loops.set(loop.sessionId, loop);
      set({ loops, loading: false });
      return loop;
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : "Failed to play loop" });
      throw error;
    }
  },

  pauseLoop: async (loopId) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(getLoopPauseUrl(loopId), { method: "POST" });
      if (!res.ok) throw new Error(`Failed to pause loop: ${res.status} ${res.statusText}`);
      const loop = (await res.json()) as LoopConfig;
      const loops = new Map(get().loops);
      loops.set(loop.sessionId, loop);
      set({ loops, loading: false });
      return loop;
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : "Failed to pause loop" });
      throw error;
    }
  },

  deleteLoop: async (loopId, sessionId) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(getLoopUrl(loopId), { method: "DELETE" });
      if (!res.ok) throw new Error(`Failed to delete loop: ${res.status} ${res.statusText}`);
      const loops = new Map(get().loops);
      loops.delete(sessionId);
      set({ loops, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : "Failed to delete loop" });
      throw error;
    }
  },

  setLoopFromStatus: (sessionId, info) => {
    const loops = new Map(get().loops);
    if (!info) {
      loops.delete(sessionId);
    } else {
      const existing = loops.get(sessionId);
      const loop: LoopConfig = {
        prompt: existing?.prompt ?? "",
        consecutiveErrorCount: existing?.consecutiveErrorCount ?? 0,
        permissionMode: existing?.permissionMode,
        model: existing?.model,
        effort: existing?.effort,
        ...info,
      };
      loops.set(sessionId, loop);
    }
    set({ loops });
  },

  startCountdown: (loopId, sessionId) => {
    set({ countdown: { loopId, sessionId, endsAt: Date.now() + COUNTDOWN_DURATION_MS } });
  },

  clearCountdown: () => {
    set({ countdown: null });
  },

  clearError: () => {
    set({ error: null });
  },
}));
