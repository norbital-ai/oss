// Integration instances (FINAL §3): the definitions an instance names, its row as the engine acts for it, the native
// `sys_integration` transform, an instance's live request (`ctx.request`) and the body runner every integration body
// shares. The transform reads the manifest's definitions and envoys, which no guest transform sees: the collection's
// allowlists fix `integration` and `owner` at create; this keeps the rest true of the definition — a known definition,
// an owner only where its driver syncs personal accounts, an envoy only on a workspace instance of a conversation
// definition, a configuration that decodes (defaults filled), and a named instance (`+workspace.ts`'s) never deleted here.
import { Clock, Effect, Option, Predicate, Schema } from 'effect';
import { localOf } from '@norbital-ai/std/zone';
import type { Kind } from '@norbital-ai/std/kind';
import { TenantDb, type TenantDbShape } from '../db/tenant-db.ts';
import { Drivers } from '../ports.ts';
import { Manifest, Reads, Live, Wake, type Bridge } from '../services.ts';
import type { GuestShape } from '../services.ts';
import { Port } from '../port.ts';
import type { EngineManifest } from '../manifest.ts';
import type { Json } from '../../decl/values.ts';
import {
	configurationDefaults,
	DRIVERS,
	type HandleKind,
	type IntegrationSpec
} from '../../decl/runtime/integration.ts';
import { SYSTEM } from '../../system/index.ts';
import { ImportStart } from '../../protocol/schema.ts';
import {
	LIMITS,
	type Bindings,
	type CrossAnswer,
	type EngineActor,
	type InputPath,
	type Outcome,
	type RowData
} from '../contracts.ts';
import { type EngineError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { decodeInput } from '../callables/decode.ts';
import { queueTriggered, nextDue } from '../runs/queue.ts';
import type { Item } from '../write/flatten.ts';
import { Chain } from '../write/sql.ts';
import {
	validateDatabaseRequest,
	validateDatabaseResult,
	type DatabaseRequest
} from './database.ts';

/** A definition by name: the workspace's, else one of bolt's conversation definitions. */
export const definitionOf = (m: EngineManifest, name: string): IntegrationSpec | undefined =>
	Object.hasOwn(m.integrations, name)
		? m.integrations[name]
		: Object.hasOwn(SYSTEM.integrations, name)
			? SYSTEM.integrations[name]
			: undefined;
/** The conversation a definition carries — its own (a custom chat) or its driver's — with the handle its senders are matched by. */
export const conversationOf = (
	def: IntegrationSpec
): { kind: 'chat' | 'email'; handle: HandleKind | null } | undefined => {
	const driver = DRIVERS[def.driver];
	return def.conversation ?? ('conversation' in driver ? driver.conversation : undefined);
};
/** Whether a definition carries a conversation. */
export const conversational = (def: IntegrationSpec): boolean => conversationOf(def) !== undefined;

type Refused = Extract<Outcome, { kind: 'refused' }>;
const refuse = (path: InputPath, field: string, message: string): Refused => {
	const row = path.find((p) => typeof p === 'number');
	return {
		kind: 'refused',
		code: 'refused',
		rule: 'sys_integration.transform',
		message,
		field,
		...(typeof row === 'number' ? { row } : {})
	};
};

/** A configuration as every instance stores it, a seeded one too: decoded against the definition's fields, their defaults filled. */
export function decodeConfiguration(
	def: IntegrationSpec,
	value: Json
): { value: Json } | { problem: string } {
	const d = decodeInput(def.configuration, value);
	if (d.problems.length > 0)
		return {
			problem: `The configuration is invalid: ${d.problems.map((p) => `${p.path} ${p.message}`).join('; ')}.`
		};
	// a null is absent unless the field is optional, so its default fills it as it fills a missing one
	const given = Object.entries(Predicate.isObject(value) ? value : {}).filter(
		([k, v]) => v !== null || def.configuration?.[k]?.optional === true
	);
	return { value: { ...configurationDefaults(def), ...Object.fromEntries(given) } };
}

/** The batch's rows as they will be written, or the first refusal. `stored` is an updated or deleted row's pre-image. */
export function instanceTransform(
	m: EngineManifest,
	items: readonly Item[],
	stored: (id: string) => RowData | undefined
): readonly Item[] | Refused {
	const out: Item[] = [];
	for (const it of items) {
		const c = it.change;
		if (c.collection !== 'sys_integration') {
			out.push(it);
			continue;
		}
		if (c.op === 'delete') {
			if (stored(c.id)?.['named'] === true)
				return refuse(c.path, 'id', `'${c.id}' is a connection of +workspace.ts; remove it there.`);
			out.push(it);
			continue;
		}
		const values = c.op === 'update' ? c.set : c.values;
		const pre = c.op === 'update' ? stored(c.id) : undefined;
		const name = String(pre?.['integration'] ?? values['integration']);
		const def = definitionOf(m, name);
		if (def === undefined)
			return refuse(c.path, 'integration', `No integration '${name}' is defined.`);
		const owner = pre === undefined ? (values['owner'] ?? null) : (pre['owner'] ?? null);
		if (pre === undefined && owner !== null && !('personal' in DRIVERS[def.driver]))
			return refuse(c.path, 'owner', `A ${def.driver} instance is never personal.`);
		const start = values['import_start'];
		if (start !== undefined && start !== null) {
			const decoded = Schema.decodeUnknownOption(ImportStart)(start);
			if (Option.isNone(decoded))
				return refuse(c.path, 'import_start', 'Choose a valid import start.');
			if (decoded.value.kind === 'since') {
				try {
					if (!Number.isFinite(Date.parse(decoded.value.at))) throw new Error('instant');
					localOf(Date.parse(decoded.value.at), decoded.value.zone);
				} catch {
					return refuse(
						c.path,
						'import_start',
						'Choose a valid import instant and IANA time zone.'
					);
				}
			}
		}
		const envoy = values['envoy'] ?? null;
		if (envoy !== null) {
			if (typeof envoy !== 'string' || !Object.hasOwn(m.envoys, envoy))
				return refuse(c.path, 'envoy', `No envoy '${String(envoy)}' is declared.`);
			if (!conversational(def))
				return refuse(
					c.path,
					'envoy',
					`An envoy answers only on a conversation integration; '${name}' is not one.`
				);
			if (owner !== null) return refuse(c.path, 'envoy', 'A personal instance takes no envoy.');
		}
		if (values['configuration'] === undefined && pre !== undefined) {
			out.push(it);
			continue;
		}
		const decoded = decodeConfiguration(def, values['configuration'] ?? {});
		if ('problem' in decoded) return refuse(c.path, 'configuration', decoded.problem);
		out.push({
			...it,
			change:
				c.op === 'update'
					? { ...c, set: { ...c.set, configuration: decoded.value } }
					: { ...c, values: { ...c.values, configuration: decoded.value } }
		});
	}
	return out;
}

export type Instance = {
	id: string;
	integration: string;
	definition: IntegrationSpec;
	owner: string | null;
	active: boolean;
	configuration: Json;
	status: Json;
};
const InstanceSchema = Schema.Struct({
	id: Schema.String,
	integration: Schema.String,
	owner: Schema.NullOr(Schema.String),
	active: Schema.Boolean,
	configuration: Schema.Json,
	status: Schema.Json
});
export const instancesOf = (
	manifest: EngineManifest,
	db: Pick<TenantDbShape, 'rows'>,
	where: { ids: readonly string[] } | { integration: string }
) =>
	db
		.rows(InstanceSchema, {
			text: `SELECT id, integration, owner, active, configuration, status FROM sys_integration WHERE ${'ids' in where ? 'id IN (SELECT jsonb_array_elements_text($1::jsonb))' : 'integration = $1'} ORDER BY id`,
			params: ['ids' in where ? JSON.stringify(where.ids) : where.integration]
		})
		.pipe(
			Effect.map((rows) =>
				rows.flatMap((row): Instance[] => {
					const definition = definitionOf(manifest, row.integration);
					return definition === undefined ? [] : [{ ...row, definition }];
				})
			)
		);

export const writeStatus = (instance: string, patch: { readonly [key: string]: Json }) =>
	Effect.gen(function* () {
		const manifest = yield* Manifest,
			db = yield* TenantDb,
			live = yield* Live,
			wake = yield* Wake;
		const c = new Chain(),
			at = new Date(yield* Clock.currentTimeMillis).toISOString(),
			p = c.p(patch),
			merged = `coalesce(i.status, '{}'::jsonb) || ${p}::jsonb`;
		const since = `CASE WHEN ${p}::jsonb -> 'state' IS NOT NULL AND i.status -> 'state' IS DISTINCT FROM ${p}::jsonb -> 'state' THEN jsonb_build_object('since', ${c.p(at)}::text) ELSE '{}'::jsonb END`;
		c.cte(
			'status',
			`UPDATE sys_integration i SET status = ${merged} || ${since}, revision = i.revision + 1 WHERE i.id = ${c.p(instance)} AND ${merged} IS DISTINCT FROM coalesce(i.status, '{}'::jsonb) RETURNING 'sys_integration'::text AS c, i.id::text AS id, i.revision AS revision, 'update'::text AS op, 'direct'::text AS cause, to_jsonb(old) AS o, to_jsonb(new) AS n`
		);
		queueTriggered(manifest, c, at, `system:${instance}`, 'status');
		const rows = yield* db.returning(
			Schema.Struct({
				captured: Schema.Array(
					Schema.Struct({
						collection: Schema.String,
						id: Schema.String,
						op: Schema.Literals(['create', 'update', 'delete']),
						revision: Schema.Number,
						old: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)),
						new: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)),
						cause: Schema.Literals(['direct', 'derived', 'cascade', 'erased'])
					})
				),
				next_due: Schema.NullOr(Schema.String)
			}),
			c.sql(
				`(SELECT coalesce(jsonb_agg(jsonb_build_object('collection', c, 'id', id, 'op', op, 'revision', revision, 'old', o, 'new', n, 'cause', cause)), '[]'::jsonb) FROM status) AS captured, (${nextDue(c)})::text AS next_due`
			)
		);
		const answer = rows[0];
		if (answer !== undefined) {
			live.publish(answer.captured);
			if (answer.next_due !== null) yield* wake.at(answer.next_due);
		}
	});
