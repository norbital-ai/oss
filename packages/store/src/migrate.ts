// Migrations as files a person or an agent can read and edit: `NNNN_<name>.sql`, the schema they arrive at
// (`snapshot.json`) and the checksum of each file as last verified (`migrations.lock.json`). All pure: the host reads the
// files and what its database applied, and executes what comes back — one transaction per file.
//
// A file is SQL with step markers. `-- step <id> (<class>)` opens each step; a hazard comment says what it risks; a
// destructive step runs only under an explicit `-- accept: <id>` line; a validating step is a `DO` block that refuses,
// naming the constraint and the row count, before the constraint is added. A changed inline-value shape becomes a data
// step (the place to transform rows) and a check that counts the rows the new shape cannot decode.
//
// Verify makes an edited file safe: replay every file on a scratch database, build the schema itself on another, and
// compare what the two hold (`introspect`); and the snapshot must be the schema the code declares.
import { Effect, Schema } from 'effect';
import { StoreError } from './errors.ts';
import { canonical, sha256Hex } from './hash.ts';
import { plan, statements, type Plan } from './schema/plan.ts';
import { SchemaSpec } from './schema/spec.ts';
import { INTROSPECT } from './migration-introspect.ts';
import type { Sql } from './read/sql.ts';

type Fx<A> = Effect.Effect<A, StoreError>;
const refuse = (code: 'migrationInvalid' | 'migrationChanged' | 'schemaMoved', message: string) =>
	Effect.fail(StoreError.of(code, 'admission', message));

/** A migration file: its name (`0007_lease_until.sql`) and text. */
export type MigrationFile = { readonly name: string; readonly sql: string };
/** What a database applied: each file's name and the checksum it ran with. */
export type Applied = { readonly name: string; readonly checksum: string };
export const AppliedRow = /*#__PURE__*/ Schema.Struct({
	name: Schema.String,
	checksum: Schema.String
});
/** A verified alternative for one exact, immutable prefix. Originals remain available for databases partway through it. */
export const SquashReceipt = /*#__PURE__*/ (() =>
	Schema.Struct({
		file: Schema.String,
		checksum: Schema.String,
		archive: Schema.String,
		replaces: Schema.Array(AppliedRow),
		proof: Schema.String
	}))();
export type SquashReceipt = typeof SquashReceipt.Type;
/** `migrations.lock.json`: each file's checksum as last generated or verified, and the snapshot's. */
export const MigrationLock = /*#__PURE__*/ (() =>
	Schema.Struct({
		snapshot: Schema.String,
		files: Schema.Record(Schema.String, Schema.String),
		squashes: Schema.optionalKey(Schema.Array(SquashReceipt)),
		physical: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
	}))();
export type MigrationLock = typeof MigrationLock.Type;

/** The table a database records its applied files in, and each record. */
export const MIGRATIONS_TABLE = `create table if not exists store_migration (name text primary key, checksum text not null, applied_at timestamptz not null default now())`;
export const recordApplied = (file: MigrationFile) => ({
	text: 'insert into store_migration (name, checksum) values ($1, $2)',
	params: [file.name, checksumOf(file)]
});
export const APPLIED = 'select name, checksum from store_migration order by name';

/** SQLSTATEs let a host retry moved observations while refusing a failed migration endstate. */
export const MIGRATION_GUARD_CODES = {
	beforeLedger: 'BM001',
	beforePhysical: 'BM002',
	afterPhysical: 'BM003',
	afterLedger: 'BM004'
} as const;

