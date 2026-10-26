import { Effect, Schema } from 'effect';
import { StoreError } from '../errors.ts';
import { canonical } from '../hash.ts';

const Strings = Schema.Array(Schema.String);
const Path = Schema.Array(Schema.String);
/** An append-only JSON log's native contract. Hosts own storage and execution, never schema SQL. */
export const AppendOnlyLogSpec = Schema.Struct({
	format: Schema.Literal(1),
	namespace: Schema.String,
	/** Empty for one dedicated standalone database; scoped logs partition by the first column. */
	scope: Strings,
	/** A scoped log retires its partition and tenant together; the final scope column is the environment. */
	retirement: Schema.Boolean,
	retention: Schema.Struct({ days: Schema.Int, batch: Schema.Int }),
	envelope: Schema.Struct({
		id: Path,
		at: Path,
		payload: Path,
		required: Strings,
		nonempty: Schema.Array(Path),
		objects: Schema.Array(Path),
		enums: Schema.Array(Schema.Struct({ path: Path, values: Strings }))
	}),
	indexes: Schema.Array(Schema.Struct({ name: Schema.String, paths: Schema.Array(Path) })),
	pending: Schema.Struct({
		status: Path,
		operation: Path,
		prepared: Schema.String,
		unresolved: Strings,
		terminalSuffix: Schema.String
	})
});
export type AppendOnlyLogSpec = typeof AppendOnlyLogSpec.Type;

const name = /^[a-z][a-z0-9_]{0,62}$/;
const reserved = new Set([
	'id',
	'occurred_at',
	'recorded_at',
	'retired_at',
	'event',
	'events',
	'payload_bytes',
	'document',
	'pid',
	'xid',
	'cutoff'
]);
const invalid = (message: string) =>
	StoreError.of('schemaInvalid', 'decode', `append-only log: ${message}`);
export const logSpec = (input: AppendOnlyLogSpec) =>
	Effect.gen(function* () {
		const spec = yield* Schema.decodeUnknownEffect(AppendOnlyLogSpec, {
			onExcessProperty: 'error'
		})(input).pipe(Effect.mapError((cause) => invalid(cause.message)));
		if (
			!name.test(spec.namespace) ||
			spec.namespace === 'public' ||
			spec.namespace.startsWith('pg_')
		)
			return yield* invalid('namespace must be a dedicated PostgreSQL identifier');
		if (
			spec.scope.some((field) => !name.test(field) || field.length > 60 || reserved.has(field)) ||
			new Set(spec.scope).size !== spec.scope.length
		)
			return yield* invalid('scope columns must be distinct identifiers outside the log envelope');
		if (spec.retirement && spec.scope.length !== 3)
			return yield* invalid('retirement requires partition, tenant and environment scope columns');
		if (!spec.retirement && spec.scope.length !== 0)
			return yield* invalid('standalone logs have no scope columns');
		if (
			spec.retention.days < 1 ||
			spec.retention.days > 3650 ||
			spec.retention.batch < 1 ||
			spec.retention.batch > 1000
		)
			return yield* invalid('retention must be 1–3650 days in batches of 1–1000 rows');
		const paths = [
			spec.envelope.id,
			spec.envelope.at,
			spec.envelope.payload,
			...spec.envelope.nonempty,
			...spec.envelope.objects,
			...spec.envelope.enums.map((entry) => entry.path),
			...spec.indexes.flatMap((entry) => entry.paths),
			spec.pending.status,
			spec.pending.operation
		];
		if (
			paths.some((path) => path.length === 0 || path.length > 8 || path.some((part) => part === ''))
		)
			return yield* invalid('JSON paths need 1–8 nonempty members');
		if (
			spec.envelope.required.length === 0 ||
			spec.envelope.required.some((key) => key === '') ||
			new Set(spec.envelope.required).size !== spec.envelope.required.length ||
			spec.envelope.enums.some(
				(entry) => entry.values.length === 0 || new Set(entry.values).size !== entry.values.length
			)
		)
			return yield* invalid('required keys and enum values must be nonempty and distinct');
		if (
			spec.pending.prepared === '' ||
			spec.pending.terminalSuffix === '' ||
			spec.pending.unresolved.length === 0 ||
			!spec.pending.unresolved.includes(spec.pending.prepared)
		)
			return yield* invalid(
				'pending status, terminal suffix and unresolved statuses must describe a preparation'
			);
		const indexNames = new Set(['event_time', 'event_retention', 'event_pending', 'event_search']);
		for (const index of spec.indexes) {
			if (
				!name.test(index.name) ||
				indexNames.has(index.name) ||
				index.paths.length === 0 ||
				index.paths.length + spec.scope.length + 2 > 32
			)
				return yield* invalid('indexes need distinct identifiers and at least one JSON path');
			indexNames.add(index.name);
		}
		return spec;
	});

export const logSnapshot = (spec: AppendOnlyLogSpec): string =>
	`${JSON.stringify(JSON.parse(canonical(spec)), null, '\t')}\n`;
export const readLogSnapshot = (text: string) =>
	Schema.decodeUnknownEffect(Schema.fromJsonString(AppendOnlyLogSpec))(text).pipe(
		Effect.mapError((cause) =>
			StoreError.of('migrationInvalid', 'decode', `log snapshot: ${cause.message}`)
		),
		Effect.flatMap(logSpec)
	);

export const logLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
export const logName = (value: string): string => `"${value.replaceAll('"', '""')}"`;
export const logPath = (path: readonly string[], row = 'event', text = true): string =>
	path.reduce(
		(sql, part, i) => `${sql}${text && i === path.length - 1 ? '->>' : '->'}${logLiteral(part)}`,
		row
	);
