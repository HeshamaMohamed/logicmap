import { FastifyInstance } from "fastify";

const ADMIN_TOKEN = "admin-secret";

export async function adminRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", async (request, reply) => {
    if (request.headers["x-admin-token"] !== ADMIN_TOKEN) {
      reply.status(403).send({ error: "forbidden" });
    }
  });

  fastify.get("/stats", async () => ({ notes: 0 }));
}
