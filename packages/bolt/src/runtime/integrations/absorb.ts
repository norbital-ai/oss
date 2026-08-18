import { Effect, Result, Schema } from 'effect';
import type { EffectId } from '@norbital-ai/bolt-protocol';
import type { AuthoredIntegrationBinding } from '../../authoring/integration-introspection.js';
import { deriveRecordId } from '../derive-record-id.js';

/**
 * Turning a batch of raw records into rows, which is the half a pull and a webhook genuinely share.
 *
 * It was the inner block of `runPullBinding`, lifted out when the push binding arrived rather than
 * copied. Every rule that makes a mirror safe to run twice lives in here — decode per record, read
 * the identity through the authored reader, look up what already exists, stamp the identity column
 * from the identity rather than from the mapped row — and a second copy of those rules is one copy
 * that gets fixed. The difference between the two callers is only where the records came from: a
 * page the platform fetched, or a body a source pushed.
 */

/** The three physical operations absorbing a batch needs; a superset of them is `PullDependencies`. */
export type AbsorbDependencies = Readonly<{
	/**
	 * Existing rows for these external keys, as `key -> every norbital_id carrying it`.
	 *
	 * A list rather than a single id because one source record may fan out into several rows, and they
	 * all carry the same identity value. Collapsing them to one made a re-run invisible to every row
	 * but the first, which then arrived as a `create` for an id that already existed.
	 */
	readonly existing: (
		effectId: EffectId,
		collection: string,
		column: string,
		keys: ReadonlyArray<string>
	) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>, { readonly message: string }>;
	/**
	 * Removes rows a re-run no longer produces.
	 *
	 * Fan-out is a set, not an append: if a record expanded into five rows yesterday and three today,
	 * the two that are gone must go. Without this they survive as rows nothing upstream corresponds to
	 * any more — invisible, because every check only ever looks at what the source *does* send.
	 */
	readonly remove: (
		effectId: EffectId,
		collection: string,
		ids: ReadonlyArray<string>
	) => Effect.Effect<void, { readonly message: string }>;
	/** Writes one row. `create` for a key the collection has not seen, `update` for one it has. */
	readonly write: (
		effectId: EffectId,
		collection: string,
		id: string,
		values: Readonly<Record<string, Schema.Json>>,
		mode: 'create' | 'update'
	) => Effect.Effect<void, { readonly message: string }>;
	/** The collection's authored `import` pipeline, when it declares one and the binding has no `map`. */
	readonly pipeline: (
		effectId: EffectId,
		collection: string,
		record: unknown
	) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, { readonly message: string }> | undefined;
	/**
	 * Runs the binding's authored `resolve` once for the batch, with an `api` bound to this invocation.
	 *
	 * The api is passed *in* to the closure rather than out to the caller, so this file still has no
	 * idea what a facility is: it hands over a function that wants an api and gets an answer back.
	 * That is the same arrangement `pipeline` above already has, and it is what keeps every branch of
	 * the loop testable without a database.
	 */
	readonly resolve: (
		effectId: EffectId,
		run: (api: unknown) => unknown
	) => Effect.Effect<unknown, { readonly message: string }>;
}>;

/** Which binding of which integration is absorbing, and into what. */
export type AbsorbTarget = Readonly<{
	readonly integration: string;
	readonly binding: string;
	readonly collection: string;
	readonly identityColumn: string;
}>;

export type Rejection = Readonly<{ readonly index: number; readonly reason: string }>;

export type AbsorbOutcome = Readonly<{
	readonly created: number;
	readonly updated: number;
	/** The records that decoded, in order — what a `maxOf` cursor takes its watermark from. */
	readonly decoded: ReadonlyArray<unknown>;
	readonly rejected: ReadonlyArray<Rejection>;
}>;

const describe = (cause: unknown): string =>
	cause instanceof Error && cause.message !== '' ? cause.message : String(cause);

