/**
 * Value Object template — an immutable, validated value with no identity.
 * Two value objects are equal when their contents are equal (not by
 * reference). Examples: Money, Email, DateRange, Quantity.
 *
 * Conventions baked in:
 *  - private fields + `readonly` (immutable; information hiding)
 *  - static factory does validation; constructor stays private
 *  - `equals` (structural identity)
 *  - `toString()` (human) and `toJSON()` (machine) per project rule
 *  - a named `MoneyJSON` type that *is* the serialization contract
 */

export interface MoneyJSON {
  readonly amount: string; // string to avoid float drift on the wire
  readonly currency: string;
}

export class Money {
  // store integer minor units (cents) — never floats for money
  readonly #cents: number;
  readonly #currency: string;

  private constructor(cents: number, currency: string) {
    this.#cents = cents;
    this.#currency = currency;
  }

  /** The only way in. Validate here so an invalid Money cannot exist. */
  static of(amountMajor: number, currency: string): Money {
    if (!Number.isFinite(amountMajor)) {
      throw new Error(`Money amount not finite: ${amountMajor}`);
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new Error(`Invalid currency code: ${currency}`);
    }
    return new Money(Math.round(amountMajor * 100), currency);
  }

  static fromJSON(j: MoneyJSON): Money {
    return Money.of(Number(j.amount), j.currency);
  }

  // --- behavior (returns NEW instances; never mutates) ---

  add(other: Money): Money {
    this.#assertSameCurrency(other);
    return new Money(this.#cents + other.#cents, this.#currency);
  }

  gt(other: Money): boolean {
    this.#assertSameCurrency(other);
    return this.#cents > other.#cents;
  }

  equals(other: Money): boolean {
    return this.#cents === other.#cents && this.#currency === other.#currency;
  }

  #assertSameCurrency(other: Money): void {
    if (this.#currency !== other.#currency) {
      throw new Error(`Currency mismatch: ${this.#currency} vs ${other.#currency}`);
    }
  }

  // --- mandatory serialization contract ---

  toJSON(): MoneyJSON {
    return { amount: (this.#cents / 100).toFixed(2), currency: this.#currency };
  }

  toString(): string {
    return `${(this.#cents / 100).toFixed(2)} ${this.#currency}`;
  }
}

// --- Usage -----------------------------------------------------------------
//
//   const price = Money.of(19.99, "USD");
//   const total = price.add(Money.of(5, "USD"));
//   `${total}`                       // "24.99 USD"   (toString)
//   JSON.stringify({ total })        // {"total":{"amount":"24.99","currency":"USD"}}
//   Money.fromJSON(total.toJSON()).equals(total) // true (round-trips)
