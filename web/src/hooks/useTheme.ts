/**
 * useTheme — light/dark mode toggle.
 *
 * Persists the user's choice in localStorage (key: "hermes-theme").
 * If no choice is persisted, falls back to OS preference via
 * `prefers-color-scheme`. The inline script in index.html applies
 * the class BEFORE React mounts to prevent FOUC.
 */

import { useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "hermes-theme";

function readStored(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    // localStorage unavailable
  }
  return "system";
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined"
    && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const isDark = theme === "dark" || (theme === "system" && systemPrefersDark());
  root.classList.toggle("dark", isDark);
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => readStored());

  useEffect(() => {
    applyTheme(theme);
    try {
      if (theme === "system") {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, theme);
      }
    } catch {
      // ignore
    }
  }, [theme]);

  // React to OS theme changes while in "system" mode.
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  return { theme, setTheme } as const;
}