import { expect, it } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { Effect, Layer, Schema } from 'effect';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FacilitiesLive, localFiles } from '../src/engine/facilities.ts';
import {
	DecisionsLive,
	DecisionTrace,
	type DecisionRequest,
	type DecisionResult
} from '../src/engine/decisions/index.ts';
import { Facilities, Manifest, Decisions } from '../src/engine/services.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { Ai, Convert, Files, Geo, Metering, Speech, WebRead } from '../src/engine/ports.ts';
import type { Sql } from '../src/engine/contracts.ts';
import { FacilityFailure } from '../src/decl/errors.ts';
import { DbError } from '../src/engine/errors.ts';
import { Port } from '../src/engine/port.ts';
import { manifest } from './catalogue-fixture.ts';

/** The one `sys_event` row a statement writes (`eventsPiece`'s recordset). */
const eventOf = (statement: Sql | undefined) =>
	Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Json)))(
		statement?.params[0]
	)[0];

it.effect('web.read keeps raw options across the facility dispatch boundary', () => {
	const calls: unknown[] = [];
	const db = TenantDb.typed({
		read: () => Effect.succeed([]),
		write: () => Effect.succeed({ rows: [], affected: 0 }),
		transaction: () => Effect.fail(DbError.make('XX000', 'this test opens no transaction'))
	});
	const ports = Layer.mergeAll(
		Layer.succeed(TenantDb, db),
		Layer.succeed(Manifest, manifest),
		Layer.succeed(Decisions, { decide: () => Port.unavailable('ai') }),
		Files.unavailable,
		Convert.unavailable,
		Speech.unavailable,
		Ai.unavailable,
		Geo.unavailable,
		Layer.succeed(WebRead, {
			read: (url, options) =>
				Effect.sync(() => {
					calls.push([url, options]);
					return { url, title: null, text: 'page', html: '<p>page</p>' };
				})
		})
	);
	return Effect.gen(function* () {
		const facilities = yield* Facilities;
		expect(
			yield* facilities.dispatch({
				_tag: 'web.read',
				args: ['https://example.test/', { raw: true }]
			})
		).toMatchObject({ ok: true, value: { html: '<p>page</p>' } });
		expect(calls).toEqual([['https://example.test/', { raw: true }]]);
	}).pipe(Effect.provide(FacilitiesLive.pipe(Layer.provide(ports))));
});

