/** Expected failures carry a stable tag, a readable message and optional detail. */
export interface TriageError {
  readonly tag:
    | "rea_unavailable"
    | "rea_failed"
    | "unexpected_rea_output"
    | "unsupported_crash"
    | "invalid_arguments";
  readonly message: string;
  readonly detail?: unknown;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: TriageError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const err = (
  tag: TriageError["tag"],
  message: string,
  detail?: unknown,
): Result<never> => ({
  ok: false,
  error: detail === undefined ? { tag, message } : { tag, message, detail },
});
