import { NavLink, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { Dashboard } from "@/routes/Dashboard";
import { SessionDetail } from "@/routes/SessionDetail";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Activity } from "lucide-react";
import { cn } from "@/lib/cn";

export function App() {
  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          {/* Single route for both modes — dispatches internally. */}
          <Route path="/sessions/:id" element={<SessionDetail />} />
          {/* Backwards-compat: old /projects/:id URLs redirect. */}
          <Route path="/projects/:id" element={<ProjectIdRedirect />} />
        </Routes>
      </main>
      <Toaster position="bottom-right" theme="system" />
    </div>
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

function Header() {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-bg/80 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <NavLink to="/" className="flex items-center gap-2">
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
        <ThemeToggle />
      </div>
    </header>
  );
}