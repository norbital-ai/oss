import { expect, it } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { Effect, Layer } from 'effect';
import { FacilitiesLive } from '../src/engine/facilities.ts';
import {
	DbError,
	type DecisionRequest,
	type DecisionResult,
	type EmbedInput,
	FacilityFailure,
	type LogEvent,
	off,
	Port
} from '@norbital-ai/host-api';
import { DecisionsLive, DecisionTrace } from '../src/engine/decision.ts';
import { Facilities, Manifest, Decisions } from '../src/engine/services.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { Ai, Browser, Convert, Files, Geo, Images, Logs, WebRead } from '../src/engine/ports.ts';
import { images_port } from '@norbital-ai/host-api/node';
import { refused_files } from './support/refused.ts';
import { manifest } from './catalogue-fixture.ts';

it.effect(
	'embedding files cross as authoritative stored references without loading their media into the Cell',
	() => {
		const stored = {
			id: 'photo',
			key: 'tenant/photo',
			name: 'actual.jpg',
			mime: 'image/jpeg',
			size: 90 * 1024 * 1024,
			sha256: 'digest',
			field: 'photos.image'
		};
		const db = TenantDb.typed({
			read: () => Effect.succeed([{ rows: [stored], affected: 1 }]),
			write: () => Effect.fail(DbError.make('XX000', 'embedding writes no database rows')),

			transaction: () => Effect.fail(DbError.make('XX000', 'embedding opens no transaction'))
		});
		const received: (readonly EmbedInput[])[] = [];
		const ai = Layer.effect(
			Ai,
			Effect.gen(function* () {
				const absent = yield* Ai;
				return Ai.of({
					...absent,
					embed: (inputs) =>
						Effect.sync(() => {
							received.push(inputs);
							return inputs.map(() => [0.5]);
						})
				});
			})
		).pipe(Layer.provide(Ai.fromAbi({ system1: off, system2: off, embed: off })));
		const ports = Layer.mergeAll(
			Layer.succeed(TenantDb, db),
			Layer.succeed(Manifest, manifest),
			Layer.succeed(Decisions, { decide: () => Port.unavailable('ai') }),
			ai,
			Files.fromAbi(refused_files),
			Images.fromAbi(images_port),
			Convert.fromAbi(off),
			Browser.fromAbi(off),

			Geo.fromAbi(off),
			WebRead.fromAbi(off)
		);
		return Effect.gen(function* () {
			const facilities = yield* Facilities;
			expect(
				yield* facilities.dispatch({
					_tag: 'ai.embed',
					args: [
						[
							'text',
							{ id: stored.id, name: 'caller.jpg', mime: 'caller/mime' },
							{ id: stored.id, name: 'caller.jpg', mime: 'caller/mime' }
						]
					]
				})
			).toEqual({ ok: true, value: [[0.5], [0.5], [0.5]] });
			const file = {
				$stored: {
					key: stored.key,
					name: stored.name,
					mime: stored.mime,
					sha256: stored.sha256,
					bytes: stored.size
				}
			};
			expect(received).toEqual([['text', file, file]]);
		}).pipe(Effect.provide(FacilitiesLive.pipe(Layer.provide(ports))));
	}
);

