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

  refundLines(orderId: string, lineIndexes: number[]): { order: Order; refundAmount: number } {
    const order = this.repo.get(orderId);
    if (order.status !== "PLACED" && order.status !== "PARTIALLY_REFUNDED") {
      throw new InvalidStateError(`환불할 수 없는 상태: ${order.status}`);
    }
    if (lineIndexes.length === 0) throw new ValidationError("환불할 라인이 없습니다");
    const unique = new Set(lineIndexes);
    if (unique.size !== lineIndexes.length) throw new ValidationError("중복된 라인");
    for (const i of lineIndexes) {
      if (!Number.isInteger(i) || i < 0 || i >= order.lines.length) throw new ValidationError(`라인 범위 오류: ${i}`);
      if (order.refundedLines.includes(i)) throw new ValidationError(`이미 환불된 라인: ${i}`);
    }
    const { subtotal, tierDiscount, couponDiscount } = order.price;
    const paidGoods = subtotal - tierDiscount - couponDiscount;
    let refundAmount = 0;
    for (const i of lineIndexes) {
      const line = order.lines[i];
      const lineAmount = line.unitPrice * line.qty;
      refundAmount += subtotal === 0 ? 0 : Math.floor((lineAmount * paidGoods) / subtotal);
      this.inventory.release(line.sku, line.qty);
      order.refundedLines.push(i);
    }
    order.refundedLines.sort((a, b) => a - b);
    order.status = order.refundedLines.length === order.lines.length ? "REFUNDED" : "PARTIALLY_REFUNDED";
    this.repo.save(order);
    return { order, refundAmount };
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
