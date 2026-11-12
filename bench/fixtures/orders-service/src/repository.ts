import { NotFoundError } from "./errors.ts";
import type { Order } from "./models.ts";

export class OrderRepository {
  private orders = new Map<string, Order>();
  private seq = 0;

  nextId(): string {
    this.seq += 1;
    return `O-${String(this.seq).padStart(4, "0")}`;
  }

  save(order: Order): void {
    this.orders.set(order.id, structuredClone(order));
  }

  get(id: string): Order {
    const order = this.orders.get(id);
    if (!order) throw new NotFoundError(`주문 없음: ${id}`);
    return structuredClone(order);
  }

  count(): number {
    return this.orders.size;
  }
}
