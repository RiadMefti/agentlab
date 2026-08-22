import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

import { ApplicationError } from "../domain/errors.js";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "The request is invalid.",
          details: error.issues
        }
      });
    }

    if (error instanceof ApplicationError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details })
        }
      });
    }

    app.log.error(error);
    return reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "Something went wrong. Check the local server log."
      }
    });
  });
}