/**
 * What one decoded record becomes, decided by the nearest declaration that says so.
 *
 * `map` on the binding is nearest: the module that knows the external shape is the module that
 * should state the translation. Failing that, the collection's own `import` pipeline — the door a
 * spreadsheet upload already comes through — is asked, one record at a time so a pipeline that
 * refuses one record costs that record. Failing both, a source whose records already match the
 * collection's columns is written straight through.
 *
 * `map` is still pure and synchronous — `(record, resolved) => Row`, no `api`, no Effect — because a
 * function called once per record must not be able to reach the database. What it now has is
 * `resolved`: whatever the binding's `resolve` looked up once for the whole batch, which is how a
 * record carrying a foreign *code* becomes a row carrying a `uuid` foreign key.
 *
 * `map` throwing is how a code that resolved to nothing refuses its own record: the `Effect.try`
 * here turns that into a rejection the caller records against this record's index, and the records
 * either side of it are written exactly as if it had not been in the batch.
 */
const rowsFor = (
	dependencies: AbsorbDependencies,
	effectId: EffectId,
	target: AbsorbTarget,
	authored: AuthoredIntegrationBinding,
	record: unknown,
	resolved: unknown
): Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, { readonly message: string }> => {
	const map = authored.map;
	if (map !== undefined) {
		return Effect.try({ try: () => [map(record, resolved)], catch: (cause) => ({ message: describe(cause) }) });
	}
	const pipeline = dependencies.pipeline(effectId, target.collection, record);
	if (pipeline !== undefined) return pipeline;
	return record !== null && typeof record === 'object' && !Array.isArray(record)
		? Effect.succeed([record as Readonly<Record<string, unknown>>])
		: Effect.fail({ message: `${target.integration}.${target.binding} produced a record that is not a row and declares no map` });
};

/**
 * Narrows a mapped row to the JSON a collection write accepts.
 *
 * A value that is not JSON — a `Date`, a `BigInt`, a class instance — is rendered rather than
 * dropped, because dropping it writes a row that silently disagrees with the source.
 */
const jsonValues = (row: Readonly<Record<string, unknown>>): Readonly<Record<string, Schema.Json>> =>
	Object.fromEntries(
		Object.entries(row).map(([key, value]) => [
			key,
			Schema.is(Schema.Json)(value)
				? value
				: value instanceof Date
					? value.toISOString()
					: value === undefined
						? null
						: String(value)
		])
	);

/**
 * Absorbs one batch of raw records into the collection, keeping the good ones and reporting the rest.
 *
 * `indexOffset` is where this batch starts in the run's overall numbering, so a rejection on page
 * nine reports the record's position in the run rather than on the page. `rejectionBudget` caps how
 * many rejections are described: a source having a bad day can reject every record, and a report
 * with fifty thousand reasons in it is not a report.
 */
