import { readFileSync, writeFileSync } from "node:fs";

const tsconfigUrl = new URL("../tsconfig.json", import.meta.url);
const tsconfig = JSON.parse(readFileSync(tsconfigUrl, "utf8"));
const include = Array.isArray(tsconfig.include) ? tsconfig.include : [];
const normalizedInclude = include.filter((entry) => entry !== ".next/dev/types/**/*.ts");

if (normalizedInclude.length !== include.length) {
  tsconfig.include = normalizedInclude;
  writeFileSync(tsconfigUrl, `${JSON.stringify(tsconfig, null, 2)}\n`);
}
