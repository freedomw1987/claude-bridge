import type { Config } from "tailwindcss";

// Hermes Tracker APP — Tailwind config
//
// Dark mode is opt-in via the `.dark` class on <html>. The `useTheme`
// hook toggles this class and persists the choice in localStorage.
// Default behavior follows the OS via `prefers-color-scheme` (set in
// `src/index.css`).
//
// Color tokens are defined as CSS custom properties in `src/index.css`
// so light/dark variants resolve at runtime without duplicating
// Tailwind class lists.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Semantic color tokens — backed by CSS custom properties
        // defined in src/index.css. Tailwind's `bg-bg-soft`, `text-fg`,
        // `border-border`, etc. resolve to whichever theme is active.
        bg: {
          DEFAULT: "var(--color-bg)",
          soft: "var(--color-bg-soft)",
          elev: "var(--color-bg-elev)",
        },
        border: {
          DEFAULT: "var(--color-border)",
          strong: "var(--color-border-strong)",
        },
        fg: {
          DEFAULT: "var(--color-fg)",
          dim: "var(--color-fg-dim)",
          muted: "var(--color-fg-muted)",
        },
        accent: {
          DEFAULT: "var(--color-accent)",
          hover: "var(--color-accent-hover)",
        },
        success: "var(--color-success)",
        warn: "var(--color-warn)",
        danger: "var(--color-danger)",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Text",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "SF Mono",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      boxShadow: {
        soft: "0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06)",
        elev: "0 2px 4px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.08)",
      },
    },
  },
  plugins: [],
} satisfies Config;