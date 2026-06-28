import { Moon, Sun, Monitor } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { cn } from "@/lib/cn";

const OPTIONS = [
  { value: "light", icon: Sun, label: "Light" },
  { value: "system", icon: Monitor, label: "System" },
  { value: "dark", icon: Moon, label: "Dark" },
] as const;

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  return (
    <div
      className={cn(
        "inline-flex rounded-lg border border-border bg-bg-soft p-0.5",
        className,
      )}
      role="radiogroup"
      aria-label="Theme"
    >
      {OPTIONS.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          onClick={() => setTheme(value)}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md text-fg-dim transition-colors",
            "hover:text-fg",
            theme === value && "bg-bg-elev text-fg shadow-sm",
          )}
        >
          <Icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}