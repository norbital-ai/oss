/** SQL Server integration programs. Declarations cross the guest boundary; only the host compiles TDS statements. */
import { Schema } from 'effect';

const Name = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const ParameterName = Name.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/));
const Scalar = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]);
type Scalar = typeof Scalar.Type;
const Arguments = Schema.Record(Schema.String, Scalar).check(
	Schema.makeFilter((values) => Object.keys(values).every(Schema.is(ParameterName)), {
		identifier: 'SqlServerArguments'
	})
);
const Table = Schema.Struct({ schema: Name, name: Name });
const Values = Schema.Record(Name, Scalar);
const common = {
	maxRows: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
	transaction: Schema.optionalKey(Schema.Literal('serializable'))
};
const Position = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{20}$/i));
export const SqlServerProjection = Schema.Struct({
	table: Table,
	key: Name,
	columns: Schema.Array(Name).check(Schema.isMinLength(1)),
	capture: Schema.optionalKey(Name),
	where: Schema.optionalKey(Values),
	deleted: Schema.optionalKey(Schema.Struct({ field: Name, value: Scalar })),
	decimals: Schema.optionalKey(Schema.Array(Name)),
	dates: Schema.optionalKey(Schema.Array(Name))
});
export type SqlServerProjection = typeof SqlServerProjection.Type;
const ColumnType = Schema.Union([
	Schema.Struct({
		kind: Schema.Literals(['varchar', 'nvarchar']),
		length: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4000 }))
	}),
	Schema.Struct({
		kind: Schema.Literal('decimal'),
		precision: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 38 })),
		scale: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 38 }))
	})
]);
const Generated = Schema.Struct({ generated: Schema.Literals(['uuid', 'now']) });
export const SqlServerRequest = Schema.Union([
	Schema.Struct({ op: Schema.Literal('values'), values: Values, ...common }),
	Schema.Struct({
		op: Schema.Literal('read'),
		table: Table,
		columns: Schema.Array(Name).check(Schema.isMinLength(1)),
		where: Schema.optionalKey(Values),
		...common
	}),
	Schema.Struct({
		op: Schema.Literal('call'),
		procedure: Table,
		arguments: Arguments,
		...common
	}),
	Schema.Struct({
		op: Schema.Literal('cdcCaptures'),
		captures: Schema.Array(Name).check(Schema.isMinLength(1)),
		...common
	}),
	Schema.Struct({ op: Schema.Literal('cdcIdentity'), ...common }),
	Schema.Struct({ op: Schema.Literal('cdcClock'), ...common }),
	Schema.Struct({ op: Schema.Literal('cdcAge'), baseline: Position, ...common }),
	Schema.Struct({
		op: Schema.Literal('cdcPage'),
		source: SqlServerProjection,
		after: Schema.String,
		changes: Schema.optionalKey(
			Schema.Struct({ from: Position, to: Position, seq: Position, operation: Schema.Int })
		),
		...common
	}),
	Schema.Struct({
		op: Schema.Literal('insertOnce'),
		table: Table,
		identity: Schema.Struct({ id: Name, key: Name, hash: Name }),
		key: Schema.String,
		hash: Schema.String,
		resource: Schema.NonEmptyString,
		values: Schema.Record(Name, Schema.Union([Scalar, Generated])),
		children: Schema.optionalKey(
			Schema.Array(
				Schema.Struct({
					table: Table,
					parent: Name,
					xml: Schema.String,
					path: Schema.NonEmptyString,
					columns: Schema.Record(Name, Schema.Struct({ attribute: Name, type: ColumnType }))
				})
			)
		),
		after: Schema.optionalKey(Table),
		...common
	})
]);
export type SqlServerRequest = typeof SqlServerRequest.Type;
export type SqlServerStatement = {
	readonly parameters: Readonly<Record<string, Scalar>>;
	readonly maxRows: number;
	readonly transaction?: 'serializable';
} & (
	| { readonly statement: string; readonly procedure?: never }
	| { readonly procedure: string; readonly statement?: never }
);
const q = (name: string) => `[${name.replaceAll(']', ']]')}]`;
const table = (source: typeof Table.Type) => `${q(source.schema)}.${q(source.name)}`;
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
/** A compiler, never an executor or an entry point for caller-authored SQL. Input has been decoded at the host boundary. */
export function compileSqlServer(request: SqlServerRequest): SqlServerStatement {
	const parameters: Record<string, Scalar> = {};
	let nextParameter = 0;
	const bind = (value: Scalar) => {
		const name = `p${nextParameter++}`;
		parameters[name] = value;
		return `@${name}`;
	};
	const filters = (values: Readonly<Record<string, Scalar>> = {}, prefix = '') => {
		const clauses = Object.entries(values).map(
			([name, value]) => `${prefix}${q(name)}${value === null ? ' IS NULL' : ` = ${bind(value)}`}`
		);
		return clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
	};
	const maxRows = request.op === 'insertOnce' ? 1 : (request.maxRows ?? 1000);
	let statement: string;
	switch (request.op) {
		case 'values':
			statement = `SELECT ${Object.entries(request.values)
				.map(([name, value]) => `${bind(value)} AS ${q(name)}`)
				.join(', ')}`;
			break;
		case 'read':
			statement = `SELECT TOP (${maxRows}) ${request.columns.map(q).join(', ')} FROM ${table(request.table)}${filters(request.where)}`;
			break;
		case 'call':
			return {
				procedure: table(request.procedure),
				parameters: request.arguments,
				maxRows,
				...(request.transaction === undefined ? {} : { transaction: request.transaction })
			};
		case 'cdcCaptures':
			statement = `SELECT ct.capture_instance,ct.object_id,CONVERT(varchar(33),obj.create_date,121) AS created,sys.fn_cdc_get_min_lsn(ct.capture_instance) AS minimum
FROM cdc.change_tables ct JOIN sys.objects obj ON obj.object_id=ct.object_id
WHERE ct.capture_instance IN (${request.captures.map(bind).join(', ')}) ORDER BY ct.capture_instance`;
			break;
		case 'cdcIdentity':
			statement =
				'SELECT database_guid,recovery_fork_guid FROM sys.database_recovery_status WHERE database_id=DB_ID()';
			break;
		case 'cdcClock':
			statement =
				'SELECT sys.fn_cdc_get_max_lsn() AS maximum,CAST(DATEDIFF(second,sys.fn_cdc_map_lsn_to_time(sys.fn_cdc_get_max_lsn()),GETDATE()) AS bigint)*1000 AS lag';
			break;
		case 'cdcAge':
			statement = `SELECT CAST(DATEDIFF(second,sys.fn_cdc_map_lsn_to_time(CONVERT(binary(10),${bind(request.baseline)},1)),GETDATE()) AS bigint)*1000 AS age`;
			break;
		case 'cdcPage': {
			const source = request.source,
				key = q(source.key),
				capture = source.capture ?? `${source.table.schema}_${source.table.name}`;
			const project = (delta: boolean) =>
				[
					'__key',
					...(delta ? ['__event_key', '__$start_lsn', '__$seqval', '__$operation'] : []),
					...source.columns.map((name) =>
						source.decimals?.includes(name)
							? `CONVERT(varchar(100),${q(name)}) AS ${q(name)}`
							: source.dates?.includes(name)
								? `CONVERT(varchar(10),${q(name)},23) AS ${q(name)}`
								: q(name)
					)
				].join(', ');
			const after = bind(request.after);
			if (request.changes === undefined) {
				const snapshot = `SELECT ${key} AS __key, ${source.columns.map(q).join(', ')} FROM ${table(source.table)}${filters(source.where)}`;
				statement = `SELECT TOP (${maxRows}) ${project(false)} FROM (${snapshot}) AS projection WHERE __key COLLATE Latin1_General_BIN2 > ${after} COLLATE Latin1_General_BIN2 ORDER BY __key COLLATE Latin1_General_BIN2`;
			} else {
				const current = (name: string) =>
					`CASE WHEN current_row.${key} IS NOT NULL THEN current_row.${q(name)} WHEN tombstone.${key} IS NOT NULL THEN tombstone.${q(name)} ELSE delta.${q(name)} END`;
				const deleted = `current_row.${key} IS NULL AND COALESCE(tombstone.__$operation,delta.__$operation)=1`;
				const changed = source.columns
					.map((name) =>
						source.deleted?.field === name
							? `CASE WHEN ${deleted} THEN ${bind(source.deleted.value)} ELSE ${current(name)} END AS ${q(name)}`
							: `${current(name)} AS ${q(name)}`
					)
					.join(', ');
				const operation = `CASE WHEN ${deleted} THEN ${source.deleted === undefined ? 1 : 4} WHEN delta.__$operation=1 THEN 4 ELSE delta.__$operation END AS __$operation`;
				const delta = `SELECT delta.${key} AS __key, delta.${key} AS __event_key, ${changed}, delta.__$start_lsn, delta.__$seqval, ${operation}
FROM cdc.${q(`fn_cdc_get_all_changes_${capture}`)}(@from_lsn,@to_lsn,'all') delta
LEFT JOIN ${table(source.table)} current_row ON current_row.${key}=delta.${key}
OUTER APPLY (SELECT TOP (1) * FROM cdc.${q(`${capture}_CT`)} retained WHERE current_row.${key} IS NULL AND retained.${key}=delta.${key}
ORDER BY retained.__$start_lsn DESC,retained.__$seqval DESC,retained.__$operation DESC) tombstone${filters(source.where, 'delta.')}`;
				statement = `DECLARE @from_lsn binary(10)=CONVERT(binary(10),${bind(request.changes.from)},1),@to_lsn binary(10)=CONVERT(binary(10),${bind(request.changes.to)},1),@after_seq binary(10)=CONVERT(binary(10),${bind(request.changes.seq)},1),@after_op int=${bind(request.changes.operation)};
SELECT TOP (${maxRows}) ${project(true)} FROM (${delta}) AS projection WHERE
__$start_lsn>@from_lsn OR (__$start_lsn=@from_lsn AND (__$seqval>@after_seq OR (__$seqval=@after_seq AND (__$operation>@after_op OR
(__$operation=@after_op AND __event_key COLLATE Latin1_General_BIN2>${after} COLLATE Latin1_General_BIN2)))))
ORDER BY __$start_lsn,__$seqval,__$operation,__event_key COLLATE Latin1_General_BIN2`;
			}
			break;
		}
		case 'insertOnce': {
			const target = table(request.table),
				id = q(request.identity.id),
				key = q(request.identity.key),
				hash = q(request.identity.hash);
			const keyValue = bind(request.key),
				fingerprint = bind(request.hash),
				resource = bind(request.resource);
			const fields = Object.entries(request.values);
			const value = (v: Scalar | typeof Generated.Type) =>
				typeof v === 'object' && v !== null
					? v.generated === 'now'
						? 'SYSUTCDATETIME()'
						: 'CONVERT(varchar(36),NEWID())'
					: bind(v);
			const children = (request.children ?? [])
				.map((child, index) => {
					const columns = Object.entries(child.columns);
					const cells = columns.map(([, field]) => {
						const type =
							field.type.kind === 'decimal'
								? `decimal(${field.type.precision},${field.type.scale})`
								: `${field.type.kind}(${field.type.length})`;
						return `item.value(${literal(`(@${field.attribute})[1]`)},${literal(type)})`;
					});
					return `DECLARE @child${index} xml=CONVERT(xml,${bind(child.xml)});
INSERT ${table(child.table)} (${[q(child.parent), ...columns.map(([name]) => q(name))].join(', ')})
SELECT @remote,${cells.join(', ')} FROM @child${index}.nodes(${literal(child.path)}) AS [rows](item);`;
				})
				.join('\n');
			statement = `DECLARE @lock_result int;
EXEC @lock_result=sys.sp_getapplock @Resource=${resource},@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=5000;
IF @lock_result NOT IN (0,1) THROW 51000,'Submission is busy',1;
IF (SELECT COUNT(*) FROM ${target} WHERE ${key}=${keyValue})>1 THROW 51000,'Ambiguous submission identity',1;
IF EXISTS(SELECT 1 FROM ${target} WHERE ${key}=${keyValue} AND ${hash}<>${fingerprint}) THROW 51000,'Submission payload changed',1;
IF NOT EXISTS(SELECT 1 FROM ${target} WHERE ${key}=${keyValue}) BEGIN
DECLARE @remote varchar(36)=CONVERT(varchar(36),NEWID());
INSERT ${target} (${[id, key, hash, ...fields.map(([name]) => q(name))].join(', ')}) VALUES (@remote,${keyValue},${fingerprint}${fields.map(([, v]) => `,${value(v)}`).join('')});
${children}
${request.after === undefined ? '' : `EXEC ${table(request.after)} @remote;`}
END;
IF NOT EXISTS(SELECT 1 FROM ${target} WHERE ${key}=${keyValue} AND ${hash}=${fingerprint}) THROW 51000,'Submission was not created',1;
SELECT ${id} AS remote,${hash} AS hash FROM ${target} WHERE ${key}=${keyValue};`;
			break;
		}
	}
	return {
		statement,
		parameters,
		maxRows,
		...(request.op === 'insertOnce' || request.transaction !== undefined
			? { transaction: 'serializable' as const }
			: {})
	};
}
