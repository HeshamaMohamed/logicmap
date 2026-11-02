import { OrderService } from "./services/orders";

test("an empty order is refused", async () => {
  await expect(new OrderService().create("ada", [])).rejects.toThrow();
});
