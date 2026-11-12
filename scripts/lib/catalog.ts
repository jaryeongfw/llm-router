/** `pi --list-models` 출력으로 지금 쓸 수 있는 모델 목록을 만든다 (스크립트용. 플러그인은 ctx.modelRegistry를 쓴다). */
import { execFileSync } from "node:child_process";
import type { CatalogModel } from "../../src/models.ts";

const size = (s: string) => {
  const m = s.match(/^([\d.]+)([KM]?)$/);
  return m ? Math.round(Number(m[1]) * (m[2] === "M" ? 1e6 : m[2] === "K" ? 1e3 : 1)) : undefined;
};

export function cliCatalog(): CatalogModel[] {
  const out = execFileSync("pi", ["--list-models"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return out.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 6 && c[0] !== "router").map((c) => ({
    provider: c[0], id: c[1], contextWindow: size(c[2]), maxTokens: size(c[3]), reasoning: c[4] === "yes", input: c[5] === "yes" ? ["text", "image"] : ["text"],
  }));
}