/** Exact ledger and native definition sets, checked inside the host's atomic migration batch. */
export function migrationGuard(
	applied: readonly Applied[],
	definitions: readonly string[],
	stage: 'before' | 'after',
	excluded: readonly (readonly [string, string])[] = []
): Sql {
	const lit = (text: string) => `'${text.replaceAll("'", "''")}'`;
	const history = [...applied].sort((a, b) => a.name.localeCompare(b.name));
	const ledgerCode =
		stage === 'before' ? MIGRATION_GUARD_CODES.beforeLedger : MIGRATION_GUARD_CODES.afterLedger;
	const physicalCode =
		stage === 'before' ? MIGRATION_GUARD_CODES.beforePhysical : MIGRATION_GUARD_CODES.afterPhysical;
	const body = `declare held jsonb; moved boolean; begin
		select coalesce(jsonb_agg(jsonb_build_object('name', name, 'checksum', checksum) order by name), '[]'::jsonb) into held from store_migration;
		if held is distinct from ${lit(JSON.stringify(history))}::jsonb then
			raise exception using errcode = '${ledgerCode}', message = 'the migration ledger moved';
		end if;
		with inspected as (${INTROSPECT}), actual as (
			select line from inspected i where not exists (
				select 1 from jsonb_array_elements(${lit(JSON.stringify(excluded))}::jsonb) x
				where x->>0 = i.kind and x->>1 = i.owner
			)
		), expected as (select jsonb_array_elements_text(${lit(JSON.stringify(definitions))}::jsonb) as line)
		select exists ((select line from actual except select line from expected) union all (select line from expected except select line from actual)) into moved;
		if moved then raise exception using errcode = '${physicalCode}', message = 'the physical migration prefix moved'; end if;
	end`;
	return { text: `do ${lit(body)}`, params: [] };
}

export const checksumOf = (file: MigrationFile): string => sha256Hex(file.sql);
const NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const number = (name: string): number => Number(NAME.exec(name)?.[1] ?? Number.NaN);
const decodeSnapshot = /*#__PURE__*/ (() =>
	Schema.decodeUnknownEffect(Schema.fromJsonString(SchemaSpec)))();
const decodeLock = /*#__PURE__*/ (() =>
	Schema.decodeUnknownEffect(Schema.fromJsonString(MigrationLock)))();
/** A schema as its snapshot file holds it: canonical JSON. */
export const snapshotOf = (s: SchemaSpec): string =>
	`${JSON.stringify(JSON.parse(canonical(s)), null, '\t')}\n`;
/** A snapshot file's schema, decoded (an edited snapshot that is no schema is refused). */
export const readSnapshot = (text: string): Fx<SchemaSpec> =>
	decodeSnapshot(text).pipe(
		Effect.mapError((e) =>
			StoreError.of('migrationInvalid', 'decode', `snapshot.json is no schema: ${e.message}`)
		)
	);
export const readLock = (text: string): Fx<MigrationLock> =>
	decodeLock(text).pipe(
		Effect.mapError((e) =>
			StoreError.of('migrationInvalid', 'decode', `migrations.lock.json: ${e.message}`)
		)
	);
export type MigrationProofs = Pick<MigrationLock, 'squashes' | 'physical'>;
export const lockOf = (
	snapshot: string,
	files: readonly MigrationFile[],
	proofs: MigrationProofs = {}
): string =>
	`${JSON.stringify(
		{
			snapshot: sha256Hex(snapshot),
			files: Object.fromEntries(files.map((f) => [f.name, checksumOf(f)])),
			...proofs
		},
		null,
		'\t'
	)}\n`;

