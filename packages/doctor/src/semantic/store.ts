/**
 * Durable storage for the semantic index, and the incremental refresh that keeps it warm.
 *
 * Three artifacts under one directory: a manifest (identity + Merkle root), an entries ledger
 * (path → content hash and where its vector lives), and one little-endian float32 blob. The split
 * exists so a refresh can rewrite vectors without rewriting every offset — offsets are assigned
 * once at write time and the ledger is the only place they are named.
 *
 * Corruption is never quietly reinterpreted as absence. A missing directory means "no index yet"
 * and yields `undefined`; a present but broken one throws, because treating a truncated vector
 * file as "nothing indexed" would trigger a full re-embed and silently bill for it, which is the
 * worst possible response to corruption. Writes go tmp-then-rename with the manifest renamed
 * last: until it lands, readers see the previous committed state, so a crash mid-refresh costs a
 * stale index, never a half-written one.
 *
 * Incrementality is decided by the caller-supplied content hashes diffed through the Merkle tree;
 * only added and changed files cross the network. An embedder id or dimension change invalidates
 * everything at once — two vector spaces do not share offsets no matter how similar their ids
 * look.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Embedder, IndexRunStats } from './embedder.js';
import { readJsonObject } from '../manifest.js';
import { hashesToTree } from './merkle.js';

const INDEX_SCHEMA = 1;

type IndexEntry = Readonly<{
	readonly path: string;
	readonly hash: string;
	/** Start of this file's vector inside `vectors.bin`, in float32 elements. */
	readonly offset: number;
	/** Vector length in float32 elements; equals the embedder's dimensions or the entry is junk. */
	readonly length: number;
}>;

type IndexSnapshot = Readonly<{
	readonly embedderId: string;
	readonly dimensions: number;
	readonly merkleRoot: string;
	readonly entries: ReadonlyMap<string, IndexEntry>;
	/** Raw little-endian float32 bytes backing every entry's offset window. */
	readonly data: Buffer;
}>;

type RefreshIndexOptions = Readonly<{
	readonly directory: string;
	readonly embedder: Embedder;
	/** Current files by path, with the content hash that drives the diff and the text to embed. */
	readonly files: ReadonlyMap<string, Readonly<{ hash: string; text: string }>>;
}>;

type RefreshIndexResult = Readonly<{
	readonly vectors: ReadonlyMap<string, Float32Array>;
	readonly stats: IndexRunStats;
	readonly root: string;
}>;

/**
 * Spend counters an embedder may optionally expose. Declared structurally here rather than
 * imported from a provider module on purpose: the store must not know which provider it serves,
 * only that "if it can report usage, report it".
 */
type UsageSnapshot = Readonly<{
	apiRequests: number;
	promptTokens: number | undefined;
	costUsd: number | undefined;
}>;

type UsageReporter = Readonly<{
	usage?: (() => UsageSnapshot) | undefined;
}>;

const usageOf = (embedder: Embedder): UsageSnapshot | undefined =>
	(embedder as UsageReporter).usage?.();

const atomicWrite = (target: string, contents: string | Buffer): void => {
	mkdirSync(dirname(target), { recursive: true });
	const temporary = `${target}.${process.pid}.tmp`;
	writeFileSync(temporary, contents);
	renameSync(temporary, target);
};

const requireInt = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;

const decodeVector = (data: Buffer, offset: number, length: number): Float32Array => {
	const vector = new Float32Array(length);
	for (let index = 0; index < length; index += 1)
		vector[index] = data.readFloatLE((offset + index) * 4);
	return vector;
};

/**
 * Read the committed index, or `undefined` when there is none. Absence is defined by the
 * manifest: it is renamed last, so its existence is the commit marker. Everything past that
 * point is validated hard — schema, identity fields, per-entry arithmetic, and agreement between
 * the three artifacts.
 */
