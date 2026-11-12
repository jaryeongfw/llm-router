/**
 * 복원 가능한 비밀 값 가림 (07-spec §6.5).
 * - 모델로 나가는 메시지의 비밀 값을 `[[MASKED n 이름]]`으로 바꾼다.
 * - 모델이 도구 인자에 자리표시를 쓰면 실행 직전에 원래 값으로 되돌린다.
 * - 원래 값과 자리표시의 대응은 메모리에만 둔다. 어디에도 기록하지 않는다.
 * - 같은 값은 항상 같은 번호를 받는다. 대화 기록을 처음부터 같은 순서로 가리므로 프롬프트 캐시가 유지된다.
 */
import { secretLabel, secretSpans, type CompiledRule } from "./stage1.ts";

export const PLACEHOLDER_RE = /\[\[MASKED (\d+)(?: [a-z0-9_]+)?\]\]/g;

interface Entry { value: string; label: string }

/** pi-ai 메시지의 최소 구조. 알 수 없는 필드는 그대로 둔다. */
type Block = { type: string; text?: string; arguments?: unknown; textSignature?: string; [k: string]: unknown };
type Msg = { role: string; content?: string | Block[]; [k: string]: unknown };

export class SecretVault {
  private rules: CompiledRule[];
  private byValue = new Map<string, number>();
  private byIndex = new Map<number, Entry>();

  constructor(rules: CompiledRule[]) {
    this.rules = rules.filter((r) => r.group === "secret");
  }

  get size(): number {
    return this.byIndex.size;
  }

  private indexFor(value: string, label: string): number {
    let n = this.byValue.get(value);
    if (n === undefined) {
      n = this.byIndex.size + 1;
      this.byValue.set(value, n);
      this.byIndex.set(n, { value, label });
    }
    return n;
  }

  /** 텍스트 하나를 가린다. 이미 가린 자리표시는 그대로 둔다. */
  maskText(text: string): { text: string; count: number } {
    const spans = secretSpans(this.rules, text);
    if (spans.length === 0) return { text, count: 0 };
    let out = "";
    let pos = 0;
    for (const sp of spans) {
      const value = text.slice(sp.start, sp.end);
      const label = secretLabel(sp.rule);
      out += text.slice(pos, sp.start) + `[[MASKED ${this.indexFor(value, label)} ${label}]]`;
      pos = sp.end;
    }
    return { text: out + text.slice(pos), count: spans.length };
  }

  /** 자리표시를 원래 값으로 되돌린다. 모르는 번호는 그대로 두고 알려 준다. */
  unmaskText(text: string): { text: string; replaced: number; unknown: number[] } {
    let replaced = 0;
    const unknown: number[] = [];
    const out = text.replace(PLACEHOLDER_RE, (whole, n: string) => {
      const e = this.byIndex.get(Number(n));
      if (!e) {
        unknown.push(Number(n));
        return whole;
      }
      replaced++;
      return e.value;
    });
    return { text: out, replaced, unknown };
  }

  /** JSON 값 안의 모든 문자열을 가린다 (새 값 반환). */
  private maskJson(v: unknown): { v: unknown; count: number } {
    if (typeof v === "string") {
      const r = this.maskText(v);
      return { v: r.text, count: r.count };
    }
    if (Array.isArray(v)) {
      let count = 0;
      const arr = v.map((x) => {
        const r = this.maskJson(x);
        count += r.count;
        return r.v;
      });
      return { v: count ? arr : v, count };
    }
    if (v && typeof v === "object") {
      let count = 0;
      const obj: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const r = this.maskJson(x);
        count += r.count;
        obj[k] = r.v;
      }
      return { v: count ? obj : v, count };
    }
    return { v, count: 0 };
  }

  private maskBlock(b: Block, role: string): { b: Block; count: number } {
    // thinking 블록은 서명이 있어 바꾸면 안 된다. 모델 출력이므로 가린 값만 담고 있다.
    if (b.type === "thinking" || b.type === "image") return { b, count: 0 };
    if (b.type === "text" && typeof b.text === "string") {
      // 서명된 어시스턴트 텍스트는 바꾸지 않는다 (공급자가 거부할 수 있음)
      if (role === "assistant" && b.textSignature) return { b, count: 0 };
      const r = this.maskText(b.text);
      return { b: r.count ? { ...b, text: r.text } : b, count: r.count };
    }
    if (b.type === "toolCall" && b.arguments !== undefined) {
      // 도구 인자는 실행 직전에 복원된 원래 값으로 기록될 수 있으므로 다시 가린다
      const r = this.maskJson(b.arguments);
      return { b: r.count ? { ...b, arguments: r.v } : b, count: r.count };
    }
    return { b, count: 0 };
  }

  /**
   * 모델로 보낼 메시지 목록을 가린다. 바뀐 것이 없으면 같은 배열을 반환한다
   * (pi context 훅은 바뀌지 않은 목록이면 캐시된 앞부분을 그대로 쓴다).
   */
  maskMessages<T extends Msg>(messages: T[]): { messages: T[]; count: number } {
    let total = 0;
    const out = messages.map((m) => {
      if (m.role === "system") return m;
      if (typeof m.content === "string") {
        const r = this.maskText(m.content);
        total += r.count;
        return r.count ? { ...m, content: r.text } : m;
      }
      if (Array.isArray(m.content)) {
        let count = 0;
        const content = m.content.map((b) => {
          const r = this.maskBlock(b, m.role);
          count += r.count;
          return r.b;
        });
        total += count;
        return count ? { ...m, content } : m;
      }
      return m;
    });
    return { messages: total ? out : messages, count: total };
  }

  /** 도구 인자(객체)의 자리표시를 제자리에서 원래 값으로 바꾼다. */
  unmaskInPlace(input: Record<string, unknown>): { replaced: number; unknown: number[] } {
    let replaced = 0;
    const unknown: number[] = [];
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") {
        const r = this.unmaskText(v);
        replaced += r.replaced;
        unknown.push(...r.unknown);
        return r.text;
      }
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) v[i] = walk(v[i]);
        return v;
      }
      if (v && typeof v === "object") {
        for (const k of Object.keys(v)) (v as Record<string, unknown>)[k] = walk((v as Record<string, unknown>)[k]);
        return v;
      }
      return v;
    };
    walk(input);
    return { replaced, unknown };
  }
}
