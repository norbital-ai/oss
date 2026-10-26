// Integration instances (FINAL §3): the definitions an instance names, its row as the engine acts for it, the native
// `sys_integration` transform, an instance's live request (`ctx.request`, paced by the definition's `rate` and a `429`'s
// `Retry-After`) and the body runner sync bodies and the `test` body share. The transform reads the manifest's definitions and envoys, which no guest transform sees: the collection's
// allowlists fix `integration` and `owner` at create; this keeps the rest true of the definition — a known definition,
// an owner only where its driver syncs personal accounts, an envoy only on a workspace instance of a conversation
// definition, a configuration that decodes (defaults filled), and a named instance (`+workspace.ts`'s) never deleted here.
import { Clock, Crypto, Effect, Option, Predicate, Schema } from 'effect';
import { localOf } from '@norbital-ai/std/zone';
import { TenantDb, type TenantDbShape } from '../db/tenant-db.ts';
import { Drivers } from '../ports.ts';
import { Manifest, Reads, Live, Wake, type Bridge } from '../services.ts';
import type { GuestShape } from '../services.ts';
import { prepareSend, sendPiece } from '../conversations/outbound.ts';
import { stableId } from '../conversations/store.ts';
import { duration } from '../runs/time.ts';
import { Port } from '../port.ts';
import { RequestOutput } from './request-schema.ts';
import type { EngineManifest } from '../manifest.ts';
import type { Json, Rate } from '../../decl/values.ts';
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
	type InvocationKind,
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
/** The conversation a definition's driver carries, with the handle its senders are matched by. */
export const conversationOf = (
	def: IntegrationSpec
): { kind: 'chat' | 'email'; handle: HandleKind | null } | undefined => {
	const driver = DRIVERS[def.driver];
	return 'conversation' in driver ? driver.conversation : undefined;
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
	body: Schema.optionalKey(Schema.Json),
	/** A `429`'s or `503`'s `Retry-After`, in seconds (engine/integrations/http.ts). */
	retryAfter: Schema.optionalKey(Schema.Number)
});
type RequestConfig = {
	manifest: EngineManifest;
	db: TenantDbShape;
	links: Drivers['Service'];
};
/** When an instance's next request may start (its `rate`), and until when its provider asked us to wait (`Retry-After`). */
type Pace = { next: number; blocked: number };
// ponytail: in-process per tenant database (the cell owns the tenant); a cross-cell budget would need a shared window
const paces = new WeakMap<TenantDbShape, Map<string, Pace>>();
const paceOf = (db: TenantDbShape, instance: string): Pace => {
	let all = paces.get(db);
	if (all === undefined) paces.set(db, (all = new Map()));
	let p = all.get(instance);
	if (p === undefined) all.set(instance, (p = { next: 0, blocked: 0 }));
	return p;
};
/** The milliseconds a definition's `rate` (`'10/s'`, `'600/min'`, `'5/10s'`) leaves between two requests. */
const spacing = (rate: Rate | undefined): number => {
	if (rate === undefined) return 0;
	const [n, per = 's'] = rate.split('/');
	return duration(/^\d/.test(per) ? per : `1${per}`) / Number(n);
};
/** Until when an instance's provider asked (`Retry-After`) that nothing be sent to it; 0 when it did not. */
export const retryAfterOf = (db: TenantDbShape, instance: string): number =>
	paces.get(db)?.get(instance)?.blocked ?? 0;