type Block = { readonly id: string; readonly klass: string; readonly accepted: boolean };
/** A file's steps as its markers say, each with whether it carries its accept line. */
function blocksOf(file: MigrationFile): Block[] {
	const out: Block[] = [];
	let current: { id: string; klass: string; accepted: boolean } | undefined;
	for (const line of file.sql.split('\n')) {
		const step = /^-- step (\S+) \((\w+)\)\s*$/.exec(line);
		if (step !== null) {
			if (current !== undefined) out.push(current);
			current = { id: step[1] ?? '', klass: step[2] ?? '', accepted: false };
			continue;
		}
		const accept = /^-- accept: (\S+)\s*$/.exec(line);
		if (accept !== null && current !== undefined && accept[1] === current.id)
			current.accepted = true;
	}
	if (current !== undefined) out.push(current);
	return out;
}
type SqlToken = {
	readonly kind: 'word' | 'literal' | 'body' | 'quoted' | 'symbol';
	readonly text: string;
};
// Comments and quoted text cannot turn a description or a string value into a SQL command. Keep dollar bodies
// separate: a function definition stores one; a DO statement executes one.
function sqlTokens(sql: string): SqlToken[] {
	const tokens: SqlToken[] = [];
	let i = 0;
	while (i < sql.length) {
		const rest = sql.slice(i);
		if (/^\s/.test(rest)) {
			i++;
			continue;
		}
		if (rest.startsWith('--')) {
			const end = sql.indexOf('\n', i + 2);
			i = end < 0 ? sql.length : end + 1;
			continue;
		}
		if (rest.startsWith('/*')) {
			i += 2;
			let depth = 1;
			while (i < sql.length && depth > 0) {
				if (sql.startsWith('/*', i)) {
					depth++;
					i += 2;
				} else if (sql.startsWith('*/', i)) {
					depth--;
					i += 2;
				} else i++;
			}
			continue;
		}
		const delimiter = /^\$(?:[a-z_][a-z0-9_]*)?\$/i.exec(rest)?.[0];
		if (delimiter !== undefined) {
			const end = sql.indexOf(delimiter, i + delimiter.length);
			tokens.push({
				kind: 'body',
				text: sql.slice(i + delimiter.length, end < 0 ? sql.length : end)
			});
			i = end < 0 ? sql.length : end + delimiter.length;
			continue;
		}
		const quote = sql[i];
		if (quote === "'" || quote === '"') {
			const start = ++i;
			while (i < sql.length) {
				if (sql[i] === quote) {
					if (sql[i + 1] === quote) {
						i += 2;
						continue;
					}
					break;
				}
				// PostgreSQL E'...' strings admit escaped quotes.
				if (sql[i] === '\\' && quote === "'" && /(?:^|[^a-z0-9_])e$/i.test(sql.slice(0, start - 1)))
					i++;
				i++;
			}
			tokens.push({ kind: quote === "'" ? 'literal' : 'quoted', text: sql.slice(start, i) });
			i++;
			continue;
		}
		const word = /^[a-z_][a-z0-9_$]*/i.exec(rest)?.[0];
		if (word !== undefined) {
			tokens.push({ kind: 'word', text: word.toLowerCase() });
			i += word.length;
		} else {
			tokens.push({ kind: 'symbol', text: sql[i] ?? '' });
			i++;
		}
	}
	return tokens;
}
function sqlStatements(sql: string): SqlToken[][] {
	const statements: SqlToken[][] = [[]];
	for (const token of sqlTokens(sql)) {
		if (token.kind === 'symbol' && token.text === ';') statements.push([]);
		else statements.at(-1)?.push(token);
	}
	return statements.filter((statement) => statement.length > 0);
}
const HOST_BOUNDS = [
	'lock_timeout',
	'statement_timeout',
	'idle_in_transaction_session_timeout',
	'transaction_timeout'
];
function changesHostBounds(tokens: readonly SqlToken[]): boolean {
	for (const [index, token] of tokens.entries()) {
		if (token.kind !== 'word' && token.kind !== 'quoted') continue;
		const name = token.text.toLowerCase();
		if (token.kind === 'word' && (name === 'set' || name === 'reset')) {
			const next = tokens[index + 1]?.text.toLowerCase();
			const setting =
				next === 'local' || next === 'session' ? tokens[index + 2]?.text.toLowerCase() : next;
			if (HOST_BOUNDS.includes(setting ?? '') || (name === 'reset' && setting === 'all'))
				return true;
		}
		if (
			name === 'set_config' &&
			tokens[index + 1]?.text === '(' &&
			tokens[index + 2]?.kind === 'literal' &&
			HOST_BOUNDS.includes(tokens[index + 2]?.text.toLowerCase() ?? '')
		)
			return true;
		if (
			name === 'execute' &&
			tokens[index + 1]?.kind === 'literal' &&
			changesHostBounds(sqlTokens(tokens[index + 1]?.text.replaceAll("''", "'") ?? ''))
		)
			return true;
	}
	// Stored function bodies are inert here; DO bodies execute as part of this file.
	return (
		tokens[0]?.text === 'do' &&
		tokens.some(
			(token) =>
				(token.kind === 'body' || token.kind === 'literal') &&
				changesHostBounds(
					sqlTokens(token.kind === 'literal' ? token.text.replaceAll("''", "'") : token.text)
				)
		)
	);
}
/** A file a database may run: named in order, and every destructive step accepted. */
export const checkFile = /*#__PURE__*/ (() =>
	Effect.fn('Store.checkFile')(function* (file: MigrationFile) {
		if (!NAME.test(file.name) || number(file.name) < 1)
			return yield* refuse(
				'migrationInvalid',
				`'${file.name}' is not NNNN_<name>.sql starting at 0001`
			);
		const blocks = blocksOf(file);
		for (const block of blocks)
			if (
				!['additive', 'rename', 'backfill', 'validating', 'destructive', 'data'].includes(
					block.klass
				)
			)
				return yield* refuse(
					'migrationInvalid',
					`${file.name}: unknown step class '${block.klass}'`
				);
		const refused = blocks.filter((b) => b.klass === 'destructive' && !b.accepted);
		if (refused.length > 0)
			return yield* refuse(
				'migrationInvalid',
				`${file.name}: destructive steps need an accept line: ${refused.map((b) => `-- accept: ${b.id}`).join(', ')}`
			);
		for (const statement of sqlStatements(file.sql)) {
			const words = statement.filter((token) => token.kind === 'word').map((token) => token.text);
			if (
				['begin', 'commit', 'end', 'rollback', 'abort', 'savepoint', 'release'].includes(
					words[0] ?? ''
				) ||
				((words[0] === 'start' || words[0] === 'prepare') && words[1] === 'transaction')
			)
				return yield* refuse(
					'migrationInvalid',
					`${file.name}: transaction control cannot run inside an atomic migration`
				);
			if (changesHostBounds(statement))
				return yield* refuse(
					'migrationInvalid',
					`${file.name}: lock_timeout, statement_timeout, idle_in_transaction_session_timeout and transaction_timeout belong to the host's bounded migration transaction`
				);
			if (
				words.includes('concurrently') &&
				(words[0] === 'reindex' ||
					((words[0] === 'create' || words[0] === 'drop') && words.includes('index')))
			)
				return yield* refuse(
					'migrationInvalid',
					`${file.name}: CONCURRENTLY cannot run in an atomic migration; use an ordinary index statement`
				);
		}
		return file;
	}))();

