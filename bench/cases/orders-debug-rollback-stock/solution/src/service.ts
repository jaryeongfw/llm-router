import { MAX_QTY_PER_LINE } from "./config.ts";
import { InvalidStateError, ValidationError } from "./errors.ts";
import type { Inventory } from "./inventory.ts";
import type { Order, PlaceOrderInput } from "./models.ts";
import { priceOrder } from "./pricing.ts";
import type { OrderRepository } from "./repository.ts";

export class OrderService {
  private inventory: Inventory;
  private repo: OrderRepository;

  constructor(inventory: Inventory, repo: OrderRepository) {
    this.inventory = inventory;
    this.repo = repo;
  }

  placeOrder(input: PlaceOrderInput): Order {
    this.validate(input);
    const reserved: { sku: string; qty: number }[] = [];
    try {
      for (const line of input.lines) {
        this.inventory.reserve(line.sku, line.qty);
        reserved.push({ sku: line.sku, qty: line.qty });
      }
    } catch (err) {
      for (const r of reserved) this.inventory.release(r.sku, r.qty);
      throw err;
    }
    const order: Order = {
      id: this.repo.nextId(),
      customer: input.customer,
      lines: input.lines.map((l) => ({ ...l })),
      coupon: input.coupon ?? null,
      price: priceOrder(input.lines, input.customer.tier, input.coupon ?? null),
      status: "PLACED",
      refundedLines: [],
    };
    this.repo.save(order);
    return order;
  }

  cancelOrder(orderId: string): Order {
    const order = this.repo.get(orderId);
    if (order.status !== "PLACED") {
      throw new InvalidStateError(`취소할 수 없는 상태: ${order.status}`);
    }
    for (const line of order.lines) this.inventory.release(line.sku, line.qty);
    order.status = "CANCELLED";
    this.repo.save(order);
    return order;
  }

  getOrder(orderId: string): Order {
    return this.repo.get(orderId);
  }

  private validate(input: PlaceOrderInput): void {
    if (input.lines.length === 0) throw new ValidationError("주문 라인이 비어 있습니다");
    for (const line of input.lines) {
      if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > MAX_QTY_PER_LINE) {
        throw new ValidationError(`수량 범위 오류: ${line.sku} ${line.qty}`);
      }
      if (!Number.isInteger(line.unitPrice) || line.unitPrice < 0) {
        throw new ValidationError(`단가 오류: ${line.sku}`);
      }
    }
  }
}