export function readIndex(directory: string): IndexSnapshot | undefined {
	const manifestPath = join(directory, 'manifest.json');
	if (!existsSync(manifestPath)) return undefined;
	const manifest = readJsonObject(readFileSync(manifestPath, 'utf8'));
	if (manifest === undefined)
		throw new Error(`norbital-doctor: index manifest at ${manifestPath} is not valid JSON`);
	if (manifest.indexSchema !== INDEX_SCHEMA)
		throw new Error(
			`norbital-doctor: index at ${directory} has unsupported indexSchema ${String(manifest.indexSchema)}, expected ${INDEX_SCHEMA}`
		);
	if (typeof manifest.embedderId !== 'string')
		throw new Error(`norbital-doctor: index manifest at ${manifestPath} has no embedderId`);
	if (
		typeof manifest.dimensions !== 'number' ||
		!Number.isInteger(manifest.dimensions) ||
		manifest.dimensions <= 0 ||
		!Number.isFinite(manifest.dimensions)
	)
		throw new Error(
			`norbital-doctor: index manifest at ${manifestPath} has non-finite or invalid dimensions`
		);
	if (typeof manifest.merkleRoot !== 'string')
		throw new Error(`norbital-doctor: index manifest at ${manifestPath} has no merkleRoot`);
	if (!Array.isArray(manifest.files))
		throw new Error(`norbital-doctor: index manifest at ${manifestPath} has no files list`);

	const entriesPath = join(directory, 'entries.jsonl');
	const vectorsPath = join(directory, 'vectors.bin');
	if (!existsSync(entriesPath))
		throw new Error(`norbital-doctor: index at ${directory} is missing entries.jsonl`);
	if (!existsSync(vectorsPath))
		throw new Error(`norbital-doctor: index at ${directory} is missing vectors.bin`);

	const entries = new Map<string, IndexEntry>();
	const rawEntries = readFileSync(entriesPath, 'utf8');
	for (const [lineNumber, line] of rawEntries.split('\n').entries()) {
		if (line.trim() === '') continue;
		const record = readJsonObject(line);
		if (record === undefined)
			throw new Error(`norbital-doctor: entries.jsonl line ${lineNumber + 1} is not a valid entry record`);
		const path = record.path;
		const hash = record.hash;
		const offset = requireInt(record.offset);
		const length = requireInt(record.length);
		if (typeof path !== 'string' || typeof hash !== 'string' || offset === undefined || length === undefined)
			throw new Error(`norbital-doctor: entries.jsonl line ${lineNumber + 1} is not a valid entry record`);
		if (entries.has(path))
			throw new Error(`norbital-doctor: entries.jsonl lists ${path} more than once`);
		if (length !== manifest.dimensions)
			throw new Error(
				`norbital-doctor: entry for ${path} holds ${length} float32s, manifest dimensions are ${manifest.dimensions}`
			);
		entries.set(path, { path, hash, offset, length });
	}

	const data = readFileSync(vectorsPath);
	if (data.byteLength % 4 !== 0)
		throw new Error(`norbital-doctor: vectors.bin at ${vectorsPath} is not whole float32s`);
	const floats = data.byteLength / 4;
	for (const entry of entries.values())
		if (entry.offset + entry.length > floats)
			throw new Error(
				`norbital-doctor: entries reference ${entry.offset + entry.length} float32s but vectors.bin at ${vectorsPath} holds ${floats}`
			);

	const listed = [...manifest.files].filter((file): file is string => typeof file === 'string').sort();
	const stored = [...entries.keys()].sort();
	if (
		listed.length !== stored.length ||
		listed.some((file, index) => file !== stored[index])
	)
		throw new Error(
			`norbital-doctor: manifest files list at ${manifestPath} disagrees with entries.jsonl`
		);

	return Object.freeze({
		embedderId: manifest.embedderId,
		dimensions: manifest.dimensions,
		merkleRoot: manifest.merkleRoot,
		entries,
		data
	});
}

/** Encode one vector as little-endian float32 bytes, regardless of host endianness. */
const encodeVector = (vector: Float32Array): Buffer => {
	const out = Buffer.alloc(vector.length * 4);
	let cursor = 0;
	for (const value of vector) {
		out.writeFloatLE(value, cursor);
		cursor += 4;
	}
	return out;
};

const deltaUsage = (
	before: UsageSnapshot | undefined,
	after: UsageSnapshot | undefined
): Pick<IndexRunStats, 'apiRequests' | 'promptTokens' | 'costUsd'> => ({
	apiRequests: (after?.apiRequests ?? 0) - (before?.apiRequests ?? 0),
	promptTokens:
		after?.promptTokens === undefined ? undefined : after.promptTokens - (before?.promptTokens ?? 0),
	costUsd: after?.costUsd === undefined ? undefined : after.costUsd - (before?.costUsd ?? 0)
});

