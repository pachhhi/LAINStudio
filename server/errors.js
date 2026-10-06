export class AppError extends Error {
  constructor(message, { status = 400, code = 'BAD_REQUEST', expose = true } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.expose = expose;
  }
}

export class ValidationError extends AppError {
  constructor(message) { super(message, { status: 400, code: 'VALIDATION_ERROR' }); }
}
export class NotFoundError extends AppError {
  constructor(message) { super(message, { status: 404, code: 'NOT_FOUND' }); }
}
export class ConflictError extends AppError {
  constructor(message) { super(message, { status: 409, code: 'CONFLICT' }); }
}
export class DependencyError extends AppError {
  constructor(message = 'Payment provider unavailable.') { super(message, { status: 502, code: 'DEPENDENCY_ERROR' }); }
}
