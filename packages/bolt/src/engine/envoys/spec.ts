import { Effect, Option, Schema } from 'effect';
import { IdValue } from '@norbital-ai/std/kind';
import type { NonEmpty } from '../../decl/values.ts';
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
	readonly groupMessages: typeof Configuration.Type.group_messages;
	readonly triage: false | { readonly scope: typeof Configuration.Type.triage_scope };
};

export const activeEnvoys = (db: TenantDbShape) =>
	db.rows(Identity, {
		text: 'SELECT id, name FROM sys_envoy WHERE active ORDER BY name, id',
		params: []
	});

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
		groupMessages: group_messages,
		policies: [first, ...rest],
		triage: triage ? { scope: triage_scope } : false
	} satisfies EnvoySpec;
});