const fail = (code: string, message: string): CrossAnswer => ({
	ok: false,
	error: { kind: 'bolt', code, message }
});
const KindCommon = {
	optional: Schema.optionalKey(Schema.Literal(true)),
	default: Schema.optionalKey(Schema.Json),
	unique: Schema.optionalKey(Schema.Literal(true)),
	label: Schema.optionalKey(Schema.String),
	help: Schema.optionalKey(Schema.String),
	hidden: Schema.optionalKey(Schema.Literal(true))
};
const Range = { min: Schema.optionalKey(Schema.Number), max: Schema.optionalKey(Schema.Number) };
const DatePrecision = Schema.Literals(['year', 'month', 'week', 'day']);
const TimePrecision = Schema.Literals(['hour', 'minute']);
const Precision = Schema.Literals(['year', 'month', 'week', 'day', 'hour', 'minute']);
/** The authored output declaration crosses as JSON; only a decoded kind reaches std/kind's value codec. */
export const RequestOutput: Schema.Codec<Kind> = Schema.suspend(() =>
	Schema.Union([
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('text'),
			format: Schema.optionalKey(
				Schema.Literals(['email', 'phone', 'url', 'zone', 'markdown', 'cel'])
			),
			max: Schema.optionalKey(Schema.Number),
			many: Schema.optionalKey(Schema.Literal(true))
		}),
		Schema.Struct({ ...KindCommon, ...Range, kind: Schema.Literal('int') }),
		Schema.Struct({ ...KindCommon, ...Range, kind: Schema.Literal('number') }),
		Schema.Struct({
			...KindCommon,
			...Range,
			kind: Schema.Literal('decimal'),
			scale: Schema.Number,
			precision: Schema.optionalKey(Schema.Number)
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('money'),
			currency: Schema.optionalKey(Schema.String),
			scale: Schema.optionalKey(Schema.Number)
		}),
		...(['currency', 'bool', 'duration', 'point'] as const).map((kind) =>
			Schema.Struct({ ...KindCommon, kind: Schema.Literal(kind) })
		),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('date'),
			precision: Schema.optionalKey(DatePrecision)
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('instant'),
			precision: Schema.optionalKey(Precision)
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('time'),
			precision: Schema.optionalKey(TimePrecision)
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('period'),
			of: Schema.Literal('date'),
			precision: Schema.optionalKey(DatePrecision)
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('period'),
			of: Schema.Literal('instant'),
			precision: Schema.optionalKey(Precision)
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('enum'),
			values: Schema.Array(Schema.String),
			many: Schema.optionalKey(Schema.Literal(true))
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('state'),
			initial: Schema.String,
			states: Schema.Record(
				Schema.String,
				Schema.Struct({
					to: Schema.optionalKey(Schema.Array(Schema.String)),
					edit: Schema.optionalKey(
						Schema.Union([Schema.Literals(['all', 'none']), Schema.Array(Schema.String)])
					)
				})
			)
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('seq'),
			pattern: Schema.optionalKey(Schema.String),
			per: Schema.optionalKey(Schema.Array(Schema.String))
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('sum'),
			of: Schema.String,
			where: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
			money: Schema.optionalKey(Schema.Struct({ currency: Schema.optionalKey(Schema.String) }))
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('count'),
			of: Schema.String,
			where: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json))
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('json'),
			shape: Schema.optionalKey(RequestOutput)
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('file'),
			accept: Schema.Array(Schema.String),
			max: Schema.String,
			multiple: Schema.optionalKey(Schema.Literal(true))
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('vector'),
			dim: Schema.Number,
			metric: Schema.Literals(['l2', 'cosine', 'ip'])
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('custom'),
			of: Schema.String,
			many: Schema.optionalKey(Schema.Literal(true))
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('id'),
			of: Schema.String,
			where: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json))
		}),
		Schema.Struct({ ...KindCommon, ...Range, kind: Schema.Literal('list'), of: RequestOutput }),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('object'),
			fields: Schema.Record(Schema.String, RequestOutput),
			rest: Schema.optionalKey(RequestOutput)
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('union'),
			of: Schema.Array(RequestOutput)
		}),
		Schema.Struct({
			...KindCommon,
			kind: Schema.Literal('union'),
			by: Schema.String,
			arms: Schema.Record(Schema.String, Schema.Record(Schema.String, RequestOutput))
		}),
		Schema.Struct({ ...KindCommon, kind: Schema.Literal('record'), of: RequestOutput })
	])
);
const HttpOp = Schema.Struct({
	method: Schema.Literals(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
	path: Schema.String,
	query: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))
	),
	headers: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))
	),
	body: Schema.optionalKey(Schema.Json),
	output: Schema.optionalKey(RequestOutput)
});
const HttpResponse = Schema.Struct({
	status: Schema.Number,
	body: Schema.optionalKey(Schema.Json)
});
type RequestConfig = {
	manifest: EngineManifest;
	db: TenantDbShape;
	links: Drivers['Service'];
};
export const instanceRequest = (
	cfg: RequestConfig,
	to: string,
	op: Json,
	known?: Effect.Effect<Instance | undefined, EngineError>
): Effect.Effect<CrossAnswer, EngineError> =>
	Effect.gen(function* (): Effect.fn.Return<CrossAnswer, EngineError> {
		const instance = yield* known ??
			instancesOf(cfg.manifest, cfg.db, { ids: [to] }).pipe(Effect.map(([first]) => first));
		if (instance === undefined) return fail('invalidInput', `No integration instance '${to}'.`);
		const driver = DRIVERS[instance.definition.driver],
			kind = 'request' in driver ? driver.request : undefined;
		if (kind === undefined)
			return fail(
				'invalidInput',
				`'${to}' is a ${instance.definition.driver} instance; it takes no request.`
			);
		if (!instance.active)
			return {
				ok: false,
				error: { kind: 'unavailable', facility: `request ${to}`, reason: `'${to}' is paused` }
			};
		const decode: Effect.Effect<DatabaseRequest | typeof HttpOp.Type, BoltError> =
			kind === 'database'
				? Effect.try({
						try: () => validateDatabaseRequest(op),
						catch: (error) =>
							error instanceof BoltError
								? error
								: BoltError.make('invalidInput', 'admission', 'Invalid database request.')
					})
				: Schema.decodeUnknownEffect(HttpOp)(op, { errors: 'all', onExcessProperty: 'error' }).pipe(
						Effect.mapError(() =>
							BoltError.make(
								'invalidInput',
								'admission',
								'An http request is { method, path, query?, headers?, body?, output }.'
							)
						)
					);
		const wire = yield* decode.pipe(Effect.catch((error) => Effect.succeed(error)));
		if (wire instanceof BoltError) return fail(wire.code, wire.message);
		const { output, ...http } = 'output' in wire ? wire : { ...wire, output: undefined };
		const got = yield* cfg.links
			.request(to, http)
			.pipe(
				Port.call(
					`request ${to}`,
					kind === 'database' ? LIMITS.callMs.database : LIMITS.callMs.http
				),
				Effect.result
			);
		if (got._tag === 'Failure') {
			const error = got.failure;
			if (error._tag === 'Fenced') return fail('fenced', error.message);
			return {
				ok: false,
				error:
					error._tag === 'Unavailable'
						? { kind: 'unavailable', facility: `request ${to}`, reason: error.reason }
						: {
								kind: error.kind,
								message: kind === 'database' ? 'Database request failed.' : error.message
							}
			};
		}
		if (kind === 'database')
			return yield* Effect.try({
				try: () =>
					({
						ok: true,
						value: validateDatabaseResult(
							got.success,
							Predicate.isObject(op) && typeof op['maxRows'] === 'number'
								? op['maxRows']
								: undefined
						)
					}) satisfies CrossAnswer,
				catch: (error) =>
					BoltError.make(
						'upstream',
						'facility',
						error instanceof Error ? error.message : 'Database result is invalid.'
					)
			}).pipe(
				Effect.catch((error) =>
					Effect.succeed({
						ok: false,
						error: { kind: 'upstream', message: error.message }
					} satisfies CrossAnswer)
				)
			);
		const res = yield* Schema.decodeUnknownEffect(HttpResponse)(got.success).pipe(
			Effect.mapError(() =>
				BoltError.make('upstream', 'facility', 'The request answered an invalid response.')
			)
		);
		if (res.status === 429)
			return {
				ok: false,
				error: { kind: 'rateLimited', message: `'${to}' is rate limited`, status: res.status }
			};
		if (res.status < 200 || res.status >= 300)
			return {
				ok: false,
				error: {
					kind: 'upstream',
					message: `'${to}' answered ${res.status}${typeof res.body === 'string' && res.body !== '' ? `: ${res.body.slice(0, 200)}` : ''}`,
					status: res.status
				}
			};
		if (output !== undefined) {
			const decoded = decodeInput({ value: output }, { value: res.body ?? null });
			if (decoded.problems.length > 0)
				return {
					ok: false,
					error: {
						kind: 'upstream',
						message: `'${to}' answered a body that is not the output: ${decoded.problems.map((problem) => `${problem.path} ${problem.message}`).join('; ')}`
					}
				};
		}
		return { ok: true, value: res.body ?? null };
	});
