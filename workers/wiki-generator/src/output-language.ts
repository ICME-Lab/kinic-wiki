// Where: workers/wiki-generator/src/output-language.ts
// What: Validates output language codes and maps them to trusted prompt labels.
// Why: Queue and VFS data must not inject arbitrary language instructions into the LLM prompt.

import type { OutputLanguage } from "./types.js";

export const DEFAULT_OUTPUT_LANGUAGE: OutputLanguage = "en";

const OUTPUT_LANGUAGE_NAMES: Record<OutputLanguage, string> = {
  en: "English",
  ja: "Japanese",
  "zh-Hans": "Simplified Chinese",
  ko: "Korean",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese"
};

export function parseOutputLanguage(value: unknown): OutputLanguage | null {
  if (value === undefined || value === null) return DEFAULT_OUTPUT_LANGUAGE;
  if (typeof value !== "string") return null;
  switch (value) {
    case "en":
    case "ja":
    case "zh-Hans":
    case "ko":
    case "es":
    case "fr":
    case "de":
    case "pt":
      return value;
    default:
      return null;
  }
}

export function outputLanguageName(language: OutputLanguage): string {
  return OUTPUT_LANGUAGE_NAMES[language];
}
