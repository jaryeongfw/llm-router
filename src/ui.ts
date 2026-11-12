/**
 * pi 화면 연결 (A: 쿼리 카드, B: 상태줄, C: /router stats).
 *   - agent_settled: router/auto로 처리한 쿼리가 끝나면 결정과 실제 사용량을 카드 항목(llm-router-query)으로 남긴다.
 *     카드는 세션에 저장되지만 모델 입력에는 들어가지 않는다.
 *   - 상태줄: 세션 누적 티어별 쿼리 수와 비용 (세션을 다시 열어도 카드에서 복원)
 *   - /router [status|stats]
 */
import { cardLines, plainTheme, statsLines, statusText, summarize, visibleWidth, type AssistantLike, type QueryCard, type ThemeLike } from "./report.ts";
import type { DecisionRecord } from "./runtime.ts";

export const CARD_TYPE = "llm-router-query";
const STATUS_KEY = "llm-router";

type Entry = { type: string; customType?: string; data?: unknown; message?: AssistantLike & { role: string } };
interface UiCtx {
  hasUI?: boolean;
  model?: { provider: string; id: string };
  ui: { theme?: ThemeLike & { bg?(c: string, t: string): string }; setStatus?(key: string, text: string | undefined): void; notify(msg: string, level?: string): void };
  sessionManager: { getBranch(): Entry[]; getSessionId(): string };
}
export interface UiHost {
  on(event: "agent_settled", h: (e: { aborted?: boolean }, ctx: UiCtx) => unknown): unknown;
  on(event: "session_start", h: (e: unknown, ctx: UiCtx) => unknown): unknown;
  appendEntry(customType: string, data: unknown): void;
  registerEntryRenderer?(customType: string, r: (entry: { data?: unknown }, opts: { expanded: boolean }, theme: ThemeLike & { bg?(c: string, t: string): string }) => unknown): void;
  registerCommand?(name: string, opts: { description: string; getArgumentCompletions?: (p: string) => { value: string; label: string }[] | null; handler: (args: string, ctx: UiCtx) => unknown }): void;
}

export interface RouterHandle {
  last: Map<string, DecisionRecord>;
  takePending(sessionId: string): DecisionRecord | undefined;
  pinScope: "query" | "session";
}

export const cardsOf = (branch: readonly Entry[]): QueryCard[] =>
  branch.filter((e) => e.type === "custom" && e.customType === CARD_TYPE && e.data).map((e) => e.data as QueryCard);

/** 마지막 사용자 메시지 뒤의 어시스턴트 메시지 (= 이번 쿼리의 응답들) */
export function currentQueryAssistants(branch: readonly Entry[]): AssistantLike[] {
  let i = branch.length - 1;
  while (i >= 0 && !(branch[i].type === "message" && branch[i].message?.role === "user")) i--;
  return branch.slice(i + 1).filter((e) => e.type === "message" && e.message?.role === "assistant").map((e) => e.message!);
}

export function buildCard(rec: DecisionRecord, pinned: boolean, aborted: boolean, assistants: AssistantLike[]): QueryCard {
  const d = rec.decision;
  return {
    v: 1, card_id: `${rec.state.decision_ref}${pinned ? `-p${Date.now().toString(36)}` : ""}`, query_id: rec.state.query_id, tier: d.tier, model: d.model, thinking: d.thinking, operating_point: d.operating_point,
    cell: d.table_cell, adjustments: d.adjustments, thinking_adjustments: d.thinking_adjustments,
    analyzer: rec.analyzer, analyzer_ms: rec.latency_ms.stage2, stage2: rec.stage2,
    capped: d.capped, ask_user: d.ask_user, pinned, aborted, usage: summarize(assistants),
  };
}

export function registerUi(pi: UiHost, router: RouterHandle) {
  const themeOf = (ctx: UiCtx): ThemeLike => ctx.ui.theme ?? plainTheme;
  const refreshStatus = (ctx: UiCtx, extra: QueryCard[] = []) => {
    if (!ctx.ui.setStatus) return;
    ctx.ui.setStatus(STATUS_KEY, statusText([...cardsOf(ctx.sessionManager.getBranch()), ...extra], themeOf(ctx)));
  };

  pi.on("session_start", (_e, ctx) => {
    refreshStatus(ctx);
  });

  pi.on("agent_settled", (e, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    const pending = router.takePending(sid);
    if (ctx.model?.provider !== "router" && !pending) return;
    // 새 결정이 없으면: 세션 고정 중일 때만 "이전 결정 유지" 카드. 그 밖(예: 라우터가 차단)은 카드 없음
    const rec = pending ?? (router.pinScope === "session" ? router.last.get(sid) : undefined);
    if (!rec) return;
    const assistants = currentQueryAssistants(ctx.sessionManager.getBranch());
    if (!assistants.length) return;
    const card = buildCard(rec, !pending, e.aborted === true, assistants);
    pi.appendEntry(CARD_TYPE, card);
    // appendEntry가 바로 기록에 반영되지 않는 경우에도 상태줄에 이번 카드가 들어가게 한다
    refreshStatus(ctx, cardsOf(ctx.sessionManager.getBranch()).some((c) => c.card_id === card.card_id) ? [] : [card]);
  });

  pi.registerEntryRenderer?.(CARD_TYPE, (entry, { expanded }, theme) => ({
    render(width: number): string[] {
      const lines = cardLines(entry.data as QueryCard, width, theme, expanded);
      if (!theme.bg) return lines;
      return lines.map((l) => theme.bg!("customMessageBg", l + " ".repeat(Math.max(0, width - visibleWidth(l)))));
    },
    invalidate() {},
  }));

  pi.registerCommand?.("router", {
    description: "llm-router: /router status (마지막 결정), /router stats (세션 집계)",
    getArgumentCompletions: (p) => ["status", "stats"].filter((x) => x.startsWith(p)).map((x) => ({ value: x, label: x })),
    handler: (args, ctx) => {
      const sub = args.trim() || "status";
      const t = themeOf(ctx);
      if (sub === "stats") {
        const branch = ctx.sessionManager.getBranch();
        const all = summarize(branch.filter((x) => x.type === "message" && x.message?.role === "assistant").map((x) => x.message!));
        return ctx.ui.notify(statsLines(cardsOf(branch), all, t, 100).join("\n"), "info");
      }
      const rec = router.last.get(ctx.sessionManager.getSessionId());
      if (!rec) return ctx.ui.notify("아직 결정이 없습니다. /model router/auto 로 선택한 뒤 질문하세요.", "info");
      const card = buildCard(rec, false, false, currentQueryAssistants(ctx.sessionManager.getBranch()));
      return ctx.ui.notify(cardLines(card, 100, t, true).join("\n"), "info");
    },
  });
}

