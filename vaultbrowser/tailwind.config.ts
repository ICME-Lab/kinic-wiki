import type { Config } from "tailwindcss";
import preset from "@kinic/ui/tailwind-preset";

export default {
  presets: [preset],
  content: ["./src/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "../packages/ui/src/**/*.{ts,tsx}"],
} satisfies Config;
