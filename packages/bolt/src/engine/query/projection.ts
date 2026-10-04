import type { Json } from '../../decl/values.ts';
import { BoltError } from '../contracts.ts';

/** A read projection may withhold data, never invent, change or reorder it. */
export function assertReadSubset(original: Json, projected: Json): void {
 const fail = (): never => { throw new BoltError('invalid', 'deliver', 'Read projection must preserve original values and order.'); };
 if (original === projected) return;
 if (original === null || projected === null || typeof original !== 'object' || typeof projected !== 'object') fail();
 if (Array.isArray(original)) {
  if (!Array.isArray(projected)) fail();
  let cursor = 0;
  for (const value of projected as readonly Json[]) {
   let found = false;
   while (cursor < original.length) {
    try { assertReadSubset(original[cursor++]!, value); found = true; break; }
    catch (error) { if (!(error instanceof BoltError)) throw error; }
   }
   if (!found) fail();
  }
  return;
 }
 if (Array.isArray(projected)) fail();
 const source = original as { readonly [key: string]: Json };
 for (const [key, value] of Object.entries(projected as { readonly [key: string]: Json })) {
  if (!Object.hasOwn(source, key)) fail();
  assertReadSubset(source[key]!, value);
 }
 // Original identities cannot disappear while the record is retained.
 if (Object.hasOwn(source, 'id') && (projected as { readonly id?: Json }).id !== source['id']) fail();
}

/** Trusted context columns never ride the caller result; only declared JSON columns may narrow. */
export function applyReadProjection(original: { readonly [key: string]: Json }, output: Json, fields: readonly string[]): { readonly [key: string]: Json } {
 if (output === null || typeof output !== 'object' || Array.isArray(output)) throw new BoltError('invalid', 'deliver', 'Read projection must return a JSON object.');
 const projected = output as { readonly [key: string]: Json };
 const allowed = new Set(fields);
 for (const [key, value] of Object.entries(projected)) {
  if (!allowed.has(key) || !Object.hasOwn(original, key)) throw new BoltError('invalid', 'deliver', 'Read projection returned an undeclared column.');
  assertReadSubset(original[key]!, value);
 }
 const result = { ...original };
 for (const key of fields) {
  if (!Object.hasOwn(original, key)) continue;
  if (Object.hasOwn(projected, key)) result[key] = projected[key]!;
  else delete result[key];
 }
 return result;
}
