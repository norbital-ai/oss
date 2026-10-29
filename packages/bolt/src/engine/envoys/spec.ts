import { Effect, Predicate } from 'effect';
import type { EnvoySpec } from '../../decl/runtime/agent.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import type { EngineManifest } from '../manifest.ts';

/** A tenant-created envoy's spec, or `undefined` when the row is absent or paused. */
export const runtimeEnvoy = Effect.fn('Envoys.runtimeSpec')(function* (
	db: TenantDbShape,
	id: string
) {
	const [res] = yield* db.read([
		{
			text: `SELECT name, audience, task, policies, group_messages, delegation, triage, dm
				FROM sys_envoy WHERE id = $1 AND active`,
			params: [id]
		}
	]);
	const row = res?.rows[0];
	if (row === undefined) return undefined;
	const [policy, ...morePolicies] = Array.isArray(row['policies'])
		? row['policies'].filter(Predicate.isString)
		: [];
	if (policy === undefined) return undefined;
	const policies = [policy, ...morePolicies] as const;
	const group = row['group_messages'];
	const delegation = row['delegation'];
	const dm = row['dm'];
	return {
		name: String(row['name'] ?? ''),
		audience: row['audience'] === 'public' ? 'public' : 'private',
		policies,
		task: String(row['task'] ?? ''),
		groupMessages:
			group === 'disabled' || group === 'all' || group === 'mention_or_reply'
				? group
				: 'mention_or_reply',
		delegation: delegation === 'enabled' ? 'enabled' : 'disabled',
		triage: row['triage'] === true ? {} : false,
		dm: dm === 'envoy' ? 'envoy' : 'union'
	} satisfies EnvoySpec;
});

/** An envoy's spec as admission, triage and turns read it: the release's source default, else its tenant `sys_envoy` row. */
export const envoySpec = (m: Pick<EngineManifest, 'envoys'>, db: TenantDbShape, id: string) =>
	Object.hasOwn(m.envoys, id)
		? Effect.succeed<EnvoySpec | undefined>(m.envoys[id])
		: runtimeEnvoy(db, id);
