// The outcomes of an HTTP request, named after the status, each with one kind.
// The Express and Fastify adapters define them up front, so every unit gives a
// status the same code and kind (gaps/http-outcome-kinds.md).

import { COPY } from "../copy.mjs";

export const HTTP_OUTCOMES = {
  BAD_REQUEST: { kind: "user-error", text: COPY.badRequest },
  UNPROCESSABLE_ENTITY: { kind: "user-error", text: COPY.unprocessable },
  PAYLOAD_TOO_LARGE: { kind: "user-error", text: COPY.tooLarge },
  UNAUTHORIZED: { kind: "rejected", text: COPY.unauthorized },
  PAYMENT_REQUIRED: { kind: "rejected", text: COPY.paymentRequired },
  FORBIDDEN: { kind: "rejected", text: COPY.forbidden },
  NOT_FOUND: { kind: "rejected", text: COPY.notFound },
  CONFLICT: { kind: "rejected", text: COPY.conflict },
  TOO_MANY_REQUESTS: { kind: "rejected", text: COPY.tooManyRequests },
  INTERNAL_SERVER_ERROR: { kind: "crash", text: COPY.serverError },
};

export const HTTP_EXITS = "Name it with the outcome code already defined for its HTTP status (BAD_REQUEST, UNAUTHORIZED, PAYMENT_REQUIRED, FORBIDDEN, NOT_FOUND, CONFLICT, PAYLOAD_TOO_LARGE, UNPROCESSABLE_ENTITY, TOO_MANY_REQUESTS), or a new code for a status those do not cover";