const orderedFiles = /*#__PURE__*/ (() =>
	Effect.fn('Store.orderedMigrations')(function* (files: readonly MigrationFile[]) {
		const ordered = [...files].sort((a, b) => number(a.name) - number(b.name));
		for (const [i, file] of ordered.entries()) {
			yield* checkFile(file);
			if (number(file.name) !== i + 1)
				return yield* refuse(
					'migrationInvalid',
					`migrations are numbered from 0001 without gaps; ${file.name} is not ${i + 1}`
				);
		}
		return ordered;
	}))();

const appliedOf = (files: readonly MigrationFile[]): Applied[] =>
	files.map((file) => ({ name: file.name, checksum: checksumOf(file) }));
/** Identifies the exact original prefix, including its order, filenames and immutable SQL checksums. */
export const archiveOf = (files: readonly MigrationFile[]): string =>
	sha256Hex(canonical(appliedOf(files)));
/** A physical proof ignores introspection row order, but includes every distinct schema definition. */
export const physicalHash = (lines: readonly string[]): string =>
	sha256Hex(canonical([...new Set(lines)].sort()));

export type PhysicalDefinitions = Readonly<Record<string, readonly string[]>>;
const PhysicalDefinitions = /*#__PURE__*/ (() =>
	Schema.Record(Schema.String, Schema.Array(Schema.String)))();
const IndexedDefinitions = /*#__PURE__*/ (() =>
	Schema.Struct({
		format: Schema.Literal(1),
		lines: Schema.Array(Schema.String),
		prefixes: Schema.Record(Schema.String, Schema.Array(Schema.Int))
	}))();
const decodeDefinitions = /*#__PURE__*/ (() =>
	Schema.decodeUnknownEffect(
		Schema.fromJsonString(Schema.Union([IndexedDefinitions, PhysicalDefinitions]))
	))();
