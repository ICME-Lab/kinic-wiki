import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Brand surfaces resolve through CSS variables so light and dark share one definition.
        paper: "rgb(var(--paper) / <alpha-value>)",
        canvas: "rgb(var(--canvas) / <alpha-value>)",
        ink: "rgb(var(--ink) / <alpha-value>)",
        line: "rgb(var(--line) / <alpha-value>)",
        midLine: "rgb(var(--mid-line) / <alpha-value>)",
        accentSoft: "rgb(var(--accent-soft) / var(--accent-soft-alpha))",
        accentLine: "rgb(var(--accent-line) / <alpha-value>)",
        accentText: "rgb(var(--accent-text) / <alpha-value>)",
        action: "rgb(var(--action) / <alpha-value>)",
        actionHover: "rgb(var(--action-hover) / <alpha-value>)",
        onAction: "rgb(var(--on-action) / <alpha-value>)",
        kinicMagenta: "rgb(var(--kinic-magenta) / <alpha-value>)",
        kinicCyan: "rgb(var(--kinic-cyan) / <alpha-value>)",
        infoSoft: "rgb(var(--info-soft) / <alpha-value>)",
        infoLine: "rgb(var(--info-line) / <alpha-value>)",
        infoText: "rgb(var(--info-text) / <alpha-value>)",
        dangerSoft: "rgb(var(--danger-soft) / <alpha-value>)",
        dangerLine: "rgb(var(--danger-line) / <alpha-value>)",
        dangerText: "rgb(var(--danger-text) / <alpha-value>)",
        warnSoft: "rgb(var(--warn-soft) / <alpha-value>)",
        warnLine: "rgb(var(--warn-line) / <alpha-value>)",
        warnText: "rgb(var(--warn-text) / <alpha-value>)",
        okSoft: "rgb(var(--ok-soft) / <alpha-value>)",
        okLine: "rgb(var(--ok-line) / <alpha-value>)",
        okText: "rgb(var(--ok-text) / <alpha-value>)",
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))"
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))"
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))"
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))"
        },
        accent: "rgb(var(--brand-accent) / <alpha-value>)",
        "accent-foreground": "hsl(var(--accent-foreground))",
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))"
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))"
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))"
        }
      },
      // `bg-white` is the card surface across the app, so it has to follow the theme.
      backgroundColor: {
        white: "rgb(var(--surface) / <alpha-value>)"
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 4px)",
        sm: "calc(var(--radius) - 8px)"
      },
      fontFamily: {
        // System stacks keep text crisp on every platform without shipping webfonts.
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Text",
          "Segoe UI Variable Text",
          "Segoe UI",
          "Inter",
          "system-ui",
          "sans-serif"
        ],
        mono: [
          "ui-monospace",
          "SF Mono",
          "SFMono-Regular",
          "Geist Mono",
          "JetBrains Mono",
          "Menlo",
          "Consolas",
          "Liberation Mono",
          "monospace"
        ]
      },
      boxShadow: {
        card: "0 1px 2px rgb(var(--shadow-rgb) / 0.06), 0 8px 24px -12px rgb(var(--shadow-rgb) / 0.16)",
        pop: "0 12px 32px -8px rgb(var(--shadow-rgb) / 0.22), 0 2px 8px rgb(var(--shadow-rgb) / 0.08)"
      },
      transitionTimingFunction: {
        spring: "var(--ease-spring)"
      },
      transitionDuration: {
        fast: "var(--duration-fast)",
        base: "var(--duration-base)",
        slow: "var(--duration-slow)"
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" }
        },
        "rise-in": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" }
        },
        "pop-in": {
          from: { opacity: "0", transform: "scale(0.97)" },
          to: { opacity: "1", transform: "scale(1)" }
        }
      },
      animation: {
        "fade-in": "fade-in var(--duration-base) var(--ease-spring) both",
        "rise-in": "rise-in var(--duration-slow) var(--ease-spring) both",
        "pop-in": "pop-in var(--duration-base) var(--ease-spring) both"
      }
    }
  },
  plugins: [animate]
};

export default config;
