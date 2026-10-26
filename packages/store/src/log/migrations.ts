import { Effect } from 'effect';
import { StoreError } from '../errors.ts';
import { canonical } from '../hash.ts';
import {
	APPLIED,
	MIGRATION_GUARD_CODES,
	checkFile,
	lockOf,
	pending,
	physicalHash,
	readLock,
	type Applied,
	type MigrationFile
} from '../migrate.ts';
import { INTROSPECT } from '../migration-introspect.ts';
import type { Sql } from '../read/sql.ts';
import { logLiteral as lit, logSpec, readLogSnapshot, type AppendOnlyLogSpec } from './spec.ts';

const invalid = (message: string) =>
	StoreError.of('migrationChanged', 'admission', `append-only log: ${message}`);

/** Native definitions and effective privileges; owners normalize only when they are the executing deployment role. */
export function logIntrospect(spec: AppendOnlyLogSpec): string {
	const namespace = lit(spec.namespace);
	const definitions = INTROSPECT.replaceAll('current_schema()', namespace);
	const role = (value: string) =>
		`CASE WHEN ${value}=(SELECT oid FROM pg_roles WHERE rolname=current_user) THEN 'OWNER' WHEN ${value}=0 THEN 'PUBLIC' ELSE pg_get_userbyid(${value}) END`;
	const grant = (owner: string, acl: string) =>
		`${role(owner)} || ' to ' || ${role(`${acl}.grantee`)} || ' by ' || ${role(`${acl}.grantor`)} || ' ' || ${acl}.privilege_type || ' grant ' || ${acl}.is_grantable::text`;
	return `WITH native AS (${definitions})
SELECT line FROM native
UNION ALL SELECT 'namespace ' || n.nspname || ' owner ' || ${role('n.nspowner')} FROM pg_namespace n WHERE n.nspname=${namespace}
UNION ALL SELECT 'namespace acl ' || n.nspname || ' ' || ${grant('n.nspowner', 'a')}
 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname=${namespace}
UNION ALL SELECT 'table acl ' || c.relname || ' ' || ${grant('c.relowner', 'a')}
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
 WHERE n.nspname=${namespace} AND c.relkind IN ('r','p','v','m','f')
UNION ALL SELECT 'column acl ' || c.relname || '.' || col.attname || ' ' || ${grant('c.relowner', 'a')}
 FROM pg_attribute col JOIN pg_class c ON c.oid=col.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 CROSS JOIN LATERAL aclexplode(col.attacl) a WHERE n.nspname=${namespace} AND col.attnum>0 AND NOT col.attisdropped
UNION ALL SELECT 'routine acl ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || ${grant('p.proowner', 'a')}
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname=${namespace}
UNION ALL SELECT 'policy ' || c.relname || '.' || p.polname || ' ' || p.polcmd::text || ' ' || p.polpermissive::text
 || ' roles ' || (SELECT string_agg(${role('r')},',' ORDER BY ${role('r')}) FROM unnest(p.polroles) r)
 || ' using ' || coalesce(pg_get_expr(p.polqual,p.polrelid),'') || ' check ' || coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')
 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${namespace}
UNION ALL SELECT 'type ' || t.typname || ' ' || t.typtype::text || ' owner ' || ${role('t.typowner')}
 || ' definition ' || coalesce((SELECT string_agg(e.enumlabel,',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid),'')
 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=${namespace} AND t.typrelid=0 AND t.typelem=0
UNION ALL SELECT 'extension placement ' || e.extname || ' ' || n.nspname || ' ' || e.extversion
 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_trgm'
ORDER BY 1`;
}

export const logCurrent = (snapshot: string, declaration: AppendOnlyLogSpec) =>
	Effect.gen(function* () {
		const actual = yield* readLogSnapshot(snapshot),
			expected = yield* logSpec(declaration);
		if (canonical(actual) !== canonical(expected))
			return yield* invalid('source declaration differs from the committed snapshot');
	});

/** A host independently replays files and compiles the declaration, then supplies their native catalogues here. */
export const verifyLog = (
	files: readonly MigrationFile[],
	snapshot: string,
	declaration: AppendOnlyLogSpec,
	replayed: readonly string[],
	declared: readonly string[],
	physical: Readonly<Record<string, readonly string[]>>
) =>
	Effect.gen(function* () {
		yield* logCurrent(snapshot, declaration);
		yield* Effect.forEach(files, checkFile);
		const names = ['', ...files.map((file) => file.name)].sort();
		if (JSON.stringify(Object.keys(physical).sort()) !== JSON.stringify(names))
			return yield* invalid('physical proof must cover every migration prefix exactly');
		const last = files.at(-1)?.name ?? '';
		if (
			physicalHash(replayed) !== physicalHash(declared) ||
			physicalHash(physical[last] ?? []) !== physicalHash(replayed)
		)
			return yield* invalid(
				'edited migrations do not reach the declared native log schema and privileges'
			);
		const lock = lockOf(snapshot, files, {
			physical: Object.fromEntries(
				Object.entries(physical).map(([name, lines]) => [name, physicalHash(lines)])
			)
		});
		// Validate numbering, checksums and file structure through the same immutable-history machinery as tables.
		yield* pending(files, yield* readLock(lock), [], snapshot);
		return lock;
	});

/** Physical and ledger observations are rechecked within the exact same bounded migration transaction. */
export function logMigrationGuard(
	spec: AppendOnlyLogSpec,
	applied: readonly Applied[],
	definitions: readonly string[],
	stage: 'before' | 'after'
): Sql {
	const ledgerCode =
		stage === 'before' ? MIGRATION_GUARD_CODES.beforeLedger : MIGRATION_GUARD_CODES.afterLedger;
	const physicalCode =
		stage === 'before' ? MIGRATION_GUARD_CODES.beforePhysical : MIGRATION_GUARD_CODES.afterPhysical;
	const body = `DECLARE moved boolean; BEGIN
WITH actual AS (${APPLIED}), expected AS (SELECT x->>'name' AS name,x->>'checksum' AS checksum FROM jsonb_array_elements(${lit(JSON.stringify(applied))}::jsonb) x)
SELECT EXISTS ((SELECT * FROM actual EXCEPT SELECT * FROM expected) UNION ALL (SELECT * FROM expected EXCEPT SELECT * FROM actual)) INTO moved;
IF moved THEN RAISE EXCEPTION USING ERRCODE='${ledgerCode}', MESSAGE='the log migration ledger moved'; END IF;
WITH actual AS (${logIntrospect(spec)}), expected AS (SELECT jsonb_array_elements_text(${lit(JSON.stringify(definitions))}::jsonb) AS line)
SELECT EXISTS ((SELECT line FROM actual EXCEPT SELECT line FROM expected) UNION ALL (SELECT line FROM expected EXCEPT SELECT line FROM actual)) INTO moved;
IF moved THEN RAISE EXCEPTION USING ERRCODE='${physicalCode}', MESSAGE='the native log schema or privileges moved'; END IF;
END`;
	return { text: `DO ${lit(body)}`, params: [] };
}
