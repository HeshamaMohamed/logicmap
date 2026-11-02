import { ValidationError } from "../errors";

export const MAX_ITEMS = 20;

export interface Order {
  id: string;
  userId: string;
  items: string[];
  status: "open" | "paid";
}

const store = new Map<string, Order>();

export class OrderService {
  async list(userId: string): Promise<Order[]> {
    return [...store.values()].filter((o) => o.userId === userId);
  }

  async create(userId: string, items: unknown): Promise<Order> {
    if (!Array.isArray(items) || items.length === 0) {
      throw new ValidationError("An order needs at least one item");
    }
    if (items.length > MAX_ITEMS) {
      throw new ValidationError(`An order holds at most ${MAX_ITEMS} items`);
    }
    const order: Order = { id: String(store.size + 1), userId, items: items.map(String), status: "open" };
    store.set(order.id, order);
    return order;
  }

  async find(id: string): Promise<Order | null> {
    return store.get(id) ?? null;
  }
}
