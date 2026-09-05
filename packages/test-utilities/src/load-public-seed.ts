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

const insertRow = async (
	stage: string,
	row: Readonly<Record<string, unknown>>,
	query: PublicSeedQuery
): Promise<void> => {
	rowId(row, stage);
	const entries = insertableEntries(row);
	if (entries.length === 0) {
		throw new Error(`loadPublicSeed requires columns on each ${stage} row`);
	}
	const columns = entries.map(([name]) => quoteIdent(name)).join(', ');
	const placeholders = entries.map((_, index) => `$${index + 1}`).join(', ');
	// repository-health:allow SQL1 -- fixture seeder runs through the host query facility it is handed; pre-bootstrap seed rows have no collection client to route through, and every value stays a bound parameter.
	await query(`INSERT INTO ${quoteIdent(stage)} (${columns}) VALUES (${placeholders})`, [
		...entries.map(([, value]) => value)
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
	for (const stage of input.stages) {
		for (const row of records[stage] ?? []) {
			// repository-health:allow A6 -- rows insert in stage and row order so foreign keys resolve; the order is the loader's contract.
			await insertRow(stage, row, input.query);
		}
	}
}
