/**
 * 1단(규칙)과 2단(분석기) 결과를 합쳐 결정 입력을 만든다 (07-spec §5).
 * 필수 제약은 1단이 소유한다. 2단은 sensitivity_suspected로 민감도를 올릴 수만 있다.
 * 단, 받을 local 모델이 없으면 2단 의심만으로는 막지 않는다 (suspicion_without_local: "warn").
 * 외부 판단 모델이 의심을 냈다면 요청은 이미 외부로 나간 뒤이고, 1단이 못 잡은 "의심"으로 막으면 보호 효과 없이 작업만 멈춘다.
 */
import type { AnalysisInput } from "./decide.ts";
import type { Stage1Result } from "./stage1.ts";
import type { Stage2Result } from "./stage2.ts";

export interface MergedAnalysis {
  analysis: AnalysisInput;
  /** 민감도를 internal_only로 만든 출처 */
  sensitiveBy: ("stage1" | "stage2")[];
  /** 2단이 민감 의심을 냈지만 반영하지 않은 이유 */
  suspicionIgnored: "secret_masked" | "no_local" | null;
}

export interface MergeOptions {
  /** 로컬 전용 데이터를 받을 local 모델이 있는지 (기본 true) */
  localAvailable?: boolean;
  /** local 모델이 없을 때 2단 의심 처리. warn: 반영하지 않고 표시만 / block: 로컬 전용으로 올려 막는다 */
  suspicionWithoutLocal?: "warn" | "confirm" | "block";
  /** 대화 전체의 예상 토큰 수 (runtime estimateTokens) */
  estContextTokens?: number | null;
}

export function mergeStages(s1: Stage1Result, s2: Stage2Result, opts: MergeOptions = {}): MergedAnalysis {
  const hc = { ...s1.hard_constraints };
  const sensitiveBy: MergedAnalysis["sensitiveBy"] = [];
  let suspicionIgnored: MergedAnalysis["suspicionIgnored"] = null;
  if (hc.data_sensitivity === "internal_only") sensitiveBy.push("stage1");
  if (s2.output?.sensitivity_suspected) {
    if (hc.secret_present) {
      // 비밀정보는 이미 1단이 찾아 가렸고 secret_policy로 처리한다. 분석기는 가린 자리를 보고 의심을 낼 수 있으므로,
      // 이것을 internal_only로 올리면 "비밀정보 + 로컬 전용"이 되어 잘못 차단된다 (08 §6).
      suspicionIgnored = "secret_masked";
    } else if (opts.localAvailable === false && opts.suspicionWithoutLocal !== "block" && hc.data_sensitivity !== "internal_only") {
      suspicionIgnored = "no_local";
    } else {
      hc.data_sensitivity = "internal_only";
      sensitiveBy.push("stage2");
    }
  }
  const o = s2.output;
  return {
    analysis: {
      task_type: o?.task_type ?? { domain: "general", action: null },
      hard_constraints: hc,
      dimensions: o?.dimensions ?? { difficulty: null, ambiguity: null, scope: null, verifiability: null, capabilities: { reasoning: null } },
      confidence: o?.confidence ?? 0,
      ...(opts.estContextTokens != null ? { context_signals: { est_context_tokens: opts.estContextTokens } } : {}),
    },
    sensitiveBy,
    suspicionIgnored,
  };
}
