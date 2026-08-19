// Boundary input-validation pattern.
//
// Rule: external input is *parsed into a typed value at the boundary*,
// never cast, never spread raw into a query/model. The schema is an
// allowlist — fields not in it cannot reach your domain (this is also the
// mass-assignment fix). Read the parsed value, never the raw request again.

import { z } from "zod";

// 1. One schema per input shape. List exactly the fields the server
//    accepts. No `.passthrough()`. Constrain types/lengths/enums tightly.
export const UpdateProfile = z
  .object({
    name: z.string().trim().min(1).max(80),
    bio: z.string().max(500).optional(),
    // privilege fields (role, isAdmin, ownerId, balance) are deliberately
    // ABSENT — they are set by server logic, never bindable from input.
  })
  .strict(); // reject unknown keys instead of silently dropping them

export type UpdateProfile = z.infer<typeof UpdateProfile>;

// 2. Parse at the boundary. Throw a generic error on failure; log the
//    detail server-side only (no schema/internal echo to the client).
export function parseInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) {
    // server-side structured log:
    // logger.warn("input validation failed", { issues: r.error.issues });
    throw new Response("Bad Request", { status: 400 });
  }
  return r.data;
}

// 3. Use the parsed value only; assign explicit fields, not the object.
//
//   const dto = parseInput(UpdateProfile, await req.json());
//   await db.user.update({
//     where: { id: session.userId },        // authz: principal-scoped, not body.id
//     data: { name: dto.name, bio: dto.bio },
//   });
//
// Framework-native equivalents (prefer them — same allowlist principle):
//   Hono:    zValidator("json", UpdateProfile) → c.req.valid("json")
//   Next.js: parse formData/args inside the Server Action before any effect
//   Nuxt:    UpdateProfile.parse(await readBody(event)) in the Nitro handler
//
// Numbers/ids from path/query are strings — coerce + constrain
// (z.coerce.number().int().positive()) so operator/type confusion
// (e.g. NoSQL {"$gt":""}) can't pass.
