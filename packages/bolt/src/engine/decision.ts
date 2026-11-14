// Structured decisions: one schema at each boundary and one persisted event per call; the host meters at its facility.
import {
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Predicate,
	Result,
	Schema
} from 'effect';
import * as EffectArray from 'effect/Array';
import type { Json } from '../decl/values.ts';
import type {
	DecisionEntry,
	DecisionQuestion,
	DecisionState
} from '../decl/runtime/facilities.ts';
import {
	answer_criteria,
	DECISION_CALL_MS,
	decision_images,
	type DecisionRequest,
	type DecisionResult,
	FacilityFailure,
	Port,
	type Unavailable
} from '@norbital-ai/host-api';
import {
	type Authority,
	type Bindings,
	type FacilityError
} from './contracts.ts';
import type { EngineManifest } from './manifest.ts';
import { type TenantDbShape } from './db/tenant-db.ts';
import { Ai, Logs } from './ports.ts';
import { Decisions, type DecisionUse, type ReadsShape, type ShapeOf } from './services.ts';
import { catalog_of } from './access/pred.ts';
import { exposed, grantedArms, outputsOf } from './access/authority.ts';
import { q } from '@norbital-ai/store';
import { clip, PUBLIC_ENVOY } from './agent/schema.ts';
import { RunOutputRow, readsRunResult } from './runs/rows.ts';
import { outputFiles } from './runs/output-files.ts';
import * as ir from '../protocol/reads.ts';

export type { DecisionEntry, DecisionQuestion, DecisionState };
const FILE_KEYS = new Set(['id', 'name', 'mime', 'size', 'bytes', 'sha256']);
/** A `FileRef` leaf as it crosses the guest boundary: `{ id, name, mime }` (an upload's `size`/`bytes`/`sha256` may ride along). */
const isFileRef = (v: unknown): v is { id: string; name: string; mime: string } =>
	Predicate.isObject(v) &&
	typeof v['id'] === 'string' &&
	typeof v['name'] === 'string' &&
	typeof v['mime'] === 'string' &&
	Object.keys(v).every((k) => FILE_KEYS.has(k));
const walk = (v: unknown, leaf: (x: unknown) => unknown): unknown => {
	const r = leaf(v);
	if (r !== undefined) return r;
	if (EffectArray.isArray(v)) return v.map((x) => walk(x, leaf));
	return Predicate.isObject(v) && !(v instanceof Uint8Array)
		? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, leaf)]))
		: v;
};
/** Every `FileRef` id a value names. */
const fileIds = (value: unknown): string[] => {
	const out = new Set<string>();
	walk(value, (x) => (isFileRef(x) ? (out.add(x.id), x) : undefined));
	return [...out];
};

export const ask = Effect.fn('Decisions.ask')(function* (
	ai: ShapeOf<typeof Ai>,
	request: DecisionRequest,
	ms: number = DECISION_CALL_MS
) {
	if (fileIds(request).length > 0)
		return yield* Effect.fail(
			new FacilityFailure({
				kind: 'invalid',
				message:
					'sys_1 requires resolved content: pass inline images or extracted text, never a stored FileRef'
			})
		);
	yield* decision_images(request.state);
	const result = yield* ai.ask(request).pipe(
		Port.call('sys_1', Math.min(ms, DECISION_CALL_MS), 'sys_1 did not answer within its wall')
	);
	return yield* Schema.decodeUnknownEffect(answer_criteria(request))(result).pipe(
		Effect.mapError((error) => new FacilityFailure({ kind: 'invalid', message: error.message }))
	);
});
export const failed = (result: DecisionResult | FacilityError): result is FacilityError =>
	'kind' in result;
export const choiceOf = (result: DecisionResult, id: string): string | undefined => {
	const answer = result.answers[id];
	return answer?.type === 'choice' ? answer.choice : undefined;
};
export const noulOf = (result: DecisionResult, id: string): number => {
	const answer = result.answers[id];
	return answer?.type === 'noul' ? answer.noul : 0;
};
const clipState = (value: Json): Json =>
	typeof value === 'string'
		? clip(value)
		: Array.isArray(value)
			? value.map(clipState)
			: value !== null && typeof value === 'object'
				? Predicate.isObject(value) && 'type' in value && value['type'] === 'image_url'
					? { type: 'image_url', image_url: { url: '[image bytes omitted]' } }
					: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clipState(item)]))
				: value;
