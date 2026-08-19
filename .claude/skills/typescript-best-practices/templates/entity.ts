/**
 * Entity template — an object with stable identity and a lifecycle.
 * Two entities are equal iff their IDs are equal, even if other fields
 * differ (unlike a Value Object). Examples: User, Order, Account.
 *
 * Conventions baked in:
 *  - branded id type (see templates/branded-type.ts)
 *  - identity fields `readonly`; mutable state changed only via methods
 *    that enforce invariants
 *  - `equals` by id
 *  - `toString()` / `toJSON()` per project rule, with secrets redacted and
 *    a named `OrderJSON` contract + `fromJSON` for round-tripping
 */

import { Money, type MoneyJSON } from "./value-object.js";
import type { Brand } from "./branded-type.js";

export type OrderId = Brand<string, "OrderId">;
export const OrderId = (raw: string): OrderId => {
  if (!raw) throw new Error("OrderId cannot be empty");
  return raw as OrderId;
};

export type OrderStatus = "draft" | "placed" | "shipped" | "cancelled";

export interface OrderJSON {
  readonly id: string;
  readonly status: OrderStatus;
  readonly total: MoneyJSON;
  // customerEmail intentionally omitted — PII not in the default wire shape
}

export class Order {
  readonly #id: OrderId;
  #status: OrderStatus;
  #total: Money;
  readonly #customerEmail: string; // private; never serialized by default

  private constructor(
    id: OrderId,
    status: OrderStatus,
    total: Money,
    customerEmail: string,
  ) {
    this.#id = id;
    this.#status = status;
    this.#total = total;
    this.#customerEmail = customerEmail;
  }

  static create(id: OrderId, total: Money, customerEmail: string): Order {
    if (!customerEmail.includes("@")) throw new Error("invalid email");
    return new Order(id, "draft", total, customerEmail);
  }

  static fromJSON(j: OrderJSON, customerEmail: string): Order {
    return new Order(OrderId(j.id), j.status, Money.fromJSON(j.total), customerEmail);
  }

  get id(): OrderId {
    return this.#id;
  }
  get status(): OrderStatus {
    return this.#status;
  }

  // state transitions enforce the invariant — not free field assignment
  place(): void {
    if (this.#status !== "draft") {
      throw new Error(`Cannot place order in status ${this.#status}`);
    }
    this.#status = "placed";
  }

  /** Entity equality is by identity, never by field contents. */
  equals(other: Order): boolean {
    return this.#id === other.#id;
  }

  // --- mandatory serialization contract ---

  toJSON(): OrderJSON {
    return {
      id: this.#id,
      status: this.#status,
      total: this.#total.toJSON(),
    };
  }

  toString(): string {
    return `Order(id=${this.#id}, status=${this.#status}, total=${this.#total})`;
  }
}

// --- Usage -----------------------------------------------------------------
//
//   const o = Order.create(OrderId("o_123"), Money.of(42, "USD"), "a@b.com");
//   o.place();
//   `${o}`                    // "Order(id=o_123, status=placed, total=42.00 USD)"
//   JSON.stringify(o)         // no email in output (redacted by toJSON)
