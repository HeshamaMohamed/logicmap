import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MAX_NOTE_LENGTH, NoteStore, NotFoundError } from "./notes/store";
import { adminRoutes } from "./admin/routes";
import { verifyToken } from "./auth/tokens";

export interface ServerState {
  store: NoteStore;
}

/** Builds the API: hooks, routes and the error handler. */
export function createServer(state: ServerState): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof NotFoundError) {
      reply.status(404).send({ error: "not_found" });
      return;
    }
    reply.status(500).send({ error: "internal_error" });
  });

  registerRoutes(app, state);
  app.register(adminRoutes, { prefix: "/admin" });
  return app;
}

function registerRoutes(app: FastifyInstance, state: ServerState): void {
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/up") return;
    const user = verifyToken(request.headers.authorization);
    if (!user) {
      reply.status(401).send({ error: "unauthorized" });
    }
  });

  app.get("/up", async () => ({ ok: true }));

  app.get("/notes/:id", async (request) => {
    const { id } = request.params as { id: string };
    return state.store.get(id);
  });

  app.post("/notes", { preHandler: [limitBody] }, async (request, reply) => {
    const { text } = request.body as { text?: string };
    if (!text) {
      reply.status(400).send({ error: "text_required" });
      return;
    }
    reply.status(201).send(state.store.add(text));
  });

  app.route({
    method: "DELETE",
    url: "/notes/:id",
    handler: async (request, reply) => {
      const { id } = request.params as { id: string };
      state.store.remove(id);
      reply.status(204).send();
    },
  });
}

async function limitBody(request: FastifyRequest, reply: FastifyReply) {
  const text = (request.body as { text?: string }).text ?? "";
  if (text.length > MAX_NOTE_LENGTH) {
    reply.status(413).send({ error: "note_too_long" });
  }
}
