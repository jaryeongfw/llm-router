/**
 * pi 확장 훅: 모든 모델 호출에서 비밀 값을 가리고, 도구 실행 직전에 되돌린다 (07-spec §6.5).
 *   context   : 모델 호출 직전마다 메시지 사본을 가린다 (세션 파일의 원본은 그대로)
 *   tool_call : 도구 인자의 [[MASKED n]]을 원래 값으로 바꾼다. 모르는 번호면 실행을 막는다
 *   before_agent_start : 자리표시 사용법을 시스템 프롬프트 지침에 넣는다 (고정 문구라 캐시에 영향 없음)
 * 세션마다 별도 저장소를 쓴다. 시스템 프롬프트(AGENTS.md 등)는 다루지 않는다 (§13 S12).
 */
import { SecretVault } from "./secrets.ts";
import type { CompiledRule } from "./stage1.ts";

/** 이 모듈이 쓰는 pi ExtensionAPI의 최소 부분 (테스트에서 가짜 객체로 대체). */
/** 모델에게 주는 지침. 이것이 없으면 모델이 자리표시를 "가려져서 쓸 수 없는 값"으로 보고 작업을 멈춘다 (08 §7). */
export const MASK_GUIDELINE =
  "Values shown as [[MASKED n name]] are secrets hidden from you for security. When a tool call needs the secret, write the placeholder exactly as shown in the tool arguments; it is replaced with the real value just before the tool runs. Do not ask the user for the value, and do not try to print or reveal it.";

export interface GuardHost {
  on(event: "before_agent_start", handler: (event: { systemPromptOptions?: { promptGuidelines?: string[] } }, ctx: GuardCtx) => unknown): unknown;
  on(event: "context", handler: (event: { messages: any[] }, ctx: GuardCtx) => unknown): unknown;
  on(event: "tool_call", handler: (event: { toolName: string; input: Record<string, unknown> }, ctx: GuardCtx) => unknown): unknown;
}
export interface GuardCtx {
  sessionManager?: { getSessionId(): string };
}

export interface GuardStats { masked: number; unmasked: number; blocked: number }

export function registerSecretGuard(pi: GuardHost, rules: CompiledRule[], onStat?: (s: GuardStats) => void) {
  const vaults = new Map<string, SecretVault>();
  const stats: GuardStats = { masked: 0, unmasked: 0, blocked: 0 };
  const vaultFor = (ctx: GuardCtx) => {
    const id = ctx.sessionManager?.getSessionId() ?? "default";
    let v = vaults.get(id);
    if (!v) {
      v = new SecretVault(rules);
      vaults.set(id, v);
    }
    return v;
  };

  pi.on("before_agent_start", (event) => {
    const g = event.systemPromptOptions?.promptGuidelines;
    if (g && !g.includes(MASK_GUIDELINE)) g.push(MASK_GUIDELINE);
    return undefined;
  });

  pi.on("context", (event, ctx) => {
    const r = vaultFor(ctx).maskMessages(event.messages);
    if (r.count === 0) return undefined;
    stats.masked += r.count;
    onStat?.(stats);
    return { messages: r.messages };
  });

  pi.on("tool_call", (event, ctx) => {
    const r = vaultFor(ctx).unmaskInPlace(event.input);
    stats.unmasked += r.replaced;
    if (r.unknown.length) {
      stats.blocked++;
      onStat?.(stats);
      return { block: true, reason: `가려진 값 자리표시를 복원할 수 없습니다: ${[...new Set(r.unknown)].map((n) => `[[MASKED ${n}]]`).join(", ")}. 실제 값은 파일이나 환경 변수에서 직접 읽으세요.` };
    }
    if (r.replaced) onStat?.(stats);
    return undefined;
  });

  return { stats, vaults };
}