it.effect(
	'authored decisions project score labels without changing native answers or tracing',
	() => {
		const request: DecisionRequest = {
			state: { evidence: 'The signed acceptance names this delivery.' },
			questions: {
				evidence: {
					type: 'score',
					instructions: 'How direct is the evidence?',
					criteria: ['No evidence', 'Indirect evidence', 'Clear direct evidence']
				},
				action: { type: 'choice', instructions: 'What next?', criteria: { accept: 'Accept it' } },
				signed: {
					type: 'noul',
					instructions: 'Is it signed?',
					criteria: { true: 'Signed', false: 'Unsigned' }
				}
			}
		};
		const result: DecisionResult = {
			answers: {
				evidence: {
					type: 'score',
					score: 1.9,
					level: 2,
					confidence: 0.9,
					probabilities: { 0: 0, 1: 0.1, 2: 0.9 },
					legend: { 0: 'No evidence', 1: 'Indirect evidence', 2: 'Clear direct evidence' }
				},
				action: { type: 'choice', choice: 'accept', confidence: 1, probabilities: { accept: 1 } },
				signed: { type: 'noul', noul: 1 }
			},
			costUsd: 0.0004,
			provider: 'scripted',
			tokens: { input: 120, output: 40 }
		};
		const requests: DecisionRequest[] = [];
		const writes: Sql[] = [];
		const metered: { meter: string; quantity: number; key: string }[] = [];
		let mode: 'ok' | 'refused' | 'offlist' = 'ok';
		const ai = Layer.effect(
			Ai,
			Effect.gen(function* () {
				const absent = yield* Ai;
				return Ai.of({
					...absent,
					ask: (given) =>
						Effect.gen(function* () {
							requests.push(given);
							if (mode === 'refused')
								return yield* Effect.fail(
									new FacilityFailure({
										kind: 'tooLarge',
										message: 'State exceeds context',
										status: 413
									})
								);
							if (mode === 'offlist') {
								const offlist: DecisionResult = {
									...result,
									answers: {
										...result.answers,
										evidence: {
											type: 'score',
											score: 4,
											level: 4,
											confidence: 1,
											probabilities: { 4: 1 },
											legend: {}
										}
									}
								};
								return offlist;
							}
							return result;
						})
				});
			})
		).pipe(Layer.provide(Ai.unavailable));
		const ports = Layer.mergeAll(
			NodeCrypto.layer,
			Layer.succeed(
				TenantDb,
				TenantDb.typed({
					read: () => Effect.fail(DbError.make('XX000', 'Decisions read no database rows')),
					write: (statement) =>
						Effect.sync(() => {
							writes.push(statement);
							return { rows: [], affected: 1 };
						}),
					transaction: () => Effect.fail(DbError.make('XX000', 'Decisions open no transaction'))
				})
			),
			Layer.succeed(Manifest, manifest),
			Layer.succeed(Metering, {
				record: (meter, quantity, key) =>
					Effect.sync(() => {
						metered.push({ meter, quantity, key });
					})
			}),
			ai,
			Files.unavailable,
			Convert.unavailable,
			Speech.unavailable,
			Geo.unavailable,
			WebRead.unavailable
		);
		const services = DecisionsLive.pipe(Layer.provideMerge(ports));
		return Effect.gen(function* () {
			const decisions = yield* Decisions;
			const facilities = yield* Facilities;
			expect(yield* decisions.decide('filter', request)).toEqual(result);
			const dispatch = facilities.dispatch({ _tag: 'ai.sys_1.decide', args: [request] }).pipe(
				Effect.provideService(DecisionTrace, {
					invocation: 'run-1:1',
					run: 'run-1',
					automation: 'route'
				})
			);
			for (let index = 0; index < 2; index++)
				expect(yield* dispatch).toEqual({
					ok: true,
					value: {
						answers: {
							...result.answers,
							evidence: { ...result.answers.evidence, level: 'Clear direct evidence' }
						},
						costUsd: result.costUsd
					}
				});
			expect(result.answers.evidence).toMatchObject({ level: 2 });
			expect(eventOf(writes[0])).toMatchObject({
				severity: 'info',
				invocation: expect.any(String),
				run: null,
				attributes: { use: 'filter', answers: result.answers }
			});
			for (const statement of writes.slice(1))
				expect(eventOf(statement)).toMatchObject({
					severity: 'info',
					invocation: 'run-1:1',
					run: 'run-1',
					attributes: { use: 'author', automation: 'route', run: 'run-1', answers: result.answers }
				});
			expect(metered).toHaveLength(3);
			expect(new Set(metered.map(({ key }) => key)).size).toBe(3);
			expect(
				metered.every(
					({ meter, quantity, key }) =>
						meter === 'ai' && quantity === result.costUsd && key.startsWith('decision:')
				)
			).toBe(true);
			mode = 'refused';
			expect(yield* dispatch).toEqual({
				ok: false,
				error: { kind: 'tooLarge', message: 'State exceeds context', status: 413 }
			});
			expect(eventOf(writes[3])).toMatchObject({
				severity: 'warn',
				invocation: 'run-1:1',
				run: 'run-1',
				attributes: {
					use: 'author',
					automation: 'route',
					run: 'run-1',
					error: 'tooLarge',
					status: 413
				}
			});
			mode = 'offlist';
			expect(yield* dispatch).toMatchObject({ ok: false, error: { kind: 'invalid' } });
			expect(eventOf(writes[4])).toMatchObject({
				severity: 'warn',
				invocation: 'run-1:1',
				run: 'run-1',
				attributes: { error: 'invalid', automation: 'route' }
			});
			expect(
				yield* facilities.dispatch({
					_tag: 'ai.sys_1.decide',
					args: [{ state: {}, questions: {} }]
				})
			).toMatchObject({ ok: false, error: { kind: 'invalid' } });
			expect(requests).toEqual([request, request, request, request, request]);
			expect(writes).toHaveLength(5);
			expect(metered).toHaveLength(3);
		}).pipe(Effect.provide(FacilitiesLive.pipe(Layer.provideMerge(services))));
	}
);

it.live('local files store a real sha256 of their bytes', () =>
	Effect.acquireUseRelease(
		Port.attempt('files', async () => {
			const root = join(tmpdir(), 'norbital-scratch');
			await mkdir(root, { recursive: true });
			return mkdtemp(join(root, 'facilities-'));
		}),
		(dir) =>
			Effect.gen(function* () {
				const files = localFiles(dir),
					bytes = new TextEncoder().encode('a stored document');
				const result = yield* files.put(bytes, { name: 'a.txt', mime: 'text/plain' });
				expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
				expect(yield* files.get(result.key, 100)).toEqual(bytes);
			}),
		(dir) =>
			Port.attempt('files', () => rm(dir, { recursive: true, force: true })).pipe(Effect.orDie)
	)
);
