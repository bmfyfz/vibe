/**
 * A set of writes that land together or not at all. Repositories add to it; the
 * command handler commits it once. Opaque to domain and application code.
 */
export interface UnitOfWork {
  commit(): Promise<void>;
}

export type BeginUnitOfWork = () => UnitOfWork;

/**
 * A commit broke a uniqueness rule, so none of it was written. This is how a
 * write that was computed from stale state gets rejected: see the guard on the
 * event log. `columns` are `table.column` names.
 */
export class ConstraintViolation extends Error {
  constructor(
    readonly columns: readonly string[],
    options?: ErrorOptions,
  ) {
    super(`Constraint violated on ${columns.join(", ")}`, options);
    this.name = "ConstraintViolation";
  }

  on(table: string): boolean {
    return this.columns.some((column) => column.startsWith(`${table}.`));
  }
}

const PATTERN = /(?:UNIQUE|PRIMARY KEY) constraint failed: ([\w.]+(?:, [\w.]+)*)/;

/** Finds a constraint violation in an error or anywhere in its chain of causes. */
export function findConstraintViolation(error: unknown): ConstraintViolation | null {
  for (let current = error, depth = 0; current != null && depth < 8; depth++) {
    if (current instanceof ConstraintViolation) return current;
    const message = current instanceof Error ? current.message : String(current);
    const match = PATTERN.exec(message);
    if (match?.[1]) return new ConstraintViolation(match[1].split(", "), { cause: error });
    current = current instanceof Error ? current.cause : null;
  }
  return null;
}
