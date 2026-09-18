import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { Option, Schema } from 'effect';

const ROW_RECORD = Schema.Record(Schema.String, Schema.Unknown);
const isString = Schema.is(Schema.String);

const BANK_SEGMENT = 'seed_bank';
const BANK_ROOT_ENV = 'NORBITAL_SEED_BANK_ROOT';

export type PublicSeedRows = Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;

export type PublicSeedQuery = (
	statement: string,
	parameters?: readonly unknown[]
) => Promise<unknown>;

export type PublicSeedPutObject = (key: string, bytes: Uint8Array) => Promise<void>;

export type LoadPublicSeedInput = {
	readonly stages: readonly string[];
	readonly rows: PublicSeedRows | string;
	readonly query: PublicSeedQuery;
	readonly putObject?: PublicSeedPutObject;
};

type RowsSource =
	| { readonly kind: 'directory'; readonly directory: string }
	| { readonly kind: 'records'; readonly records: PublicSeedRows };

export class PublicSeedBankPathError extends Error {
	readonly name = 'PublicSeedBankPathError';
	readonly sourcePath: string;
	constructor(sourcePath: string) {
		super(`loadPublicSeed refuses a bank path: ${sourcePath}`);
		this.sourcePath = sourcePath;
	}
}

const pathSegments = (input: string): readonly string[] =>
	input
		.replaceAll('\\', '/')
		.split('/')
		.filter((segment) => segment.length > 0);

const hasBankSegment = (input: string): boolean => pathSegments(input).includes(BANK_SEGMENT);

const looksLikeFilesystemPath = (input: string): boolean =>
	isAbsolute(input) || input.includes('/') || input.includes('\\') || input.startsWith('.');

const underConfiguredBankRoot = (input: string): boolean => {
	const configured = process.env[BANK_ROOT_ENV]?.trim() ?? '';
	if (configured === '') return false;
	const root = resolve(configured);
	const candidate = resolve(input);
	return candidate === root || candidate.startsWith(`${root}/`);
};

const refuseIfBank = (input: string): void => {
	if (hasBankSegment(input) || (looksLikeFilesystemPath(input) && underConfiguredBankRoot(input))) {
		throw new PublicSeedBankPathError(input);
	}
};

const rowsSource = (rows: PublicSeedRows | string): RowsSource => {
	if (isString(rows)) return { kind: 'directory', directory: rows };
	return { kind: 'records', records: rows };
};

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const rowId = (row: Readonly<Record<string, unknown>>, stage: string): unknown => {
	const id = row.id;
	if (id === undefined || id === null || id === '') {
		throw new Error(`loadPublicSeed requires id on each ${stage} row`);
	}
	return id;
};

const insertableEntries = (
	row: Readonly<Record<string, unknown>>
): ReadonlyArray<readonly [string, unknown]> =>
	Object.entries(row).filter(([, value]) => value !== undefined && !(value instanceof Uint8Array));

/**
 * The vector columns of a table, read once per stage. A JSON array is bound as a Postgres array
 * (`{…}`) by every driver, which a `vector` column refuses; those columns take the array as
 * pgvector's own text (`[…]`) instead, so a seed row states a reading as numbers.
 */
const vectorColumns = async (
	stage: string,
	query: PublicSeedQuery
): Promise<ReadonlySet<string>> => {
	const answer = await query(
		'SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND udt_name = $2',
		[stage, 'vector']
	);
	const rows = Array.isArray(answer)
		? answer
		: answer !== null &&
			  typeof answer === 'object' &&
			  Array.isArray((answer as { rows?: unknown }).rows)
			? (answer as { rows: unknown[] }).rows
			: [];
	return new Set(
		rows.flatMap((row) =>
			row !== null &&
			typeof row === 'object' &&
			typeof (row as { column_name?: unknown }).column_name === 'string'
				? [(row as { column_name: string }).column_name]
				: []
		)
	);
};

const insertRow = async (
	stage: string,
	row: Readonly<Record<string, unknown>>,
	query: PublicSeedQuery,
	vectors: Map<string, Promise<ReadonlySet<string>>>
): Promise<void> => {
	rowId(row, stage);
	const entries = insertableEntries(row);
	if (entries.length === 0) {
		throw new Error(`loadPublicSeed requires columns on each ${stage} row`);
	}
	// Read once per stage and only when a row carries an array, after that row passed — a refused
	// row never reaches the database, and a stage without arrays asks nothing extra.
	const vectorNames = entries.some(([, value]) => Array.isArray(value))
		? await (vectors.get(stage) ?? vectors.set(stage, vectorColumns(stage, query)).get(stage)!)
		: new Set<string>();
	const columns = entries.map(([name]) => quoteIdent(name)).join(', ');
	const placeholders = entries.map((_, index) => `$${index + 1}`).join(', ');
	// repository-health:allow SQL1 -- fixture seeder runs through the host query facility it is handed; pre-bootstrap seed rows have no collection client to route through, and every value stays a bound parameter.
	await query(`INSERT INTO ${quoteIdent(stage)} (${columns}) VALUES (${placeholders})`, [
		...entries.map(([name, value]) =>
			vectorNames.has(name) && Array.isArray(value) ? JSON.stringify(value) : value
		)
	]);
};

const readDirectoryRows = async (
	directory: string,
	stages: readonly string[]
): Promise<PublicSeedRows> => {
	const records: Record<string, readonly Readonly<Record<string, unknown>>[]> = {};
	await Promise.all(
		stages.map(async (stage) => {
			const filePath = join(directory, `${stage}.json`);
			refuseIfBank(filePath);
			const text = await readFile(filePath, 'utf8').catch((error: unknown) => {
				if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '[]';
				throw error;
			});
			const parsed: unknown = JSON.parse(text);
			if (!Array.isArray(parsed)) {
				throw new Error(`loadPublicSeed expected an array in ${filePath}`);
			}
			records[stage] = parsed.map((row, index) => {
				const record = Schema.decodeUnknownOption(ROW_RECORD)(row);
				if (Option.isNone(record)) {
					throw new Error(`loadPublicSeed expected an object at ${filePath}[${index}]`);
				}
				return record.value;
			});
		})
	);
	return records;
};

const resolveRecords = async (
	source: RowsSource,
	stages: readonly string[]
): Promise<PublicSeedRows> => {
	switch (source.kind) {
		case 'directory':
			return readDirectoryRows(source.directory, stages);
		case 'records':
			return source.records;
		default: {
			const _exhaustive: never = source;
			throw new Error(`unhandled rows source: ${JSON.stringify(_exhaustive)}`);
		}
	}
};

/**
 * Loads public fixture rows in stage order. Refuses any `seed_bank/` path or the configured bank
 * root. The environment variable is never a default location. Each row must already have `id`.
 */
export async function loadPublicSeed(input: LoadPublicSeedInput): Promise<void> {
	const source = rowsSource(input.rows);
	switch (source.kind) {
		case 'directory':
			refuseIfBank(source.directory);
			break;
		case 'records':
			break;
		default: {
			const _exhaustive: never = source;
			throw new Error(`unhandled rows source: ${JSON.stringify(_exhaustive)}`);
		}
	}
	for (const stage of input.stages) {
		refuseIfBank(stage);
	}
	const records = await resolveRecords(source, input.stages);
	const vectors = new Map<string, Promise<ReadonlySet<string>>>();
	for (const stage of input.stages) {
		for (const row of records[stage] ?? []) {
			// repository-health:allow A6 -- rows insert in stage and row order so foreign keys resolve; the order is the loader's contract.
			await insertRow(stage, row, input.query, vectors);
		}
	}
}