const indexedDefinitions = (
	file: typeof IndexedDefinitions.Type | typeof PhysicalDefinitions.Type
): file is typeof IndexedDefinitions.Type => file['format'] === 1;

/** Every exact native definition is stored once, even when many historical prefixes share it. */
export function physicalDefinitionsOf(definitions: PhysicalDefinitions): string {
	const lines: string[] = [];
	const indexes = new Map<string, number>();
	const prefixes = Object.fromEntries(
		Object.entries(definitions)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, values]) => [
				name,
				values.map((line) => {
					let index = indexes.get(line);
					if (index === undefined) {
						index = lines.length;
						lines.push(line);
						indexes.set(line, index);
					}
					return index;
				})
			])
	);
	return `${JSON.stringify({ format: 1, lines, prefixes }, null, '\t')}\n`;
}

/** Decode committed proofs, including existing unindexed histories; hashes still cover the expanded definitions. */
export const readPhysicalDefinitions = (text: string): Fx<PhysicalDefinitions> =>
	Effect.gen(function* () {
		const file = yield* decodeDefinitions(text).pipe(
			Effect.mapError((cause) => StoreError.of('migrationChanged', 'decode', cause.message))
		);
		if (!indexedDefinitions(file)) return file;
		const definitions: Record<string, string[]> = {};
		for (const [name, indexes] of Object.entries(file.prefixes)) {
			const lines: string[] = [];
			for (const index of indexes) {
				const line = file.lines[index];
				if (line === undefined)
					return yield* refuse('migrationChanged', `${name}: physical definition ${index} is missing`);
				lines.push(line);
			}
			definitions[name] = lines;
		}
		return definitions;
	});

export const comparePhysical = (lines: readonly string[], expected: string): Fx<void> =>
	physicalHash(lines) === expected
		? Effect.void
		: refuse('migrationChanged', 'the live schema differs from its verified migration prefix');

/** A baseline may omit DDL history, never row transformations or arbitrary executed SQL. */
export const checkSquashSources = /*#__PURE__*/ (() =>
	Effect.fn('Store.checkSquashSources')(function* (files: readonly MigrationFile[]) {
		const ordered = yield* orderedFiles(files);
		if (ordered.length === 0)
			return yield* refuse('migrationInvalid', 'a squash needs a nonempty original prefix');
		for (const file of ordered) {
			if (blocksOf(file).some((block) => block.klass === 'data'))
				return yield* refuse(
					'migrationInvalid',
					`${file.name}: a data step cannot be replaced by a schema baseline`
				);
			for (const statement of sqlStatements(file.sql)) {
				const words = statement.filter((token) => token.kind === 'word').map((token) => token.text);
				const head = words[0];
				if (head === 'create' && words[1] === 'extension') {
					if (
						statement.some((token) => token.kind !== 'word') ||
						words.length !== 6 ||
						words.slice(0, 5).join(' ') !== 'create extension if not exists' ||
						!['vector', 'btree_gist'].includes(words[5] ?? '')
					)
						return yield* refuse(
							'migrationInvalid',
							`${file.name}: only generated vector/btree_gist extension creation can be replaced by a schema baseline`
						);
					continue;
				}
				if (head === 'do') {
					const body = statement.find((token) => token.kind === 'body')?.text.trim();
					// Only the generated, read-only row-count validation block is understood. Other DO bodies can hide DML.
					const validation =
						body === undefined
							? null
							: /^declare n bigint; begin\s+execute '((?:[^']|'')*)' into n;\s+if n > 0 then raise exception '(?:[^']|'')*', n; end if;\s+end$/.exec(
									body
								);
					const query = validation?.[1]?.replaceAll("''", "'");
					const queryTokens = query === undefined ? [] : sqlTokens(query);
					const queryWords = queryTokens
						.filter((token) => token.kind === 'word')
						.map((token) => token.text);
					if (
						query === undefined ||
						!/^select\s+(?:count\(\*\)|coalesce\(sum\((?:d\.)?n - 1\), 0\))/i.test(query) ||
						queryWords.some((word) =>
							['insert', 'update', 'delete', 'merge', 'copy', 'truncate', 'call'].includes(word)
						) ||
						queryTokens.some((token) => token.kind === 'symbol' && token.text === ';')
					)
						return yield* refuse(
							'migrationInvalid',
							`${file.name}: an executed DO body cannot be replaced by a schema baseline`
						);
					continue;
				}
				const storedDefinition =
					head === 'create' &&
					(words.includes('function') || words.includes('procedure') || words.includes('trigger'));
				const allowed =
					head === 'alter' ||
					head === 'drop' ||
					head === 'comment' ||
					(head === 'create' &&
						[
							'table',
							'index',
							'unique',
							'function',
							'procedure',
							'or',
							'trigger',
							'sequence',
							'type',
							'extension'
						].includes(words[1] ?? ''));
				const data = words.some(
					(word, i) =>
						['insert', 'merge', 'copy', 'truncate', 'call'].includes(word) ||
						((word === 'update' || word === 'delete') &&
							words[i - 1] !== 'on' &&
							words[i - 1] !== 'before' &&
							words[i - 1] !== 'after') ||
						(word === 'as' &&
							['select', 'with', 'values', 'table', 'execute'].includes(words[i + 1] ?? '')) ||
						word === 'sequence' ||
						word === 'restart' ||
						(words.includes('identity') &&
							['start', 'increment', 'minvalue', 'maxvalue', 'cache', 'cycle'].includes(word))
				);
				if (!allowed || (!storedDefinition && data))
					return yield* refuse(
						'migrationInvalid',
						`${file.name}: data-affecting or unclassified SQL cannot be replaced by a schema baseline`
					);
			}
		}
		return ordered;
	}))();