type BodyConfig = RequestConfig & {
	guest: GuestShape;
	read: Reads['Service']['run'];
	bindings: () => Effect.Effect<Bindings>;
};
export const integrationBody = (
	cfg: BodyConfig,
	options: {
		id: string;
		actor: EngineActor;
		path: string;
		args: readonly Json[];
		instance?: string;
		partition?: string | null;
		key?: string;
		configuration?: Json;
		request?: boolean;
	}
) =>
	Effect.gen(function* () {
		const bindings = yield* cfg.bindings();
		let known: Effect.Effect<Instance | undefined, EngineError> | undefined;
		const bridge: Bridge = {
			cross: (calls) =>
				Effect.gen(function* () {
					const reads = calls.flatMap((call) => (call._tag === 'read' ? [call.read] : []));
					const answers =
						reads.length === 0
							? []
							: yield* cfg.read(reads, { as: 'workspace' }, bindings).pipe(
									Effect.map((values) => values.map((value): CrossAnswer => ({ ok: true, value }))),
									Effect.catch((error) =>
										Effect.succeed(
											reads.map(() =>
												fail(error._tag === 'BoltError' ? error.code : 'internal', error.message)
											)
										)
									)
								);
					let index = 0;
					return yield* Effect.forEach(
						calls,
						(call): Effect.Effect<CrossAnswer> => {
							if (call._tag === 'read')
								return Effect.succeed(
									answers[index++] ?? fail('internal', 'the read returned no answer')
								);
							if (
								call._tag === 'request' &&
								options.request === true &&
								options.instance !== undefined &&
								call.to === null
							)
								return instanceRequest(
									cfg,
									options.instance,
									call.operation,
									(known ??= instancesOf(cfg.manifest, cfg.db, { ids: [options.instance] }).pipe(
										Effect.map(([first]) => first)
									))
								).pipe(
									Effect.catch((error) =>
										Effect.succeed(
											fail(error._tag === 'BoltError' ? error.code : 'internal', error.message)
										)
									)
								);
							return Effect.succeed(
								fail(
									'unsupported',
									`an integration body cannot ${call._tag}${call._tag === 'request' ? ' here' : ''}`
								)
							);
						},
						{ concurrency: 'unbounded' }
					);
				})
		};
		const result = yield* cfg.guest.invoke(
			{
				id: options.id,
				kind: 'integration',
				target: options.path,
				input: [...options.args],
				ctx: {
					actor: options.actor,
					now: bindings.now,
					today: bindings.today,
					tz: bindings.tz,
					seed: options.id,
					...(options.instance === undefined ? {} : { instance: options.instance }),
					...(options.partition === undefined ? {} : { partition: options.partition }),
					...(options.key === undefined ? {} : { key: options.key }),
					...(options.configuration === undefined ? {} : { configuration: options.configuration })
				},
				budget: {
					cpuMs: LIMITS.guestCpuMs,
					crossings: LIMITS.crossings.sync,
					readBytes: LIMITS.readBytes
				}
			},
			bridge
		);
		if (result.kind === 'ok') return result.output;
		return yield* Effect.fail(
			result.kind === 'failed' ? result.error : BoltError.make('refused', 'guest', result.message)
		);
	});
