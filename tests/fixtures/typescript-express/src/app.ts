import express from "express";
import cors from "cors";
import { requireUser } from "./middleware/auth";
import { ordersRouter } from "./routes/orders";
import { healthCheck } from "./routes/health";

export const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", healthCheck);

app.use("/api/orders", requireUser, ordersRouter);

// Answers every error a handler passes on with next(err).
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: "Something went wrong" });
});
