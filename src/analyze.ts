/**
 * 1단(규칙)과 2단(분석기) 결과를 합쳐 결정 입력을 만든다 (07-spec §5).
 * 필수 제약은 1단이 소유한다. 2단은 sensitivity_suspected로 민감도를 올릴 수만 있다.
 */
import type { AnalysisInput } from "./decide.ts";
import type { Stage1Result } from "./stage1.ts";
import type { Stage2Result } from "./stage2.ts";

export interface MergedAnalysis {
  analysis: AnalysisInput;
  /** 민감도를 internal_only로 만든 출처 */
  sensitiveBy: ("stage1" | "stage2")[];
  /** 2단이 민감 의심을 냈지만 반영하지 않은 이유 */
  suspicionIgnored: "secret_masked" | null;
}

export function mergeStages(s1: Stage1Result, s2: Stage2Result): MergedAnalysis {
  const hc = { ...s1.hard_constraints };
  const sensitiveBy: MergedAnalysis["sensitiveBy"] = [];
  let suspicionIgnored: MergedAnalysis["suspicionIgnored"] = null;
  if (hc.data_sensitivity === "internal_only") sensitiveBy.push("stage1");
  if (s2.output?.sensitivity_suspected) {
    if (hc.secret_present) {
      // 비밀정보는 이미 1단이 찾아 가렸고 secret_policy로 처리한다. 분석기는 가린 자리를 보고 의심을 낼 수 있으므로,
      // 이것을 internal_only로 올리면 "비밀정보 + 사내 전용"이 되어 잘못 차단된다 (08 §6).
      suspicionIgnored = "secret_masked";
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
    },
    sensitiveBy,
    suspicionIgnored,
  };
}
