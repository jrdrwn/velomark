// Velomark harness driver.
//
// The grader runs this file as `node /bot/main.ts` under Node 22, so it
// has to stay erasable TypeScript: plain type annotations only, nothing
// that needs a compile step (no enums, no namespaces, no parameter
// properties).
//
// It reads the case list, renders every case on its own with parse(),
// and writes the HTML strings back in the same order. Cases never share
// state: each parse() call starts from scratch, so a long document
// cannot leak anything into the next case.
//
//   input :  $MAKEFUN_INPUT_DIR/cases.json   (default /input/cases.json)
//   output:  $MAKEFUN_OUTPUT_DIR/html.json   (default /output/html.json)

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

const inDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const raw = readFileSync(join(inDir, "cases.json"), "utf8");
const cases: unknown = JSON.parse(raw);

if (!Array.isArray(cases)) {
  throw new Error("expected cases.json to hold a JSON array of cases");
}

const rendered: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  const entry = cases[i] as { markdown?: unknown };
  const md = typeof entry.markdown === "string" ? entry.markdown : "";
  rendered[i] = parse(md);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "html.json"), JSON.stringify(rendered));
