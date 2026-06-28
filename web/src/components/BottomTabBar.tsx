import { NavLink, useLocation } from "react-router-dom";
import { LayoutDashboard, GitBranch } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Mobile bottom tab bar — fixed at the bottom of the viewport, hidden
 * on desktop (>= md). Provides the same navigation as Sidebar but in
 * an iOS/Android-style tab bar.
 *
 * Why bottom (not hamburger menu):
 *   - Always-visible, one-tap access to the 2 main sections
 *   - Hamburger hides nav behind an extra tap
 *   - With only 2 items, tab labels are short ("Dashboard" / "Projects")
 *   - Common pattern (Twitter, Instagram, Discord) — users expect it
 */

interface Tab {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  isActive: (pathname: string, search: string) => boolean;
}

const TABS: Tab[] = [
  {
    to: "/",
    label: "Dashboard",
    icon: LayoutDashboard,
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

export function BottomTabBar({ className }: { className?: string }) {
  const { pathname, search } = useLocation();

  return (
    <nav
      className={cn(
        "fixed inset-x-0 bottom-0 z-20 border-t border-border bg-bg/95 backdrop-blur md:hidden",
        // Add bottom padding so content doesn't hide behind the bar.
        "pb-[env(safe-area-inset-bottom)]",
        className,
      )}
      aria-label="Primary navigation"
    >
      <div className="mx-auto flex max-w-md items-stretch justify-around">
        {TABS.map((tab) => {
          const active = tab.isActive(pathname, search);
          return (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={cn(
                "flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors",
                active ? "text-accent" : "text-fg-dim hover:text-fg",
              )}
            >
              <tab.icon
                className={cn(
                  "h-5 w-5 transition-transform",
                  active && "scale-110",
                )}
              />
              <span>{tab.label}</span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}