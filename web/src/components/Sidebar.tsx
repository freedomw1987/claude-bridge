import { NavLink, useLocation } from "react-router-dom";
import { Activity, LayoutDashboard, GitBranch } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Desktop sidebar — fixed on the left, hidden on mobile.
 * Mobile users get the BottomTabBar instead.
 *
 * Nav items:
 *   - Dashboard   → "/" (all sessions, default filter)
 *   - Projects    → "/?mode=hermes" (Hermes-only filter, the same
 *                    Dashboard with a different default)
 *
 * Session detail pages (/sessions/:id) don't have a dedicated menu
 * item — they're reached via clicks on Dashboard cards. The Dashboard
 * menu item stays highlighted when on a session detail, which makes
 * sense as "I'm in the dashboard context, just looking at one item".
 */

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  isActive: (pathname: string, search: string) => boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    to: "/",
    label: "Dashboard",
    icon: LayoutDashboard,
    // Match: exact "/" OR any "/sessions/*" path. Keeps Dashboard
    // highlighted when navigating into a session detail.
    isActive: (pathname) =>
      pathname === "/" || pathname.startsWith("/sessions"),
  },
  {
    to: "/?mode=hermes",
    label: "Projects",
    icon: GitBranch,
    isActive: (pathname, search) =>
      pathname === "/" && new URLSearchParams(search).get("mode") === "hermes",
  },
];

export function Sidebar({ className }: { className?: string }) {
  const { pathname, search } = useLocation();

  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-20 hidden w-50 border-r border-border bg-bg-soft md:flex md:flex-col",
        className,
      )}
    >
      {/* Brand */}
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <Activity className="h-5 w-5 text-accent" />
        <span className="font-semibold tracking-tight">Hermes Tracker</span>
        <span className="rounded-full border border-border bg-bg-elev px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider text-fg-muted">
          v0.1
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-0.5 p-2">
        {NAV_ITEMS.map((item) => {
          const active = item.isActive(pathname, search);
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-accent/15 text-accent"
                  : "text-fg-dim hover:bg-bg-elev hover:text-fg",
              )}
            >
              <item.icon className="h-4 w-4" />
              <span>{item.label}</span>
            </NavLink>
          );
        })}
      </nav>

      {/* Footer hint */}
      <div className="border-t border-border p-3 text-[10px] text-fg-muted">
        <p>Hermes is opt-in.</p>
        <p>Default = 1-on-1 CC conversation.</p>
      </div>
    </aside>
  );
}