/**
 * pi 확장 진입점. `pi -e ./src/index.ts` 또는 패키지 설치로 불러온다.
 * 현재: 비밀 값 가림 훅(secret guard). 라우터 virtual model(router/auto)은 다음 단계에서 등록한다.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerSecretGuard, type GuardHost } from "./secret-guard.ts";
import { compileRules, type RulesFile } from "./stage1.ts";

const ROOT = join(import.meta.dirname, "..");

export default function llmRouter(pi: GuardHost) {
  const rules = compileRules(JSON.parse(readFileSync(join(ROOT, "config/sensitivity-rules.json"), "utf8")) as RulesFile);
  registerSecretGuard(pi, rules);
}
