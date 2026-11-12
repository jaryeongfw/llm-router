import { runQueryFile } from "./db.ts";

const file = process.argv[2];
if (!file) {
  console.error("사용법: npm run query -- queries/<file>.sql");
  process.exit(2);
}
console.table(runQueryFile(file));
