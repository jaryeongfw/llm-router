import { OutOfStockError, ValidationError } from "./errors.ts";

export class Inventory {
  private stock = new Map<string, number>();

  constructor(initial: Record<string, number> = {}) {
    for (const [sku, qty] of Object.entries(initial)) this.stock.set(sku, qty);
  }

  available(sku: string): number {
    return this.stock.get(sku) ?? 0;
  }

  reserve(sku: string, qty: number): void {
    if (qty <= 0) throw new ValidationError(`수량은 1 이상이어야 합니다: ${qty}`);
    const available = this.available(sku);
    if (qty > available) throw new OutOfStockError(sku, qty, available);
    this.stock.set(sku, available - qty);
  }

  release(sku: string, qty: number): void {
    if (qty <= 0) throw new ValidationError(`수량은 1 이상이어야 합니다: ${qty}`);
    this.stock.set(sku, this.available(sku) + qty);
  }
}
