import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(ROOT, "db/schema.sql"), "utf8"));
  db.exec(readFileSync(join(ROOT, "db/seed.sql"), "utf8"));
  return db;
}

export function runSql(db: DatabaseSync, sql: string): Record<string, unknown>[] {
  return db.prepare(sql).all().map((row) => ({ ...row }));
}

export function runQueryFile(relPath: string, db: DatabaseSync = openDb()): Record<string, unknown>[] {
  return runSql(db, readFileSync(join(ROOT, relPath), "utf8"));
}
