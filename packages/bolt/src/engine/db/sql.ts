import type { Json } from '../../decl/values.ts';
import type { Sql } from '@norbital-ai/host-api';

/** A native statement with positional parameters in call order. */
export const sql = (text: string, ...params: Json[]): Sql => ({ text, params });
