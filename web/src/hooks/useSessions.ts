/**
 * Hermes Tracker APP — session data hooks.
 *
 * Thin TanStack Query wrappers around the API client. In P1 these
 * serve mock data; in P2 they fetch from the bot's HTTP API.
 *
 * Renamed from `useProjects` → `useSessions` to reflect the new
 * "session is the basic unit" model. Both Hermes projects and
 * plain conversations are fetched through these hooks.
 */

import { useQuery } from "@tanstack/react-query";
import { fetchStats, fetchSession, fetchSessions } from "@/lib/api";
import type { SessionDetail, SessionMode, SessionSummary, Stats } from "@/types";

// ── Canonical names ──────────────────────────────────────────────────

export function useSessions(opts: { mode?: SessionMode } = {}) {
  return useQuery<SessionSummary[]>({
    queryKey: ["sessions", opts],
    queryFn: () => fetchSessions(opts),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}

export function useSession(id: string | undefined) {
  return useQuery<SessionDetail>({
    queryKey: ["session", id],
    queryFn: () => fetchSession(id!),
    enabled: !!id,
    refetchInterval: 5_000,
    staleTime: 2_000,
  });
}

export function useStats() {
  return useQuery<Stats>({
    queryKey: ["stats"],
    queryFn: fetchStats,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}