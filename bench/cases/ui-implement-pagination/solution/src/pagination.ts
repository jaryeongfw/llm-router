export type PageItem = number | "…";

/** 첫·마지막 페이지와 current ± siblings를 보이고, 사이 간격이 2페이지 이상이면 "…", 1페이지면 그 페이지를 보인다. */
export function getPageItems(current: number, total: number, siblings = 1): PageItem[] {
  if (!Number.isInteger(total) || total < 0) throw new RangeError(`total 오류: ${total}`);
  if (total === 0) return [];
  if (!Number.isInteger(current) || current < 1 || current > total) throw new RangeError(`current 오류: ${current}`);
  const pages = new Set<number>([1, total]);
  for (let p = current - siblings; p <= current + siblings; p++) if (p >= 1 && p <= total) pages.add(p);
  const sorted = [...pages].sort((a, b) => a - b);
  const out: PageItem[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0) {
      const gap = sorted[i] - sorted[i - 1];
      if (gap === 2) out.push(sorted[i] - 1);
      else if (gap > 2) out.push("…");
    }
    out.push(sorted[i]);
  }
  return out;
}
