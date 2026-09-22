import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodSchema } from 'zod';
import { ValidationError } from '../errors/AppError';

/**
 * Edge validation.
 *
 * The request body, params and query are the only untrusted inputs in the
 * system. They are parsed once, here, and everything downstream works with a
 * typed value. Services never re-check shapes; they check business rules.
 *
 * The parsed result REPLACES req.body / req.params / req.query, so a handler
 * cannot accidentally read the raw value -- including extra fields an attacker
 * appended, which zod strips by default.
 */

export interface ValidationSchemas {
  body?: ZodSchema;
  params?: ZodSchema;
  query?: ZodSchema;
}

const formatZodError = (error: ZodError): Record<string, unknown> => ({
  issues: error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  })),
});

export const validate = (schemas: ValidationSchemas): RequestHandler => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params);
      if (schemas.query) {
        // req.query has a getter-only descriptor in some Express versions.
        Object.defineProperty(req, 'query', {
          value: schemas.query.parse(req.query),
          writable: true,
          configurable: true,
        });
      }
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(new ValidationError('Request validation failed', formatZodError(error)));
        return;
      }
      next(error);
    }
  };
};