it.effect('web.read keeps raw options across the facility dispatch boundary', () => {
	const calls: unknown[] = [];
	const db = TenantDb.typed({
		read: () => Effect.fail(DbError.make('XX000', 'this test reads no database')),
		write: () => Effect.fail(DbError.make('XX000', 'this test writes no database')),

		transaction: () => Effect.fail(DbError.make('XX000', 'this test opens no transaction'))
	});
	const ports = Layer.mergeAll(
		Layer.succeed(TenantDb, db),
		Layer.succeed(Manifest, manifest),
		Layer.succeed(Decisions, { decide: () => Port.unavailable('ai') }),
		Files.fromAbi(refused_files),
		Images.fromAbi(images_port),
		Convert.fromAbi(off),
		Browser.fromAbi(off),

		Ai.fromAbi({ system1: off, system2: off, embed: off }),
		Geo.fromAbi(off),
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
					criteria: [
						'No evidence',
						{ description: 'Indirect evidence' },
						{ description: 'Clear direct evidence' }
					]
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
					legend: {
						0: 'No evidence',
						1: { description: 'Indirect evidence' },
						2: { description: 'Clear direct evidence' }
					}
				},
				action: { type: 'choice', choice: 'accept', confidence: 1, probabilities: { accept: 1 } },
				signed: { type: 'noul', noul: 1 }
			},
			cost_usd: 0.0004,
			provider: 'scripted',
			tokens: { input: 120, output: 40 }
		};
		const requests: DecisionRequest[] = [];
		const written: LogEvent[] = [];
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
										kind: 'too_large',
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
		).pipe(Layer.provide(Ai.fromAbi({ system1: off, system2: off, embed: off })));
		const ports = Layer.mergeAll(
			NodeCrypto.layer,
			Layer.succeed(
				TenantDb,
				TenantDb.typed({
					read: () => Effect.fail(DbError.make('XX000', 'Decisions read no database rows')),
					write: () => Effect.fail(DbError.make('XX000', 'Decisions write no database rows')),

					transaction: () => Effect.fail(DbError.make('XX000', 'Decisions open no transaction'))
				})
			),
			Layer.succeed(Manifest, manifest),
			ai,
			Files.fromAbi(refused_files),
			Images.fromAbi(images_port),
			Convert.fromAbi(off),
			Browser.fromAbi(off),

			Geo.fromAbi(off),
			WebRead.fromAbi(off)
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
							evidence: {
								...result.answers.evidence,
								level: { description: 'Clear direct evidence' }
							}
						},
						cost_usd: result.cost_usd
					}
				});
			expect(result.answers.evidence).toMatchObject({ level: 2 });
			expect(written.filter((event) => event.event === 'ai.call')).toHaveLength(3);
			const traces = () => written.filter((event) => event.event === 'decision.made');
			expect(traces()[0]).toMatchObject({
				severity: 'info',
				invocation: expect.any(String),
				run: null,
				attributes: { use: 'filter', answers: result.answers }
			});
			for (const event of traces().slice(1))
				expect(event).toMatchObject({
					severity: 'info',
					invocation: 'run-1:1',
					run: 'run-1',
					attributes: { use: 'author', automation: 'route', run: 'run-1', answers: result.answers }
				});
			mode = 'refused';
			expect(yield* dispatch).toEqual({
				ok: false,
				error: { kind: 'too_large', message: 'State exceeds context', status: 413 }
			});
			expect(traces()[3]).toMatchObject({
				severity: 'warn',
				invocation: 'run-1:1',
				run: 'run-1',
				attributes: {
					use: 'author',
					automation: 'route',
					run: 'run-1',
					error: 'too_large',
					status: 413
				}
			});
			mode = 'offlist';
			expect(yield* dispatch).toMatchObject({ ok: false, error: { kind: 'invalid' } });
			expect(traces()[4]).toMatchObject({
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
			for (const question of [
				{
					type: 'noul',
					instructions: { photo: { id: 'f1', name: 'photo.png', mime: 'image/png' } }
				},
				{ type: 'choice', criteria: { photo: { id: 'f1', name: 'photo.png', mime: 'image/png' } } }
			]) {
				expect(
					yield* facilities.dispatch({
						_tag: 'ai.sys_1.decide',
						args: [{ state: {}, questions: { q: question } }]
					})
				).toMatchObject({ ok: false, error: { kind: 'invalid' } });
			}
			expect(requests).toEqual([request, request, request, request, request]);
			expect(traces()).toHaveLength(7);
			expect(written.filter((event) => event.event === 'ai.call')).toHaveLength(7);
		}).pipe(
			Effect.provide(FacilitiesLive.pipe(Layer.provideMerge(services))),
			Effect.provideService(Logs, {
				write: (event) =>
					Effect.sync(() => {
						written.push(event);
					}),
				query: () => Port.unavailable('logs')
			})
		);
	}
);
