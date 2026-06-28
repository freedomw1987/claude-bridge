import { NavLink, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { Dashboard } from "@/routes/Dashboard";
import { SessionDetail } from "@/routes/SessionDetail";
import { Sidebar } from "@/components/Sidebar";
import { BottomTabBar } from "@/components/BottomTabBar";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Activity } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * App layout:
 *
 *  Desktop (md+):
 *    ┌──────────┬─────────────────────────┐
 *    │ Sidebar  │ Mobile-style top header  │
 *    │  (nav)   │   (logo, theme toggle)   │
 *    │          │   Routes                 │
 *    │          │                         │
 *    └──────────┴─────────────────────────┘
 *
 *  Mobile (< md):
 *    ┌─────────────────────────┐
 *    │ Compact header          │ ← only logo + theme
 *    │ Routes                  │
 *    │                         │
 *    │                         │
 *    ├─────────────────────────┤
 *    │ BottomTabBar            │ ← fixed at bottom
 *    └─────────────────────────┘
 *
 * The Sidebar is hidden on mobile (display: none); the BottomTabBar
 * is hidden on desktop. Both share the same active-state logic.
 *
 * Routes:
 *   /                  → Dashboard (all sessions)
 *   /?mode=hermes      → Dashboard (Hermes-only filter)
 *   /sessions/:id      → SessionDetail (handles both modes)
 *   /projects/:id      → legacy redirect to /sessions/:id
 */

export function App() {
  return (
    <div className="min-h-screen bg-bg">
      {/* Desktop sidebar (fixed left, hidden on mobile) */}
      <Sidebar />

      {/* Main column — shifted right on desktop to make room for sidebar */}
      <div className="md:ml-50">
        <Header />
        <main className="mx-auto max-w-5xl px-4 pb-24 pt-4 sm:px-6 md:pb-6">
          {/* pb-24 on mobile leaves room for the fixed BottomTabBar */}
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/sessions/:id" element={<SessionDetail />} />
            <Route path="/projects/:id" element={<ProjectIdRedirect />} />
          </Routes>
        </main>
      </div>

      {/* Mobile bottom tab bar (hidden on desktop) */}
      <BottomTabBar />

      <Toaster position="bottom-right" theme="system" />
    </div>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-bg/80 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        {/* Logo — only on mobile (desktop has it in Sidebar) */}
        <NavLink to="/" className="flex items-center gap-2 md:hidden">
          <Activity className="h-5 w-5 text-accent" />
          <span className="font-semibold tracking-tight">Hermes Tracker</span>
          <span
            className={cn(
              "rounded-full border border-border bg-bg-elev px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider text-fg-muted",
            )}
          >
            v0.1 · P1
          </span>
        </NavLink>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

/**
 * Redirect /projects/:id → /sessions/:id. Used for old bookmarks from
 * before the Session refactor.
 */
function ProjectIdRedirect() {
  if (typeof window !== "undefined") {
    const id = window.location.pathname.split("/").pop();
    if (id) {
      window.location.replace(`/sessions/${id}`);
    }
  }
  return (
    <div className="flex items-center justify-center py-12 text-fg-muted">
      <span className="text-sm">Redirecting…</span>
    </div>
  );
}