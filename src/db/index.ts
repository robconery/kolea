import { drizzle } from 'drizzle-orm/d1'
import type { Env } from '../types.ts'
import * as schema from './schema.ts'

export type Db = ReturnType<typeof getDb>

export function getDb(env: Env) {
  return drizzle(env.DB, { schema })
}

export { schema }