export const decisionEvent = (
	use: DecisionUse,
	request: DecisionRequest,
	result: DecisionResult | FacilityError
): { readonly [key: string]: Json } => ({
	use,
	system: 1,
	state: clipState(request.state),
	questions: Object.keys(request.questions),
	...(failed(result)
		? {
				error: result.kind,
				...(result.kind === 'unavailable' || result.status === undefined
					? {}
					: { status: result.status })
			}
		: {
				answers: clipState(result.answers),
				cost_usd: result.cost_usd,
				provider: result.provider,
				...(result.model === undefined ? {} : { model: result.model }),
				...(result.call === undefined ? {} : { call: result.call }),
				...(result.tokens === undefined ? {} : { tokens: result.tokens })
			})
});
/** Same retained AI resource observation as inference; decision.made remains the detailed decision trace. */
export const decisionUsage = Effect.fn('Decisions.usage')(function* (
	logs: Logs['Service'],
	use: DecisionUse,
	request: DecisionRequest,
	result: DecisionResult | FacilityError,
	context: Pick<
		Parameters<Logs['Service']['write']>[0],
		'invocation' | 'run' | 'conversation' | 'turn'
	> & { duration_ms: number }
) {
	const bad = failed(result);
	yield* logs.write({
		at: new Date(yield* Clock.currentTimeMillis).toISOString(),
		severity: bad ? 'warn' : 'info',
		event: 'ai.call',
		invocation: context.invocation,
		run: context.run,
		conversation: context.conversation,
		turn: context.turn,
		attributes: {
			system: 1,
			category: 'decisions',
			use,
			duration_ms: context.duration_ms,
			questionCount: Object.keys(request.questions).length,
			requestBytes: new TextEncoder().encode(JSON.stringify(request)).byteLength,
			call: bad ? null : (result.call ?? null),
			model: bad ? null : (result.model ?? result.provider),
			provider: bad ? null : result.provider,
			input: bad ? null : (result.tokens?.input ?? null),
			output: bad ? null : (result.tokens?.output ?? null),
			cached: null,
			reasoning: null,
			cost: bad ? null : result.cost_usd,
			settlement: bad || result.call === undefined ? 'attention' : 'pending',
			...(bad ? { error: result.kind } : {})
		}
	});
});
export const DecisionTrace = Context.Reference<
	{ readonly invocation: string; readonly run: string | null; readonly automation: string } | undefined
>('bolt/DecisionTrace', { defaultValue: () => undefined });
export const DecisionsLive = Layer.effect(
	Decisions,
	Effect.gen(function* () {
		const ai = yield* Ai,
			crypto = yield* Crypto.Crypto,
			logs = yield* Logs;
		return Decisions.of({
			decide: Effect.fn('Decisions.decide')(function* (use, request) {
				const started = yield* Clock.currentTimeMillis;
				const trace = yield* DecisionTrace;
				const result = yield* Effect.result(ask(ai, request));
				const event = Result.isSuccess(result) ? result.success : wireFailure(result.failure);
				const now = new Date(yield* Clock.currentTimeMillis).toISOString();
				const call = yield* crypto
					.randomUUIDv4()
					.pipe(
						Effect.mapError(
							(error) => new FacilityFailure({ kind: 'upstream', message: error.message })
						)
					);
				yield* decisionUsage(logs, use, request, event, {
					invocation: trace?.invocation ?? call,
					run: trace?.run ?? null,
					conversation: null,
					turn: null,
					duration_ms: (yield* Clock.currentTimeMillis) - started
				});
				yield* logs.write({
					at: now,
					severity: Result.isSuccess(result) ? 'info' : 'warn',
					event: 'decision.made',
					invocation: trace?.invocation ?? call,
					run: trace?.run ?? null,
					conversation: null,
					turn: null,
					attributes: {
						...decisionEvent(use, request, event),
						...(trace === undefined ? {} : { automation: trace.automation, run: trace.run })
					}
				});
				if (Result.isFailure(result)) return yield* Effect.fail(result.failure);
				return result.success;
			})
		});
	})
);


/**
 * Whether `authority` may read a stored file, as `GET /__bolt/files/<id>` checks: an administrator, or a row holding it in
 * its model's file field that an output the caller holds reads.
 * A conversation's file (`sys_conversation.inputs` / `outputs`) is its uploader's, and then the conversation's: its owner, a member who
 * posted in it (in the app or as a linked envoy sender), and staff for an instance's conversation. Filed into a record (an
 * envoy's photo), it is also that record's: whoever reads it there, as for any file field.
 */