export const instanceRequest = (
	cfg: RequestConfig,
	to: string,
	op: Json,
	known?: Effect.Effect<Instance | undefined, EngineError>,
	/** A sync write's `Idempotency-Key`, set on every http request it makes. */
	key?: string
): Effect.Effect<CrossAnswer, EngineError> =>
	Effect.gen(function* (): Effect.fn.Return<CrossAnswer, EngineError> {
		const instance = yield* known ??
			instancesOf(cfg.manifest, cfg.db, { ids: [to] }).pipe(Effect.map(([first]) => first));
		if (instance === undefined) return fail('invalidInput', `No integration instance '${to}'.`);
		const driver = DRIVERS[instance.definition.driver],
			kind = 'request' in driver ? driver.request : 'call' in driver ? driver.call : undefined;
		if (kind === undefined)
			return fail(
				'invalidInput',
				`'${to}' is a ${instance.definition.driver} instance; it takes no request.`
			);
		// a member's own account answers only its definition's bodies (they pass `known`), never an automation
		if (instance.owner !== null && known === undefined)
			return fail(
				'invalidInput',
				`'${to}' is a member's own account; only its integration calls it.`
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
		const { output, ...plain } = 'output' in wire ? wire : { ...wire, output: undefined };
		const http =
			key === undefined || !('method' in plain)
				? plain
				: {
						...plain,
						headers: {
							...Object.fromEntries(
								Object.entries(plain.headers ?? {}).filter(
									([h]) => h.toLowerCase() !== 'idempotency-key'
								)
							),
							'idempotency-key': key
						}
					};
		// every request waits its turn under the definition's `rate`, and after a provider's `Retry-After`
		const pace = paceOf(cfg.db, to),
			now = yield* Clock.currentTimeMillis;
		let start = Math.max(now, pace.next, pace.blocked);
		pace.next = start + spacing(instance.definition.rate);
		for (;;) {
			const current = yield* Clock.currentTimeMillis;
			if (pace.blocked > start) {
				start = Math.max(pace.blocked, pace.next);
				pace.next = start + spacing(instance.definition.rate);
			}
			if (start <= current) break;
			yield* Effect.sleep(start - current);
		}
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
		if ((res.status === 429 || res.status === 503) && res.retryAfter !== undefined)
			pace.blocked = Math.max(
				pace.blocked,
				(yield* Clock.currentTimeMillis) + res.retryAfter * 1000
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
					kind:
						res.status >= 400 && res.status < 500 && res.status !== 408 ? 'invalid' : 'upstream',
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
	crypto: Crypto.Crypto;
	/** The engine's wake: a message a sync write sent is queued for delivery at `at`. */
	announce: (at: string) => Effect.Effect<void>;
};
/**
 * One sync body (`syncRead`, `syncWrite`, target `'<model>.<sync>'`) or a definition's `test` (`integration`) in the guest,
 * for `instance`: workspace reads, `request` through the instance (`key` its `Idempotency-Key`) and, for a conversation
 * definition, `send` through it (a retried write with the same `key` queues the same message once).
 */
export const integrationBody = (
	cfg: BodyConfig,
	options: {
		id: string;
		actor: EngineActor;
		kind: InvocationKind;
		target: string;
		args: readonly Json[];
		instance: string;
		key?: string;
		configuration: Json;
	}
) =>
	Effect.gen(function* () {
		const bindings = yield* cfg.bindings();
		const known = instancesOf(cfg.manifest, cfg.db, { ids: [options.instance] }).pipe(
			Effect.map(([first]) => first)
		);
		let sends = 0;
		const send = (message: Json) =>
			Effect.gen(function* (): Effect.fn.Return<CrossAnswer, EngineError> {
				const prepared = yield* prepareSend(
					cfg.manifest,
					cfg.db,
					options.instance,
					message,
					cfg.crypto
				);
				if ('error' in prepared) return fail('invalidInput', prepared.error);
				const id = stableId('sync.send', options.key ?? options.id, String(sends++)),
					c = new Chain();
				sendPiece(
					c,
					{ ...prepared, id, ...(options.key === undefined ? {} : { syncWrite: options.key }) },
					bindings.now
				);
				yield* cfg.db.write(c.sql('NULL AS outcome'));
				yield* cfg.announce(bindings.now);
				return { ok: true, value: id };
			});
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
							const done =
								call._tag === 'request' && call.to === null
									? instanceRequest(cfg, options.instance, call.operation, known, options.key)
									: call._tag === 'send' && options.kind === 'syncWrite'
										? send(call.message)
										: undefined;
							return done === undefined
								? Effect.succeed(
										fail('unsupported', `an integration body cannot ${call._tag} here`)
									)
								: done.pipe(
										Effect.catch((error) =>
											Effect.succeed(
												fail(error._tag === 'BoltError' ? error.code : 'internal', error.message)
											)
										)
									);
						},
						// a write's sends keep their order (their ids are numbered)
						{ concurrency: options.kind === 'syncWrite' ? 1 : 'unbounded' }
					);
				})
		};
		const result = yield* cfg.guest.invoke(
			{
				id: options.id,
				kind: options.kind,
				target: options.target,
				input: options.kind === 'integration' ? [...options.args] : (options.args[0] ?? null),
				ctx: {
					actor: options.actor,
					now: bindings.now,
					today: bindings.today,
					tz: bindings.tz,
					seed: options.id,
					instance: options.instance,
					...(options.key === undefined ? {} : { key: options.key }),
					configuration: options.configuration
				},
				budget: {
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
