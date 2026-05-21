import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#f8f8f8",
        canvas: "#ffffff",
        ink: "#000000",
        muted: "#636161",
        line: "#e6e6e6",
        midLine: "#d0d0d0",
        accent: "#ff2686",
        accentHover: "#ff2686",
        accentSoft: "#ff81be26",
        accentLine: "#ffcde5",
        accentText: "#ff2686",
        action: "#000000",
        actionHover: "#ff2686",
        kinicMagenta: "#ff2686",
        kinicCyan: "#2d68ff",
        infoSoft: "#eaf4ff",
        infoLine: "#8fc3ff",
        infoText: "#086cd9"
      },
      fontFamily: {
        sans: ["Aptos", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["Berkeley Mono", "ui-monospace", "SFMono-Regular", "monospace"]
      }
    }
  },
  plugins: []
};

export default config;