export const readableFile = Effect.fn('Decisions.readableFile')(function* (
	o: {
		manifest: EngineManifest;
		db: TenantDbShape;
		read: ReadsShape['run'];
		authority: Authority;
		bindings: Bindings;
	},
	id: string,
	owner: string
) {
	if (o.authority.actor.kind === 'member') {
		const notified = yield* o.db.one(Schema.Struct({ found: Schema.Boolean }), {
			text: `SELECT true AS found FROM sys_notification WHERE member = $1 AND attachments @> $2::jsonb LIMIT 1`,
			params: [o.authority.actor.id, JSON.stringify([{ id }])]
		});
		if (Option.isSome(notified)) return true;
	}
	/**
	 * A row of any `(model, field)` pair holding the file in that file field that an output the caller holds reads: the
	 * holders of every pair in one round trip, then every candidate read in one batch. ponytail: ≤ 20 holders per pair.
	 */
	const held = Effect.fn('Decisions.held')(function* (pairs: readonly (readonly [string, string])[]) {
		const granted = pairs.filter(([model]) => o.authority.models[model] !== undefined);
		if (granted.length === 0) return false;
		const found = yield* o.db.read(granted.map(([model, field]) => ({
			text: `SELECT id::text AS id FROM ${q(model)} WHERE ${q(field)} @> $1::jsonb OR ${q(field)} @> $2::jsonb LIMIT 20`,
			params: [JSON.stringify({ id }), JSON.stringify([{ id }])]
		})));
		const cat = catalog_of(o.manifest);
		const reads = yield* Effect.forEach(granted.entries(), ([index, [model, field]]) => {
			const holders = (found[index]?.rows ?? []).flatMap((row) => (typeof row['id'] === 'string' ? [row['id']] : []));
			const outputs = outputsOf(o.manifest, model).filter(
				(output) =>
					(o.authority.admin || grantedArms(o.authority, model, output) !== undefined) &&
					exposed(o.manifest, model, model, model, output).includes(field)
			);
			return Effect.forEach(outputs.flatMap((output) => holders.map((holder) => [output, holder] as const)), ([output, holder]) =>
				Effect.map(ir.get(cat, model, holder, { select: { [field]: true } }), (read) =>
					({ field, read: read.kind === 'get' ? { ...read, output } : read })));
		});
		const candidates = reads.flat();
		if (candidates.length === 0) return false;
		const got = yield* o.read(candidates.map(({ read }) => read), { as: 'caller', authority: o.authority }, o.bindings);
		return got.some((row, index) => {
			const field = candidates[index]?.field;
			return field !== undefined && JSON.stringify((Predicate.isObject(row) ? row[field] : null) ?? null).includes(id);
		});
	});
	if (owner === 'sys_conversation.inputs' || owner === 'sys_conversation.outputs') {
		const a = o.authority.actor;
		// ponytail: every file field is scanned for a holder; a file-field index if this read gets hot
		const filed = () =>
			held(Object.entries(o.manifest.models).flatMap(([c, spec]) =>
				Object.entries(spec.fields).flatMap(([f, def]) => (def.kind === 'file' ? [[c, f] as const] : []))));
		if (a.kind !== 'member') return yield* filed();
		const r = yield* o.db.one(Schema.Struct({ found: Schema.Boolean }), {
			text: `SELECT true AS found FROM sys_file WHERE id = $1 AND field = $6 AND created_by = $2
			UNION ALL SELECT true AS found FROM sys_conversation c WHERE (c.inputs @> $3::jsonb OR c.outputs @> $3::jsonb OR c.outputs @> $7::jsonb)
				AND (c.owner = $2 OR ($5 AND c.integration IS NULL) OR ($4 AND c.integration IS NOT NULL AND ${PUBLIC_ENVOY}) OR EXISTS (SELECT 1 FROM sys_message p WHERE p.conversation = c.id
					AND ($2 IN (p."as"->>'member', p."as"->'envoy'->>'member'))))
			LIMIT 1`,
			params: [
				id,
				a.id,
				JSON.stringify([{ id }]),
				!a.external,
				// admins read in-app files; an envoy thread's only through the rule above (owner 2026-09-26)
				o.authority.admin,
				owner,
				// an ingest's files are grouped under its output entry (plan 12)
				JSON.stringify([{ files: [{ id }] }])
			]
		});
		return Option.isSome(r) || (yield* filed());
	}
	if (o.authority.admin) return true;
	const automation = o.manifest.automations[owner];
	if (automation !== undefined) {
		let after: string | null = null;
		for (;;) {
			const row: Option.Option<typeof RunOutputRow.Type> = yield* o.db.one(RunOutputRow, {
				text: `SELECT id, automation, output, starter FROM sys_run WHERE automation = $1 AND ($3::text IS NULL OR id > $3) AND jsonb_path_exists(output, '$.**.id ? (@ == $id)', jsonb_build_object('id', $2::text)) ORDER BY id LIMIT 1`,
				params: [owner, id, after]
			});
			if (Option.isNone(row)) return false;
			if (
				readsRunResult(o.authority, row.value) &&
				outputFiles(
					automation.output,
					row.value.output,
					o.manifest.custom_fields,
					o.manifest.models
				).some((file) => file.id === id)
			)
				return true;
			after = row.value.id;
		}
	}
	const [model, field] = owner.split('.');
	// An import upload or export file belongs to the member who ran its file sync or conversion.
	if (field === '$import' || field === '$export') {
		if (o.authority.actor.kind !== 'member') return false;
		const r = yield* o.db.one(Schema.Struct({ found: Schema.Boolean }), {
			text: `SELECT true AS found FROM sys_file WHERE id = $1 AND field = $2 AND created_by = $3 LIMIT 1`,
			params: [id, owner, o.authority.actor.id]
		});
		return Option.isSome(r);
	}
	if (
		model === undefined ||
		field === undefined ||
		o.manifest.models[model]?.fields[field]?.kind !== 'file'
	)
		return false;
	return yield* held([[model, field]]);
});

const wireFailure = (error: FacilityFailure | Unavailable): FacilityError =>
	error._tag === 'Unavailable'
		? { kind: 'unavailable', facility: error.facility, reason: error.reason }
		: {
				kind: error.kind,
				message: error.message,
				...(error.status === undefined ? {} : { status: error.status })
			};
