/**
 * Vercel runs api/ as native Node ESM (package.json "type": "module"), which
 * resolves relative specifiers literally. tsc's "bundler" resolution and
 * Vite both accept `./protocol` for `./protocol.ts`, so an extensionless
 * import type-checks and works in dev, then fails in production with
 * ERR_MODULE_NOT_FOUND. This walks every server source file instead.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function serverSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...serverSources(full));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Problems with one file's imports, as "file: specifier (reason)". */
function importProblems(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const { importedFiles } = ts.preProcessFile(source, true, true);
  const rel = path.relative(ROOT, file);
  const problems: string[] = [];
  for (const { fileName: spec } of importedFiles) {
    if (spec.startsWith("@/") || spec.startsWith("@shared/")) {
      problems.push(`${rel}: ${spec} (path aliases do not exist at runtime)`);
      continue;
    }
    if (!spec.startsWith(".")) continue;
    const target = path.resolve(path.dirname(file), spec);
    if (spec.endsWith(".js")) {
      if (!existsSync(target.replace(/\.js$/, ".ts")) && !existsSync(target)) problems.push(`${rel}: ${spec} (no such file)`);
    } else if (spec.endsWith(".json")) {
      if (!existsSync(target)) problems.push(`${rel}: ${spec} (no such file)`);
      const attributed = new RegExp(`["']${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']\\s+with\\s*\\{\\s*type:\\s*["']json["']`);
      if (!attributed.test(source)) problems.push(`${rel}: ${spec} (JSON imports need with { type: "json" })`);
    } else {
      problems.push(`${rel}: ${spec} (relative imports need a .js extension)`);
    }
  }
  return problems;
}

describe("server ESM imports", () => {
  const files = [...serverSources(path.join(ROOT, "api")), ...serverSources(path.join(ROOT, "shared"))];

  it("covers the functions and everything they share", () => {
    expect(files.map((f) => path.relative(ROOT, f))).toEqual(expect.arrayContaining(["api/act.ts", "shared/chat.ts"]));
  });

  it("only uses specifiers Node's ESM loader can resolve", () => {
    expect(files.flatMap(importProblems)).toEqual([]);
  });
});
