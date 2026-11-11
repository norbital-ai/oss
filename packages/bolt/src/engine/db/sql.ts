import type { Json } from '../../decl/values.ts';
import type { Sql } from '../contracts.ts';

/** A native statement with positional parameters in call order. */
export const sql = (text: string, ...params: Json[]): Sql => ({ text, params });
