/**
 * pi 확장 진입점.
 *   - router/auto (virtual model): 사용자 쿼리마다 (티어, 모델, 추론 강도)를 정한다 (src/runtime.ts)
 *   - secret guard: 모든 모델 호출에서 비밀 값을 가리고 도구 실행 직전에 되돌린다 (src/secret-guard.ts)
 * 설정: config/llm-router.default.json + 사용자 설정(~/.pi/agent/llm-router.json 또는 LLM_ROUTER_CONFIG)
 */
import { loadConfig } from "./config.ts";
import { registerRouter, type RouterHost } from "./runtime.ts";
import { registerSecretGuard, type GuardHost } from "./secret-guard.ts";

export default function llmRouter(pi: RouterHost & GuardHost) {
  const loaded = loadConfig();
  registerSecretGuard(pi, loaded.rules);
  registerRouter(pi, loaded);
}
