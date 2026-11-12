import { Effect, Layer } from 'effect';
import { TestWorkspace } from '../../../bolt-cli/src/test/index.ts';
import type { TenantDbShape } from '../../src/engine/db/tenant-db.ts';
import type { Row } from '../../src/engine/system/rows.ts';

/** Explicit native test rows, never a public seed pack; omitted status stays unpaired. */
export type RuntimeAccount = Pick<Row<'sys_integration'>, 'id' | 'integration'> &
	Partial<Pick<Row<'sys_integration'>, 'name' | 'owner' | 'envoy' | 'active' | 'configuration' | 'status'>>;

export const seed_accounts = Effect.fn('Test.seed_accounts')(function* (
	db: TenantDbShape,
	accounts: readonly RuntimeAccount[]
) {
	for (const account of accounts)
		yield* db.write({
			text: `INSERT INTO sys_integration (id,integration,name,owner,envoy,active,configuration,status)
				VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
			params: [account.id, account.integration, account.name ?? account.id, account.owner ?? null,
				account.envoy ?? null, account.active ?? true, account.configuration ?? {}, account.status ?? null]
		});
});

export const with_accounts = <A, E, R>(base: Layer.Layer<A, E, R>, accounts: readonly RuntimeAccount[]) =>
	Layer.effectDiscard(Effect.flatMap(TestWorkspace, ({ db }) => seed_accounts(db, accounts))).pipe(
		Layer.provideMerge(base)
	);
