/**
 * pi 확장 진입점.
 *   - router/auto (virtual model): 사용자 쿼리마다 (티어, 모델, 추론 강도)를 정한다 (src/runtime.ts)
 *   - secret guard: 모든 모델 호출에서 비밀 값을 가리고 도구 실행 직전에 되돌린다 (src/secret-guard.ts)
 *   - 화면: 쿼리 카드, 상태줄, /router status·stats (src/ui.ts)
 * 설정: config/llm-router.default.json + 사용자 설정(~/.pi/agent/llm-router.json 또는 LLM_ROUTER_CONFIG)
 */
import { loadConfig } from "./config.ts";
import { registerRouter, type RouterHost } from "./runtime.ts";
import { registerSecretGuard, type GuardHost } from "./secret-guard.ts";
import { registerUi, type UiHost } from "./ui.ts";

export default function llmRouter(pi: RouterHost & GuardHost & UiHost) {
  const loaded = loadConfig();
  registerSecretGuard(pi, loaded.rules);
  const router = registerRouter(pi, loaded);
  registerUi(pi, router);
  // 사용자 설정 오류는 로딩을 막지 않고 세션 시작 때 알린다 (무시된 항목은 기본값으로 동작)
  if (loaded.configIssues.length) {
    pi.on("session_start", (_e, ctx) => ctx.ui.notify(`llm-router 설정 문제:\n- ${loaded.configIssues.join("\n- ")}`, "warning"));
  }
}
