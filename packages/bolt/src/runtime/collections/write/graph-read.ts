import { Deferred, Effect, Result, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import type { FieldDefinition } from '#lib/authoring/workspace-schema.js';
import type { WritableManyRelation } from './plan.js';

export type RelatedRowsRequest = Readonly<{
	readonly edge: WritableManyRelation;
	readonly parentId: string;
}>;

export type RelatedRowsResult = Readonly<{
	readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
	readonly raw: ReadonlyArray<Readonly<Record<string, unknown>>>;
	readonly json: string;
}>;

type StoredGraphRow = Readonly<{
	readonly row: Readonly<Record<string, unknown>>;
	readonly snapshot: string;
}>;

export type GraphWaveReadResult = Readonly<{
	readonly stored: Map<string, StoredGraphRow | undefined>;
	readonly related: Map<string, RelatedRowsResult>;
}>;

type PendingGraphWaveRead<Error> = Readonly<{
	readonly participant: string;
	readonly wave: number;
	readonly rows: ReadonlyArray<Readonly<{ collection: string; id: string }>>;
	readonly relations: ReadonlyArray<RelatedRowsRequest>;
	readonly result: Deferred.Deferred<GraphWaveReadResult, Error>;
}>;

export type GraphReadSession<Error> = Readonly<{
	readonly relatedRows: Map<string, RelatedRowsResult>;
	readonly storedRows: Map<string, StoredGraphRow | undefined>;
	readonly batch: {
		readonly effectId: EffectId;
		readonly pending: Array<PendingGraphWaveRead<Error>>;
		readonly participants: Map<string, number>;
		readonly completed: Set<string>;
		nextFacilityWave: number;
		flushing: boolean;
	};
}>;

export const relatedRowsKey = (edge: WritableManyRelation, parentId: string): string =>
	`${edge.childCollection}\u0000${edge.childColumn}\u0000${parentId}`;

export const storedGraphRowKey = (collection: string, id: string): string =>
	`${collection}\u0000${id}`;

const makeGraphReadSession = <Error>(
	effectId: EffectId,
	participants: ReadonlyArray<string>
): GraphReadSession<Error> => ({
	relatedRows: new Map(),
	storedRows: new Map(),
	batch: {
		effectId,
		pending: [],
		participants: new Map(participants.map((participant) => [participant, 0])),
		completed: new Set(),
		nextFacilityWave: 0,
		flushing: false
	}
});

type GraphWaveReadPorts<Error, Requirements> = Readonly<{
	readonly execute: (
		effectId: EffectId,
		sql: string,
		parameters: ReadonlyArray<Schema.Json>
	) => Effect.Effect<ReadonlyArray<unknown>, Error, Requirements>;
	readonly collectionFields: (
		collection: string
	) => Effect.Effect<Readonly<Record<string, FieldDefinition>>, Error, Requirements>;
	readonly decodeReferenceRow: (
		row: Readonly<Record<string, unknown>>,
		fields: Readonly<Record<string, FieldDefinition>>
	) => Readonly<Record<string, unknown>>;
	readonly isJsonObject: (value: unknown) => value is Readonly<Record<string, Schema.Json>>;
	readonly quoteIdentifier: (name: string) => string;
}>;

/** One facility query for the row pre-images and relation memberships of a write wave. */
const graphWaveRead = <Error, Requirements>(
	ports: GraphWaveReadPorts<Error, Requirements>,
	effectId: EffectId,
	rowRequests: ReadonlyArray<Readonly<{ collection: string; id: string }>>,
	relationRequests: ReadonlyArray<RelatedRowsRequest>
): Effect.Effect<GraphWaveReadResult, Error, Requirements> =>
	Effect.gen(function* () {
		const uniqueRows = new Map<string, Readonly<{ collection: string; id: string }>>();
		for (const request of rowRequests) {
			const key = storedGraphRowKey(request.collection, request.id);
			if (!uniqueRows.has(key)) uniqueRows.set(key, request);
		}
		const uniqueRelations = new Map<string, RelatedRowsRequest>();
		for (const request of relationRequests) {
			const key = relatedRowsKey(request.edge, request.parentId);
			if (!uniqueRelations.has(key)) uniqueRelations.set(key, request);
		}
		const orderedRows = [...uniqueRows.entries()].toSorted(([left], [right]) =>
			left.localeCompare(right)
		);
		const orderedRelations = [...uniqueRelations.entries()].toSorted(([left], [right]) =>
			left.localeCompare(right)
		);
		const stored = new Map<string, StoredGraphRow | undefined>();
		const related = new Map<string, RelatedRowsResult>();
		if (orderedRows.length === 0 && orderedRelations.length === 0) return { stored, related };
		const parameters: Array<Schema.Json> = [];
		const rowBranches = orderedRows.map(([, request], ordinal) => {
			const ordinalParameter = parameters.push(ordinal);
			const idParameter = parameters.push(request.id);
			return `select 'row'::text as "__bolt_write_wave_kind", $${ordinalParameter}::integer as "__bolt_write_wave_ordinal", to_jsonb(record) as "__bolt_write_wave_record" from ${ports.quoteIdentifier(request.collection)} as record where record.id = $${idParameter}`;
		});
		const relationBranches = orderedRelations.map(([, request], ordinal) => {
			const ordinalParameter = parameters.push(ordinal);
			const parentParameter = parameters.push(request.parentId);
			return `select 'relation'::text as "__bolt_write_wave_kind", $${ordinalParameter}::integer as "__bolt_write_wave_ordinal", to_jsonb(child) as "__bolt_write_wave_record" from ${ports.quoteIdentifier(request.edge.childCollection)} as child where child.${ports.quoteIdentifier(request.edge.childColumn)} = $${parentParameter}`;
		});
		const rows = yield* ports.execute(
			effectId,
			`select * from (${[...rowBranches, ...relationBranches].join(' union all ')}) as planned order by "__bolt_write_wave_kind", "__bolt_write_wave_ordinal", "__bolt_write_wave_record"->>'id'`,
			parameters
		);
		const rawRows = new Map<number, Readonly<Record<string, unknown>>>();
		const rawRelations = new Map<number, Array<Readonly<Record<string, unknown>>>>();
		for (const row of rows) {
			if (!ports.isJsonObject(row)) continue;
			const kind = row['__bolt_write_wave_kind'];
			const ordinal = row['__bolt_write_wave_ordinal'];
			const record = row['__bolt_write_wave_record'];
			if (typeof ordinal !== 'number' || !ports.isJsonObject(record)) continue;
			if (kind === 'row') rawRows.set(ordinal, record);
			if (kind === 'relation') {
				const bucket = rawRelations.get(ordinal) ?? [];
				bucket.push(record);
				rawRelations.set(ordinal, bucket);
			}
		}
		for (const [[key, request], ordinal] of orderedRows.map(
			(entry, index) => [entry, index] as const
		)) {
			const raw = rawRows.get(ordinal);
			if (raw === undefined) {
				stored.set(key, undefined);
				continue;
			}
			const fields = yield* ports.collectionFields(request.collection);
			stored.set(key, {
				row: ports.decodeReferenceRow(raw, fields),
				snapshot: JSON.stringify(raw)
			});
		}
		for (const [[key, request], ordinal] of orderedRelations.map(
			(entry, index) => [entry, index] as const
		)) {
			const fields = yield* ports.collectionFields(request.edge.childCollection);
			const raw = rawRelations.get(ordinal) ?? [];
			related.set(key, {
				rows: raw.map((row) => ports.decodeReferenceRow(row, fields)),
				raw,
				json: JSON.stringify(raw)
			});
		}
		return { stored, related };
	});

const queuedGraphWaveRead = <Error, Requirements>(
	readWave: (
		effectId: EffectId,
		rows: ReadonlyArray<Readonly<{ collection: string; id: string }>>,
		relations: ReadonlyArray<RelatedRowsRequest>
	) => Effect.Effect<GraphWaveReadResult, Error, Requirements>,
	session: GraphReadSession<Error>,
	participant: string,
	rows: ReadonlyArray<Readonly<{ collection: string; id: string }>>,
	relations: ReadonlyArray<RelatedRowsRequest>
): Effect.Effect<GraphWaveReadResult, Error, Requirements> =>
	Effect.gen(function* () {
		const result = yield* Deferred.make<GraphWaveReadResult, Error>();
		const wave = session.batch.participants.get(participant) ?? 0;
		session.batch.participants.set(participant, wave + 1);
		session.batch.pending.push({ participant, wave, rows, relations, result });
		yield* flushGraphReadBatch(readWave, session);
		return yield* Deferred.await(result);
	});

const flushGraphReadBatch = <Error, Requirements>(
	readWave: (
		effectId: EffectId,
		rows: ReadonlyArray<Readonly<{ collection: string; id: string }>>,
		relations: ReadonlyArray<RelatedRowsRequest>
	) => Effect.Effect<GraphWaveReadResult, Error, Requirements>,
	session: GraphReadSession<Error>
): Effect.Effect<void, never, Requirements> =>
	Effect.gen(function* () {
		const batch = session.batch;
		if (batch.flushing) return;
		batch.flushing = true;
		while (batch.pending.length > 0) {
			const wave = Math.min(...batch.pending.map((request) => request.wave));
			const ready = [...batch.participants.entries()].every(
				([participant, nextWave]) => batch.completed.has(participant) || nextWave > wave
			);
			if (!ready) break;
			const pending = batch.pending.filter((request) => request.wave === wave);
			batch.pending.splice(
				0,
				batch.pending.length,
				...batch.pending.filter((request) => request.wave !== wave)
			);
			const outcome = yield* Effect.result(
				readWave(
					EffectId.make(`${batch.effectId}:graph:write-wave:${batch.nextFacilityWave++}`),
					pending.flatMap((request) => request.rows),
					pending.flatMap((request) => request.relations)
				)
			);
			if (Result.isFailure(outcome)) {
				for (const request of pending) yield* Deferred.fail(request.result, outcome.failure);
			} else {
				for (const request of pending) yield* Deferred.succeed(request.result, outcome.success);
			}
		}
		batch.flushing = false;
	});

const completeGraphReadParticipant = <Error, Requirements>(
	readWave: (
		effectId: EffectId,
		rows: ReadonlyArray<Readonly<{ collection: string; id: string }>>,
		relations: ReadonlyArray<RelatedRowsRequest>
	) => Effect.Effect<GraphWaveReadResult, Error, Requirements>,
	session: GraphReadSession<Error>,
	participant: string
): Effect.Effect<void, never, Requirements> =>
	Effect.gen(function* () {
		// Completion is a finalizer action, not Effect-construction state. Recording it eagerly marks
		// every participant complete while the concurrent preparation effects are merely being built,
		// which makes each participant's later read look like a ready wave and degenerates batching to
		// one facility query per root.
		session.batch.completed.add(participant);
		yield* flushGraphReadBatch(readWave, session);
	});

/** Invocation-facing graph-read API; the queue and facility adapters cannot drift independently. */
export const makeGraphReader = <Error, Requirements>(
	ports: GraphWaveReadPorts<Error, Requirements>
) => {
	const read = (
		effectId: EffectId,
		rows: ReadonlyArray<Readonly<{ collection: string; id: string }>>,
		relations: ReadonlyArray<RelatedRowsRequest>
	) => graphWaveRead(ports, effectId, rows, relations);
	return {
		session: makeGraphReadSession<Error>,
		read,
		queued: (
			session: GraphReadSession<Error>,
			participant: string,
			rows: ReadonlyArray<Readonly<{ collection: string; id: string }>>,
			relations: ReadonlyArray<RelatedRowsRequest>
		) => queuedGraphWaveRead(read, session, participant, rows, relations),
		complete: (session: GraphReadSession<Error>, participant: string) =>
			completeGraphReadParticipant(read, session, participant)
	};
};
