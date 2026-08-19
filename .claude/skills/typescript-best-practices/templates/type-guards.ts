/**
 * Type guards & assertion functions — validate untrusted data at the
 * boundary so the type is *earned*, never cast.
 *
 * `JSON.parse`, `req.body`, env vars, DB rows are `unknown`. `x as User` is
 * a lie the compiler believes. A guard/assertion turns `unknown` into a
 * proven type with a real runtime check.
 *
 * For non-trivial schemas, prefer a runtime validation library (Zod,
 * Valibot, ArkType) that *infers* the static type from the schema, so the
 * type and the validator can't drift. Hand-written guards like these are
 * fine for small/internal shapes.
 */

export interface CreateUserInput {
  email: string;
  age: number;
  role?: "admin" | "member";
}

// --- primitive helpers ---

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

// --- type guard: returns boolean, narrows on true ---

export function isCreateUserInput(v: unknown): v is CreateUserInput {
  if (!isObject(v)) return false;
  if (!isString(v.email) || !v.email.includes("@")) return false;
  if (!isNumber(v.age) || v.age < 0) return false;
  if (v.role !== undefined && v.role !== "admin" && v.role !== "member") {
    return false;
  }
  return true;
}

// --- assertion function: throws, narrows for the rest of the scope ---

export function assertCreateUserInput(
  v: unknown,
): asserts v is CreateUserInput {
  if (!isCreateUserInput(v)) {
    throw new Error(`Invalid CreateUserInput: ${JSON.stringify(v)}`);
  }
}

// --- generic array guard ---

export function isArrayOf<T>(
  v: unknown,
  item: (x: unknown) => x is T,
): v is T[] {
  return Array.isArray(v) && v.every(item);
}

// --- Usage -----------------------------------------------------------------
//
//   const body: unknown = JSON.parse(raw);
//
//   // guard style:
//   if (!isCreateUserInput(body)) return reply(400, "bad input");
//   createUser(body);                 // body: CreateUserInput here
//
//   // assertion style:
//   assertCreateUserInput(body);
//   createUser(body);                 // narrowed for the rest of the scope
//
//   isArrayOf(JSON.parse(raw), isCreateUserInput); // unknown -> CreateUserInput[]
