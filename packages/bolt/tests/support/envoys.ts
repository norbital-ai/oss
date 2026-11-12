import { Effect, Layer, Schema } from 'effect';
import { TestWorkspace } from '../../../bolt-cli/src/test/index.ts';
import type { TenantDbShape } from '../../src/engine/db/tenant-db.ts';
import type { Row } from '../../src/engine/system/rows.ts';

type Envoy = Pick<Row<'sys_envoy'>, 'id' | 'name' | 'policies'> &
	Partial<
		Pick<
			Row<'sys_envoy'>,
			'audience' | 'task' | 'group_messages' | 'delegation' | 'triage' | 'triage_scope' | 'dm' | 'active'
		>
	> & {
		readonly accounts?: readonly string[];
	};

export const seed_envoys = Effect.fn('Test.seed_envoys')(function* (
	db: TenantDbShape,
	envoys: readonly Envoy[]
) {
	for (const row of envoys) {
		yield* db.write({
			text: `INSERT INTO sys_envoy (id, name, policies, audience, task, group_messages, delegation, triage, triage_scope, dm, active)
				VALUES ($1::uuid, $2, ARRAY(SELECT jsonb_array_elements_text($3::jsonb)), $4, $5, $6, $7, $8, $9, $10, $11)`,
			params: [
				row.id,
				row.name,
				row.policies,
				row.audience ?? 'private',
				row.task ?? '',
				row.group_messages ?? 'mention_or_reply',
				row.delegation ?? 'disabled',
				row.triage ?? false,
				row.triage_scope ?? 'all',
				row.dm ?? 'union',
				row.active ?? true
			]
		});
		for (const instance of row.accounts ?? []) {
			const linked = yield* db.returning(Schema.Struct({ id: Schema.String }), {
				text: 'UPDATE sys_integration SET envoy = $1 WHERE id = $2 RETURNING id::text AS id',
				params: [row.id, instance]
			});
			if (linked.length !== 1) return yield* Effect.die(new Error(`The fixture envoy account ${instance} does not exist.`));
		}
	}
});

export const with_envoys = <A, E, R>(base: Layer.Layer<A, E, R>, envoys: readonly Envoy[]) =>
	Layer.effectDiscard(Effect.flatMap(TestWorkspace, ({ db }) => seed_envoys(db, envoys))).pipe(
		Layer.provideMerge(base)
	);
