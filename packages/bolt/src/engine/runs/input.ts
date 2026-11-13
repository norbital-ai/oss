// Selection loading shares the run's captured read boundary and never trusts client-supplied row images.
import { Effect, Predicate, Schema } from 'effect';
import { default_fields, exposure_of } from '@norbital-ai/store';
import type { AutomationInputSchema } from '../../decl/runtime/automation-input.ts';
import type { Json } from '../../decl/values.ts';
import { request, type ReadIR } from '../../protocol/reads.ts';
import { BoltError, from_store } from '../../protocol/errors.ts';
import { catalog_of } from '../access/pred.ts';
import type { EngineError } from '../errors.ts';
import type { EngineManifest } from '../manifest.ts';
import { LIMITS } from '../contracts.ts';
import { output_schema } from '../callables/output.ts';
import { encode_wire } from '@norbital-ai/store/wire';
import { EffectEvent } from '../../protocol/effect-events.ts';

const Ids = Schema.Array(Schema.String).check(Schema.isBetweenLength(0, LIMITS.page.max));
const Row = Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [Schema.Record(Schema.String, Schema.Json)]);
const Page = Schema.Struct({ rows: Schema.Array(Row) });
const Answer = Schema.Record(Schema.String, Page);
export const loadInputRows = Effect.fn('Runs.loadInputRows')(function* (
	manifest: EngineManifest,
	fields: typeof AutomationInputSchema.Type | undefined,
	input: Json,
	read: (requests: readonly ReadIR[]) => Effect.Effect<readonly Json[], EngineError>
) {
	const selected = Object.entries(fields ?? {}).filter((entry) => entry[1].kind === 'rows');
	if (selected.length === 0) return input;
	if (!Predicate.isObject(input))
		return yield* BoltError.make('invalid_input', 'decode', 'The automation input must be an object.');
	const loaded: Record<string, Json> = { ...input };
	const queries: ReadIR[] = [];
	const wanted: { field: string; model: string; ids: readonly string[] }[] = [];
	const catalog = catalog_of(manifest);
	for (const [field, kind] of selected) {
		if (kind.kind !== 'rows' || input[field] == null) continue;
		const ids = yield* Schema.decodeUnknownEffect(Ids)(input[field]).pipe(
			Effect.mapError((error) => BoltError.make('invalid_input', 'decode', `${field}: ${error.message}`))
		);
		if (ids.length === 0) { loaded[field] = []; continue; }
		const output = yield* exposure_of(catalog, kind.of).pipe(Effect.mapError(from_store));
		queries.push(yield* request(catalog, { [kind.of]: {
			output: 'default', fields: default_fields(output, true), where: { id: { in: ids } }, limit: ids.length
		} }));
		wanted.push({ field, model: kind.of, ids });
	}
	const answers = queries.length === 0 ? [] : yield* read(queries);
	for (const [index, selection] of wanted.entries()) {
		const answer = yield* Schema.decodeUnknownEffect(Answer)(answers[index]).pipe(
			Effect.mapError((error) => BoltError.make('corrupt', 'decode', error.message))
		);
		const page = answer[selection.model];
		if (page === undefined) return yield* BoltError.make('corrupt', 'decode', 'The row-input read returned no model page.');
		const byId = new Map(page.rows.map((row) => [row.id, row]));
		const codec = yield* Effect.try({
			try: () => output_schema(manifest, { kind: 'row', of: selection.model }),
			catch: (error) => error instanceof BoltError ? error : BoltError.make('corrupt', 'decode', String(error), error)
		});
		const rows: Json[] = [];
		for (const [index, id] of selection.ids.entries()) {
			const row = byId.get(id);
			if (row === undefined)
				return yield* BoltError.make('not_found', 'admission', `${selection.field}[${index}]: no readable ${selection.model} has this id.`);
			const checked = yield* Schema.decodeUnknownEffect(codec)(row).pipe(
				Effect.mapError((error) => BoltError.make('corrupt', 'decode', `${selection.field}[${index}]: ${error.message}`))
			);
			rows.push(encode_wire(checked));
		}
		loaded[selection.field] = rows;
	}
	return loaded;
});

const Image = Schema.Record(Schema.String, Schema.Json);
/** An effect run stores the same change shape for every verb. */
export const EffectInput = Schema.Struct({
	ids: Schema.Array(Schema.String),
	changes: Schema.Array(Schema.Struct({ before: Schema.NullOr(Image), set: Image, after: Schema.NullOr(Image) })),
	event: EffectEvent
}).check(Schema.makeFilter((input) => input.event.kind === 'approval' && input.changes.length !== 0
	? 'An approval event carries no committed changes.' : undefined));
export const effectImages = Schema.decodeUnknownOption(EffectInput);
