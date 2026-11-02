import { Router } from "express";
import { OrderService } from "../services/orders";
import { ValidationError } from "@/errors";

export const ordersRouter = Router();
const orders = new OrderService();

ordersRouter.get("/", async (_req, res) => {
  res.json(await orders.list(res.locals.user.id));
});

ordersRouter.post("/", async (req, res) => {
  try {
    const order = await orders.create(res.locals.user.id, req.body.items);
    res.status(201).json(order);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(422).json({ error: err.message });
    }
    throw err;
  }
});

ordersRouter.get("/:id", async (req, res) => {
  const order = await orders.find(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });
  res.json(order);
});
