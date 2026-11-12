export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class OutOfStockError extends Error {
  sku: string;
  requested: number;
  available: number;
  constructor(sku: string, requested: number, available: number) {
    super(`재고 부족: ${sku} (요청 ${requested}, 가용 ${available})`);
    this.name = "OutOfStockError";
    this.sku = sku;
    this.requested = requested;
    this.available = available;
  }
}

export class InvalidStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStateError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