/** Bind an edited baseline only after the host replayed the exact archive and baseline on separate empty databases. */
export const verifySquash = /*#__PURE__*/ (() =>
	Effect.fn('Store.verifySquash')(function* (
		originals: readonly MigrationFile[],
		file: MigrationFile,
		archived: readonly string[],
		baseline: readonly string[]
	) {
		const ordered = yield* checkSquashSources(originals);
		yield* checkFile(file);
		yield* checkSquashBaseline(file);
		if (
			number(file.name) !== ordered.length ||
			ordered.some((original) => original.name === file.name)
		)
			return yield* refuse(
				'migrationInvalid',
				'a squash needs a distinct filename numbered at the end of its original prefix'
			);
		if (physicalHash(archived) !== physicalHash(baseline))
			return yield* refuse(
				'migrationInvalid',
				'the squash baseline does not reproduce the archived schema'
			);
		return {
			file: file.name,
			checksum: checksumOf(file),
			archive: archiveOf(ordered),
			replaces: appliedOf(ordered),
			proof: physicalHash(baseline)
		};
	}))();

// Baselines are numbered at their cutoff, so their single-file check does not require numbering from 0001.
const checkSquashBaseline = (file: MigrationFile) =>
	checkSquashSources([{ ...file, name: '0001_baseline.sql' }]);