export const absorbRecords = (
	dependencies: AbsorbDependencies,
	effectId: EffectId,
	target: AbsorbTarget,
	authored: AuthoredIntegrationBinding,
	raw: ReadonlyArray<unknown>,
	indexOffset: number,
	rejectionBudget: number
): Effect.Effect<AbsorbOutcome, { readonly message: string }> =>
	Effect.gen(function* () {
		const decodeRecord = Schema.decodeUnknownEffect(authored.input);
		const rejected: Array<Rejection> = [];
		const reject = (index: number, reason: string): void => {
			if (rejected.length < rejectionBudget) rejected.push({ index, reason });
		};
		let created = 0;
		let updated = 0;

		// Decoded one at a time, and that is the whole reason `input` describes a record rather than a
		// body: a single malformed entry in a batch of five hundred would otherwise fail the decode and
		// discard the other four hundred and ninety-nine.
		const decoded: Array<{ readonly position: number; readonly record: unknown }> = [];
		for (const [position, entry] of raw.entries()) {
			const outcome = yield* Effect.result(decodeRecord(entry));
			if (Result.isFailure(outcome)) {
				reject(indexOffset + position, describe(outcome.failure));
				continue;
			}
			decoded.push({ position, record: outcome.success });
		}

		// The identity read can throw on a record that decoded but carries no usable key, so it is
		// inside the same per-record isolation as the decode.
		const keyed: Array<{ readonly key: string; readonly record: unknown; readonly position: number }> = [];
		for (const { position, record } of decoded) {
			const key = yield* Effect.result(Effect.try({ try: () => authored.identityValue(record), catch: (cause) => describe(cause) }));
			if (Result.isFailure(key)) {
				reject(indexOffset + position, key.failure);
				continue;
			}
			keyed.push({ key: key.success, record, position });
		}

		const known = keyed.length === 0
			? new Map<string, ReadonlyArray<string>>()
			: yield* dependencies.existing(effectId, target.collection, target.identityColumn, keyed.map(({ key }) => key));

		// One lookup for the batch, and it is deliberately *not* inside the per-record loop below. A
		// binding that resolved a foreign key per record would issue one round trip per record, which
		// reads fine on the ten rows an author tests with and turns a five-thousand-row import into
		// twenty minutes of sequential waiting. `resolve` sees every record that decoded and produced an
		// identity — exactly the set about to be written — so it can gather its keys in one `in (…)`.
		//
		// A failure here fails the batch rather than any record, and that is the right blame: the
		// records did nothing wrong and there is no one of them to charge it to. For a pull that means
		// the page fails and the cursor does not advance, so the next run reads the same window again;
		// rejecting every record instead would move the watermark past rows nothing was written for.
		// A key that simply is not there is a different event entirely — `resolve` succeeded, the code
		// is absent — and it is `map` that refuses that record, one record at a time.
		const resolveBatch = authored.resolve;
		const resolved: unknown = resolveBatch === undefined || keyed.length === 0
			? undefined
			: yield* dependencies.resolve(effectId, (api) => resolveBatch(keyed.map(({ record }) => record), api));

		for (const { key, record, position } of keyed) {
			const rows = yield* Effect.result(rowsFor(dependencies, effectId, target, authored, record, resolved));
			if (Result.isFailure(rows)) {
				reject(indexOffset + position, rows.failure.message);
				continue;
			}
			const before = known.get(key) ?? [];
			const survivors = new Set<string>();
			let failedRow = false;
			for (const [offset, row] of rows.success.entries()) {
				// The identity column is stamped from the identity rather than trusted from the mapping, so
				// a mapper that forgets it — or writes a different value into it — cannot produce a row the
				// next delivery fails to recognise as the same record. On a pushed delivery this is also
				// what stops a body from nominating its own primary key: the record is data, not authority.
				const values: Readonly<Record<string, Schema.Json>> = { ...jsonValues(row), [target.identityColumn]: key };
				/**
				 * Derived for every row including the first, so a re-run addresses the same ids it wrote.
				 *
				 * The first row used to reuse whatever id the identity lookup returned and the rest were
				 * always `create`. That made re-running a fan-out write duplicates for every row after the
				 * first — and, because a fan-out's width can differ between runs, made the id a row got
				 * depend on which run wrote it.
				 */
				const id = before[offset] ?? deriveRecordId(`${target.integration}:${target.binding}:${key}:${offset}`);
				const exists = before.includes(id);
				survivors.add(id);
				const written = yield* Effect.result(
					dependencies.write(effectId, target.collection, id, values, exists ? 'update' : 'create')
				);
				if (Result.isFailure(written)) {
					reject(indexOffset + position, written.failure.message);
					failedRow = true;
					break;
				}
			}
			// Only once the whole fan-out landed. Pruning after a partial write would delete rows on the
			// strength of a set we did not finish producing.
			if (failedRow) continue;
			const orphaned = before.filter((id) => !survivors.has(id));
			if (orphaned.length > 0) {
				const removed = yield* Effect.result(dependencies.remove(effectId, target.collection, orphaned));
				if (Result.isFailure(removed)) {
					reject(indexOffset + position, removed.failure.message);
					continue;
				}
			}
			// Counted per source record, not per row. A record that fans out into forty rows is one thing
			// absorbed, and reporting forty would make the number mean something different depending on
			// how the binding happens to map — the same import would "create" a different count on a
			// schema change that touched nothing upstream.
			if (before.length === 0) created += 1;
			else updated += 1;
		}

		return { created, updated, decoded: decoded.map(({ record }) => record), rejected };
	});
