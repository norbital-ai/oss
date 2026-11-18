import { Effect, Option, Schema } from 'effect';
import type { Rows } from '@norbital-ai/host-api';
import { IdValue } from '@norbital-ai/store/kind';
import type { NonEmpty } from '../../decl/values.ts';
import { decodeRows } from '../db/rows.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import { row } from '../system/rows.ts';

const Identity = row('sys_envoy', ['id', 'name']);
const Configuration = row('sys_envoy', [
	'name',
	'audience',
	'task',
	'policies',
	'group_messages',
	'delegation',
	'triage',
	'triage_scope',
	'dm'
]);
export type EnvoySpec = Omit<
	typeof Configuration.Type,
	'policies' | 'group_messages' | 'triage' | 'triage_scope'
> & {
	readonly policies: NonEmpty<string>;
	readonly group_messages: typeof Configuration.Type.group_messages;
	readonly triage: false | { readonly scope: typeof Configuration.Type.triage_scope };
};

/** The active envoys' read: a caller with reads of its own sends it in the same trip, and answers with `activeEnvoysOf`. */
export const activeEnvoysRead = {
	text: 'SELECT id, name FROM sys_envoy WHERE active ORDER BY name, id',
	params: []
};
/** The active envoys from what `activeEnvoysRead` answered. */
export const activeEnvoysOf = (rows: Rows) => decodeRows(Identity, rows);
export const activeEnvoys = (db: TenantDbShape) => db.rows(Identity, activeEnvoysRead);

/** An envoy answers only while its runtime row is active and has authority. */
export const envoySpec = Effect.fn('Envoys.spec')(function* (db: TenantDbShape, id: string) {
	if (!Schema.is(IdValue)(id)) return undefined;
	const found = yield* db.one(Configuration, {
		text: 'SELECT name, audience, task, policies, group_messages, delegation, triage, triage_scope, dm FROM sys_envoy WHERE id = $1::uuid AND active',
		params: [id]
	});
	if (Option.isNone(found)) return undefined;
	const {
		group_messages,
		triage,
		triage_scope,
		policies: [first, ...rest],
		...configuration
	} = found.value;
	if (first === undefined) return undefined;
	return {
		...configuration,
		group_messages: group_messages,
		policies: [first, ...rest],
		triage: triage ? { scope: triage_scope } : false
	} satisfies EnvoySpec;
});
