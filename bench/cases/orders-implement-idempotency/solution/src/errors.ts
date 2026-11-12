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
    super("재고 부족");
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

export class IdempotencyConflictError extends Error {
  key: string;
  constructor(key: string) {
    super(`멱등 키 충돌: ${key}`);
    this.name = "IdempotencyConflictError";
    this.key = key;
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
