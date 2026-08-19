/**
 * BDD specification — Jest
 *
 * Run with: npx jest   (or the project's `test` script)
 *
 * Structure (do not flatten):
 *   Feature        -> outermost describe, one per file, from a user story
 *     Scenario     -> nested describe; arranges ALL its data in beforeAll
 *       Specification -> it(); EXACTLY ONE assertion per it()
 *
 * Happy-path scenarios first and exhaustive.
 * Sad-path scenarios in their OWN separate describe blocks, below.
 *
 * Replace `ShoppingCart` and the domain calls with the real subject once
 * these specs are approved. The subject does not need to exist yet — these
 * specs are the design and are expected to fail first.
 */
import { describe, it, expect, beforeAll } from "@jest/globals";

import { ShoppingCart } from "../src/shopping-cart";
import { CartError } from "../src/shopping-cart";

describe("Feature: a customer builds a shopping cart", () => {
  // ---------------------------------------------------------------------
  // HAPPY PATH — exhaustive success outcomes, first.
  // ---------------------------------------------------------------------

  describe("Scenario: adding two distinct items", () => {
    let cart: ShoppingCart;

    // Arrange everything this scenario needs, once, here.
    beforeAll(() => {
      cart = new ShoppingCart();
      cart.add({ sku: "widget", unitPrice: 5, quantity: 2 });
      cart.add({ sku: "gadget", unitPrice: 10, quantity: 1 });
    });

    it("holds two line items", () => {
      expect(cart.lineItems).toHaveLength(2);
    });

    it("sums the widget line", () => {
      expect(cart.lineTotal("widget")).toBe(10);
    });

    it("sums the gadget line", () => {
      expect(cart.lineTotal("gadget")).toBe(10);
    });

    it("totals the whole cart", () => {
      expect(cart.total).toBe(20);
    });

    it("is not empty", () => {
      expect(cart.isEmpty).toBe(false);
    });
  });

  describe("Scenario: adding the same SKU twice merges quantities", () => {
    let cart: ShoppingCart;

    beforeAll(() => {
      cart = new ShoppingCart();
      cart.add({ sku: "widget", unitPrice: 5, quantity: 1 });
      cart.add({ sku: "widget", unitPrice: 5, quantity: 3 });
    });

    it("keeps a single line item", () => {
      expect(cart.lineItems).toHaveLength(1);
    });

    it("accumulates the quantity", () => {
      expect(cart.quantityOf("widget")).toBe(4);
    });

    it("prices the merged quantity", () => {
      expect(cart.total).toBe(20);
    });
  });

  // ---------------------------------------------------------------------
  // SAD PATH — segregated. Each failure mode is its own Scenario.
  // ---------------------------------------------------------------------

  describe("Scenario: rejecting a non-positive quantity", () => {
    let act: () => void;

    beforeAll(() => {
      const cart = new ShoppingCart();
      act = () => cart.add({ sku: "widget", unitPrice: 5, quantity: 0 });
    });

    it("throws a CartError", () => {
      expect(act).toThrow(CartError);
    });
  });

  describe("Scenario: rejecting a negative unit price", () => {
    let act: () => void;

    beforeAll(() => {
      const cart = new ShoppingCart();
      act = () => cart.add({ sku: "widget", unitPrice: -1, quantity: 1 });
    });

    it("throws a CartError", () => {
      expect(act).toThrow(CartError);
    });
  });
});