const migrationHistory = /*#__PURE__*/ (() =>
	Effect.fn('Store.migrationHistory')(function* (
		files: readonly MigrationFile[],
		lock: MigrationLock,
		applied: readonly Applied[],
		snapshot: string | undefined,
		squashes: readonly MigrationFile[]
	) {
		const ordered = yield* orderedFiles(files);
		if (snapshot !== undefined && sha256Hex(snapshot) !== lock.snapshot)
			return yield* refuse(
				'migrationChanged',
				'snapshot.json changed since the migrations were verified'
			);
		for (const f of ordered) {
			if (lock.files[f.name] !== checksumOf(f))
				return yield* refuse(
					'migrationChanged',
					`${f.name} changed since it was last verified; verify the migrations before applying them`
				);
		}
		const known = new Map(ordered.map((f) => [f.name, f]));
		for (const name of Object.keys(lock.files))
			if (!known.has(name))
				return yield* refuse('migrationChanged', `the verified migration ${name} is gone`);
		const baselines = new Map<string, { file: MigrationFile; receipt: SquashReceipt }>();
		const loaded = new Map<string, MigrationFile>();
		for (const file of squashes) {
			if (loaded.has(file.name))
				return yield* refuse('migrationInvalid', `duplicate squash file ${file.name}`);
			loaded.set(file.name, file);
		}
		for (const receipt of lock.squashes ?? []) {
			if (baselines.has(receipt.file) || known.has(receipt.file))
				return yield* refuse('migrationInvalid', `duplicate migration identity ${receipt.file}`);
			const file = loaded.get(receipt.file);
			if (file === undefined)
				return yield* refuse('migrationChanged', `the verified squash ${receipt.file} is gone`);
			yield* checkFile(file);
			yield* checkSquashBaseline(file);
			const prefix = ordered.slice(0, receipt.replaces.length);
			if (
				receipt.replaces.length === 0 ||
				number(receipt.file) !== receipt.replaces.length ||
				canonical(receipt.replaces) !== canonical(appliedOf(prefix)) ||
				receipt.archive !== archiveOf(prefix)
			)
				return yield* refuse(
					'migrationInvalid',
					`${receipt.file} does not replace an exact original prefix`
				);
			yield* checkSquashSources(prefix);
			if (receipt.checksum !== checksumOf(file))
				return yield* refuse(
					'migrationChanged',
					`${receipt.file} changed since its baseline was verified`
				);
			if (
				!/^[a-f0-9]{64}$/.test(receipt.proof) ||
				(lock.physical?.[receipt.file] !== undefined &&
					lock.physical[receipt.file] !== receipt.proof)
			)
				return yield* refuse(
					'migrationInvalid',
					`${receipt.file} has no consistent physical replay proof`
				);
			baselines.set(receipt.file, { file, receipt });
		}
		for (const file of squashes)
			if (!baselines.has(file.name))
				return yield* refuse('migrationChanged', `${file.name} has no verified squash receipt`);
		const history = [...applied].sort((a, b) => number(a.name) - number(b.name));
		const used = history.filter((a) => baselines.has(a.name));
		if (used.length > 1)
			return yield* refuse('migrationInvalid', 'a database cannot apply multiple squash baselines');
		const baseline = used[0] === undefined ? undefined : baselines.get(used[0].name);
		const cutoff = baseline?.receipt.replaces.length ?? 0;
		const originals = history.filter((a) => !baselines.has(a.name));
		for (const a of history) {
			const f = known.get(a.name) ?? baselines.get(a.name)?.file;
			if (f === undefined)
				return yield* refuse('migrationChanged', `the database applied ${a.name}, which is gone`);
			if (checksumOf(f) !== a.checksum)
				return yield* refuse(
					'migrationChanged',
					`${a.name} was applied with other text; an applied file never changes`
				);
		}
		for (const [i, a] of originals.entries()) {
			if (ordered[cutoff + i]?.name !== a.name)
				return yield* refuse(
					'migrationInvalid',
					`the database migration history is not a prefix of the committed files at ${a.name}`
				);
		}
		const covered = cutoff + originals.length;
		if (history.length === 0) {
			const longest = [...baselines.values()].sort(
				(a, b) =>
					b.receipt.replaces.length - a.receipt.replaces.length ||
					a.file.name.localeCompare(b.file.name)
			)[0];
			if (longest !== undefined)
				return {
					ordered,
					covered,
					strategy: 'squash',
					pending: [longest.file, ...ordered.slice(longest.receipt.replaces.length)]
				};
		}
		return {
			ordered,
			covered,
			strategy: baseline === undefined ? 'original' : 'squash',
			pending: ordered.slice(covered)
		};
	}))();

/**
 * SQL still to execute. Originals are the full immutable chain, reconstructed by the host from archives and the
 * current directory. Only an empty ledger selects a baseline; a partially applied prefix always finishes originals.
 */
export const pending = /*#__PURE__*/ (() =>
	Effect.fn('Store.pending')(function* (
		files: readonly MigrationFile[],
		lock: MigrationLock,
		applied: readonly Applied[],
		snapshot?: string,
		squashes: readonly MigrationFile[] = []
	) {
		return (yield* migrationHistory(files, lock, applied, snapshot, squashes)).pending;
	}))();

