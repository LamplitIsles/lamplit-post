export class Fault extends Error {
  constructor(
    public code:
      | "not_found"
      | "invalid_request"
      | "conflict"
      | "unavailable"
      | "capacity"
      | "internal",
    message: string = code,
  ) {
    super(message);
  }
}
// A readable Keet room whose self membership has not yet arrived.
export class UnconfirmedKeetMembership extends Fault {
  constructor() {
    super("unavailable");
  }
}
export function need(
  value: unknown,
  code: Fault["code"] = "not_found",
): asserts value {
  if (!value) throw new Fault(code);
}
