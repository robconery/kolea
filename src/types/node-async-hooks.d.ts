/**
 * Just enough of `node:async_hooks` to type `core/activity.ts`.
 *
 * ⚠️ Deliberately NOT `@types/node`. Adding "node" to `types` in tsconfig pulls
 * Node's `Response`, `Headers` and `fetch` into scope alongside workerd's, and
 * TypeScript then silently resolves the wrong overloads — the same failure that
 * gives `src/client/` its own tsconfig. The runtime side is real and supported:
 * `nodejs_compat` is on in wrangler.jsonc, which is what provides the module.
 */
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R
    getStore(): T | undefined
  }
}
