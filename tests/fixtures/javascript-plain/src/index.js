import { applyDiscount } from "./discount.js";

/** Totals the cart in cents after the discount code. */
export function cartTotal(items, code) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return applyDiscount(subtotal, code);
}
