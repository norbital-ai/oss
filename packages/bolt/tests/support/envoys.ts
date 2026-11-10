import { Effect, Layer } from 'effect';
import { TestWorkspace } from '../../../bolt-cli/src/test/index.ts';
import type { TenantDbShape } from '../../src/engine/db/tenant-db.ts';
import type { Row } from '../../src/engine/system/rows.ts';

type Envoy = Pick<Row<'sys_envoy'>, 'id' | 'name' | 'policies'> &
	Partial<
		Pick<
			Row<'sys_envoy'>,
			'audience' | 'task' | 'group_messages' | 'delegation' | 'triage' | 'triage_scope' | 'dm'
		>
	> & {
		readonly connections?: readonly string[];
	};

export const seedEnvoys = Effect.fn('Test.seedEnvoys')(function* (
	db: TenantDbShape,
	envoys: readonly Envoy[]
) {
	for (const row of envoys) {
		yield* db.write({
			text: `INSERT INTO sys_envoy (id, name, policies, audience, task, group_messages, delegation, triage, triage_scope, dm)
				VALUES ($1::uuid, $2, ARRAY(SELECT jsonb_array_elements_text($3::jsonb)), $4, $5, $6, $7, $8, $9, $10)`,
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
				row.dm ?? 'union'
			]
		});
		for (const instance of row.connections ?? [])
			yield* db.write({
				text: 'UPDATE sys_integration SET envoy = $1 WHERE id = $2',
				params: [row.id, instance]
			});
	}
});

export const withEnvoys = <A, E, R>(base: Layer.Layer<A, E, R>, envoys: readonly Envoy[]) =>
	Layer.effectDiscard(Effect.flatMap(TestWorkspace, ({ db }) => seedEnvoys(db, envoys))).pipe(
		Layer.provideMerge(base)
	);
