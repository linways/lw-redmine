/**
 * Ambient types for the optional `keytar` dependency.
 *
 * keytar is an optionalDependency: on machines where its native build fails
 * (no compiler toolchain, no libsecret, a non-root npm prefix) `npm install`
 * succeeds without it, and `src/foundation/auth.ts` lazy-loads it behind a
 * try/catch that falls back to file auth. The runtime is fine — but `tsc`
 * resolves imports statically, so without this declaration the build fails
 * with TS2307 on exactly the headless agent/CI hosts the optional dependency
 * exists to support.
 *
 * Only the three methods auth.ts uses are declared; add more here if that
 * changes. Shapes mirror keytar's public API
 * (https://github.com/atom/node-keytar).
 */
declare module 'keytar' {
  export function getPassword(service: string, account: string): Promise<string | null>;
  export function setPassword(service: string, account: string, password: string): Promise<void>;
  export function deletePassword(service: string, account: string): Promise<boolean>;
}
