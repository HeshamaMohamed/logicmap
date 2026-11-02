import { Request, Response, NextFunction } from "express";
import { findUserByToken } from "../services/users";

/** Lets a request through only with a valid bearer token. */
export async function requireUser(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Sign in first" });
  }
  const user = await findUserByToken(header.slice(7));
  if (!user) {
    return res.status(401).json({ error: "Unknown token" });
  }
  res.locals.user = user;
  next();
}
