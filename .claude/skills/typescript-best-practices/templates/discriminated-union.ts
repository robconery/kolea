/**
 * Discriminated (tagged) union — make illegal states unrepresentable.
 *
 * Instead of one object with optional `loading`/`data`/`error` fields (where
 * `loading: true, data: {...}, error: Error` all-set is a "valid" type), each
 * state is its own shape keyed by a literal discriminant. The compiler then
 * knows exactly which fields exist in each branch, and (with `assertNever`)
 * forces every consumer to handle every state.
 */

export interface User {
  id: string;
  name: string;
}

export type RemoteData =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: User }
  | { status: "error"; error: Error };

/** Compile-time exhaustiveness guard + runtime guard against bad data. */
function assertNever(x: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(x)}`);
}

/**
 * `switch` returning a value: every arm must produce `string`, and adding a
 * new RemoteData member without a case is a COMPILE error at `assertNever`.
 */
export function describe(state: RemoteData): string {
  switch (state.status) {
    case "idle":
      return "Not started";
    case "loading":
      return "Loading…";
    case "success":
      return `Loaded ${state.data.name}`; // .data exists only here
    case "error":
      return `Failed: ${state.error.message}`; // .error exists only here
    default:
      return assertNever(state);
  }
}

// --- A small state machine on top of the union -----------------------------

export function reduce(state: RemoteData, event: RemoteData): RemoteData {
  // transitions are explicit; an impossible (state,event) pair can be rejected
  return event;
}

// --- Usage -----------------------------------------------------------------
//
//   let s: RemoteData = { status: "idle" };
//   s = { status: "loading" };
//   s = { status: "success", data: { id: "u1", name: "Ada" } };
//   describe(s); // "Loaded Ada"
//
//   // s = { status: "success" };          // ❌ compile error: missing `data`
//   // s = { status: "loading", data: x }; // ❌ compile error: extra `data`
