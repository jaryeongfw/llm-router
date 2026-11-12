import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function run(script: string, args: string[]) {
  const r = spawnSync("bash", [join(ROOT, "scripts", script), ...args], { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ops-test-"));
}

export function touch(dir: string, name: string, ageDays = 0): string {
  const p = join(dir, name);
  writeFileSync(p, "x");
  const t = Date.now() / 1000 - ageDays * 86_400;
  utimesSync(p, t, t);
  return p;
}

export function list(dir: string): string[] {
  return readdirSync(dir).sort();
}