/** Read-only source, ledger and physical planning state. A physical drift is reported, never adopted or repaired. */
export const migrationStatus = /*#__PURE__*/ (() =>
	Effect.fn('Store.migrationStatus')(function* (
		files: readonly MigrationFile[],
		lock: MigrationLock,
		applied: readonly Applied[],
		options: {
			readonly snapshot?: string;
			readonly squashes?: readonly MigrationFile[];
			readonly physical?: readonly string[];
		} = {}
	) {
		const history = yield* migrationHistory(
			files,
			lock,
			applied,
			options.snapshot,
			options.squashes ?? []
		);
		const last = [...applied].sort((a, b) => number(a.name) - number(b.name)).at(-1)?.name ?? '';
		const expectedPhysical =
			lock.physical?.[last] ??
			(last === ''
				? physicalHash([])
				: lock.squashes?.find((receipt) => receipt.file === last)?.proof);
		const actualPhysical =
			options.physical === undefined ? undefined : physicalHash(options.physical);
		const physical =
			actualPhysical === undefined
				? 'unchecked'
				: expectedPhysical === undefined
					? 'unverified'
					: actualPhysical !== expectedPhysical
						? 'drift'
						: history.covered === history.ordered.length
							? 'current'
							: 'prefix';
		return {
			source: 'verified',
			ledger:
				applied.length === 0
					? 'empty'
					: history.covered === history.ordered.length
						? 'current'
						: 'prefix',
			strategy: history.strategy,
			covered: history.covered,
			applied: [...applied],
			pending: history.pending,
			physical,
			...(expectedPhysical === undefined ? {} : { expectedPhysical }),
			...(actualPhysical === undefined ? {} : { actualPhysical })
		};
	}))();

/** Whether the snapshot is the schema the code declares: else a migration is missing. */
export const current = (snapshot: SchemaSpec, schema: SchemaSpec): Fx<void> =>
	canonical(snapshot) === canonical(schema)
		? Effect.void
		: refuse('schemaMoved', 'the schema changed since the last migration; generate the next one');

// ── verify ──
/** What a database holds of a schema: its tables' columns, constraints and indexes, as comparable lines. */
export { INTROSPECT } from './migration-introspect.ts';
export const IntrospectRow = /*#__PURE__*/ (() =>
	Schema.Struct({
		line: Schema.String,
		kind: Schema.optionalKey(Schema.String),
		owner: Schema.optionalKey(Schema.String)
	}))();
/**
 * Verify: the lines a replay of every file left (`replayed`), against the lines the schema built directly left
 * (`declared`). Any difference is an error naming it; the lock to write when they agree.
 */
export const verify = /*#__PURE__*/ (() =>
	Effect.fn('Store.verify')(function* (
		files: readonly MigrationFile[],
		snapshot: string,
		schema: SchemaSpec,
		replayed: readonly string[],
		declared: readonly string[],
		proofs: MigrationProofs = {}
	) {
		yield* current(yield* readSnapshot(snapshot), schema);
		const ordered = yield* orderedFiles(files);
		const [a, b] = [new Set(replayed), new Set(declared)];
		const missing = declared.filter((l) => !a.has(l));
		const extra = replayed.filter((l) => !b.has(l));
		if (missing.length > 0 || extra.length > 0)
			return yield* refuse(
				'migrationInvalid',
				[
					'the migrations do not arrive at the schema:',
					...missing.map((l) => `  missing ${l}`),
					...extra.map((l) => `  extra   ${l}`)
				].join('\n')
			);
		const head = ordered.at(-1)?.name ?? '';
		if (proofs.physical?.[head] !== undefined && proofs.physical[head] !== physicalHash(replayed))
			return yield* refuse(
				'migrationInvalid',
				'the final prefix proof differs from the verified replay'
			);
		return lockOf(snapshot, ordered, proofs);
	}))();
/** The statements that build `schema` from nothing: what `verify`'s second scratch database runs. */
export const build = (schema: SchemaSpec): Effect.Effect<readonly string[], StoreError> =>
	Effect.map(plan(null, schema), (p: Plan) => statements(p).map((s) => s.sql));
