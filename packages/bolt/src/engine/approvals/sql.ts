import { literal } from '@norbital-ai/std/sql';
import { OPEN } from './machine.ts';

/** Native state spelling comes from the machine; compact preserves history SQL's existing bytes. */
export const open_sql = (column: 'state' | 'a.state' | 'ap.state', compact = false): string =>
	`${column} IN (${OPEN.map(literal).join(compact ? ',' : ', ')})`;