/**
 * Bring the index on disk in line with `files`, embedding only what the Merkle diff says changed,
 * and return every current vector alongside honest run statistics.
 */
export async function refreshIndex(options: RefreshIndexOptions): Promise<RefreshIndexResult> {
	const { directory, embedder, files } = options;
	const started = performance.now();
	const beforeUsage = usageOf(embedder);

	const previous = readIndex(directory);
	// A different embedder id or width is a different vector space; reuse across that line would
	// compare numbers that mean different things, so everything re-embeds.
	const reusable =
		previous !== undefined &&
		previous.embedderId === embedder.id &&
		previous.dimensions === embedder.dimensions
			? previous
			: undefined;

	const leaves = new Map<string, string>();
	for (const [path, file] of files) leaves.set(path, file.hash);
	const tree = hashesToTree(leaves);

	const pending: Array<string> = [];
	let unchanged = 0;
	for (const [path, hash] of [...leaves].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const prior = reusable?.entries.get(path);
		if (prior !== undefined && prior.hash === hash) unchanged += 1;
		else pending.push(path);
	}
	let deleted = 0;
	if (reusable !== undefined)
		for (const path of reusable.entries.keys()) if (!files.has(path)) deleted += 1;

	const embedded = pending.map((path) => {
		const file = files.get(path);
		if (file === undefined)
			throw new Error(`norbital-doctor: refresh lost track of ${path} before embedding`);
		return file.text;
	});
	const freshVectors =
		pending.length > 0 ? await embedder.embed(embedded, 'document') : [];
	freshVectors.forEach((vector, index) => {
		if (vector.length !== embedder.dimensions)
			throw new Error(
				`norbital-doctor: embedder returned ${vector.length} dimensions for ${pending[index]}, expected ${embedder.dimensions}`
			);
	});

	const paths = [...files.keys()].sort();
	const chunks: Array<Buffer> = [];
	const entries: Array<IndexEntry> = [];
	const vectors = new Map<string, Float32Array>();
	let cursor = 0;
	for (const path of paths) {
		const pendingIndex = pending.indexOf(path);
		if (pendingIndex !== -1) {
			const vector = freshVectors[pendingIndex];
			if (vector === undefined)
				throw new Error(`norbital-doctor: embedder returned fewer vectors than texts for ${path}`);
			chunks.push(encodeVector(vector));
			vectors.set(path, vector);
		} else {
			const committed = reusable;
			const prior = committed?.entries.get(path);
			if (committed === undefined || prior === undefined)
				throw new Error(`norbital-doctor: no stored vector to reuse for ${path}`);
			chunks.push(committed.data.subarray(prior.offset * 4, (prior.offset + prior.length) * 4));
			vectors.set(path, decodeVector(committed.data, prior.offset, prior.length));
		}
		const length = vectors.get(path)?.length ?? embedder.dimensions;
		entries.push({ path, hash: leaves.get(path) ?? '', offset: cursor, length });
		cursor += length;
	}

	atomicWrite(join(directory, 'vectors.bin'), Buffer.concat(chunks));
	atomicWrite(
		join(directory, 'entries.jsonl'),
		`${entries.map((entry) => JSON.stringify(entry)).join('\n')}${entries.length === 0 ? '' : '\n'}`
	);
	// The manifest renames last: its presence is what makes the new state visible to readers.
	atomicWrite(
		join(directory, 'manifest.json'),
		`${JSON.stringify(
			{
				indexSchema: INDEX_SCHEMA,
				embedderId: embedder.id,
				dimensions: embedder.dimensions,
				merkleRoot: tree.root,
				files: paths
			},
			null,
			2
		)}\n`
	);

	const afterUsage = usageOf(embedder);
	const spend = deltaUsage(beforeUsage, afterUsage);
	return {
		vectors,
		stats: {
			filesTotal: files.size,
			filesEmbedded: pending.length,
			filesUnchanged: unchanged,
			filesDeleted: deleted,
			apiRequests: spend.apiRequests,
			promptTokens: spend.promptTokens,
			costUsd: spend.costUsd,
			durationMs: performance.now() - started
		},
		root: tree.root
	};
}
