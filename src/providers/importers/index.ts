/**
 * The importer adapters, by id, and the HTTP they speak through.
 *
 * Production has no `IMPORT_HTTP` binding (it is in no wrangler environment),
 * so every adapter talks to the real API with global `fetch`. The test suite
 * binds a fake that answers like Kit, Ghost, Mailchimp and Drip, so no spec can
 * reach a third party.
 */
import { dripSource } from './drip.ts'
import { ghostSource } from './ghost.ts'
import { kitSource } from './kit.ts'
import { mailchimpSource } from './mailchimp.ts'
import type { HttpFetch, ImportSource } from './types.ts'

export const importSources: Record<ImportSource['id'], ImportSource> = {
  kit: kitSource,
  ghost: ghostSource,
  mailchimp: mailchimpSource,
  drip: dripSource,
}

export function importHttp(binding: Fetcher | undefined): HttpFetch {
  if (binding) return (url, init) => binding.fetch(url, init)
  return (url, init) => fetch(url, init)
}
