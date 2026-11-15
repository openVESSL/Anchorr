// Every relative import in the server code (static and dynamic) points to a file that exists.
// Dynamic imports only fail when that code path runs, so a moved file can hide a broken one.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "frontend", "web", "test", ".git", "config", "logs", "docs"]);

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

test("relative imports resolve to existing files", () => {
  const broken = [];
  for (const file of sourceFiles(ROOT)) {
    const src = fs.readFileSync(file, "utf8");
    const specifiers = [
      ...src.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g),
      ...src.matchAll(/\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g),
    ].map((m) => m[1]);
    for (const spec of specifiers) {
      if (!fs.existsSync(path.resolve(path.dirname(file), spec))) broken.push(`${path.relative(ROOT, file)} -> ${spec}`);
    }
  }
  assert.deepEqual(broken, []);
});
