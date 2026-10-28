// `$search` and `$similar` as predicates (rule 16): a row's search document holds every word of the text (prefixes and
// slipped spellings), or it is among the `top` nearest in meaning. Both nest under a relation like any condition, and
// a caller matches only the values it reads unmasked (rule 14).
import { expect, layer } from '@effect/vitest';
import { Context, Effect, Layer, Result, Schema, Stream } from 'effect';
import type { ActOutcome as Outcome } from '../src/engine/contracts.ts';
import type { Json } from '../src/decl/values.ts';
import { Ai } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { decodeProjectedManifest } from '../src/engine/manifest.ts';
import { actReply, qReply, routeFixture } from './support/route-fixture.ts';
import { embedRun } from '../src/engine/integrations/embed.ts';
import { respondSystem1, TestWorkspace, type WorkspaceServices } from '../src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeProjectedManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			sites: {
				description: 'A site',
				label: 'name',
				fields: { name: { kind: 'text' }, address: { kind: 'text' } },
				search: { text: ['name', 'address'] }
			},
			jobs: {
				description: 'A job',
				label: 'title',
				fields: { title: { kind: 'text' }, notes: { kind: 'text', optional: true } },
				search: {
					text: ['title', 'notes', 'site'],
					semantic: { fields: ['title'], model: 'small', dim: 3 }
				}
			}
		},
		relationships: { 'jobs.site': { to: 'sites', inverse: 'jobs' } },
		exposures: {
			sites: {
				read: { sites: { fields: 'all' } },
				create: { columns: { sites: ['name', 'address'] } }
			},
			jobs: {
				read: { jobs: { fields: 'all' }, 'jobs.site': { fields: 'all' } },
				create: { columns: { jobs: ['title', 'notes', 'site'] } }
			}
		},
		// `notes` is masked to the dispatcher: its one jobs arm lists the fields it reads
		policies: {
			dispatch: {
				description: 'Dispatch',
				grants: {
					sites: { read: true },
					jobs: { read: { jobs: { fields: ['id', 'title', 'site', 'created_at', 'updated_at'] } } }
				}
			}
		},
		integrations: {},
		teams: {},
		automations: {},
		connections: {},
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {},
		agent: { skills: {} }
	})
);

const created = (o: Outcome) => {
	if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
	const id = o.records[0]?.id;
	if (id === undefined) throw new Error('create returned no record');
	return id;
};
const near: { [text: string]: number[] } = {
	'water leak': [1, 0, 0],
	'burst pipe': [0.95, 0.05, 0],
	'roof drip': [0.8, 0.2, 0],
	'paint wall': [0, 0, 1],
	'door hinge': [0, 1, 0]
};
const embed: Ai['Service']['embed'] = (inputs) =>
	Effect.sync(() =>
		inputs.map((input) => near[typeof input === 'string' ? input : ''] ?? [0, 0.5, 0.5])
	);
const Page = Schema.Struct({ rows: Schema.Array(Schema.Struct({ title: Schema.String })) });
const ports = Layer.succeed(Ai, {
	ask: respondSystem1,
	maxChoices: undefined,
	models: ['default'],
	catalog: Port.unavailable('ai.catalog'),
	infer: () => Stream.fail(Port.failure('ai')(new Error('unused'))),
	embed
});
const workspace = () =>
	Effect.gen(function* () {
		const context = yield* Effect.context<TestWorkspace | WorkspaceServices>();
		const t = Context.get(context, TestWorkspace),
			route = yield* routeFixture(context),
			a = t.as(t.admin).authority;
		const act = (callable: string, input: Json) =>
			actReply(route, a, { callable, input, issuedAt: t.clock.now() }).pipe(
				Effect.map((reply) => reply.outcome)
			);
		const titles = (where: Json, who = a) =>
			Effect.gen(function* () {
				const reply = yield* qReply(route, who, {
					reads: [{ m: 'query', a: [{ jobs: { where, fields: ['title'] } }] }]
				});
				return (yield* Schema.decodeUnknownEffect(Schema.Struct({ jobs: Page }))(
					reply.answers[0]
				)).jobs.rows
					.map((row) => row.title)
					.sort();
			});
		const ranked = (search: string) =>
			Effect.gen(function* () {
				const reply = yield* qReply(route, a, {
					reads: [{ m: 'query', a: [{ jobs: { search, fields: ['title'], limit: 10 } }] }]
				});
				return (yield* Schema.decodeUnknownEffect(Schema.Struct({ jobs: Page }))(
					reply.answers[0]
				)).jobs.rows
					.map((row) => row.title)
					.sort();
			});
		return { context, act, titles, ranked, dispatcher: t.as(t.member(['dispatch'])).authority };
	});
// every test reads the same rows: seeded once per file
const seeded = Layer.effectDiscard(
	Effect.scoped(
		Effect.gen(function* () {
			const { act, context } = yield* workspace();
			const pine = created(
				yield* act('sites.create', [{ name: '1F Pine Grove', address: '3 Ridgewood Close' }])
			);
			const vale = created(
				yield* act('sites.create', [{ name: 'Sunset Vale', address: '12 Jalan Bukit' }])
			);
			for (const [title, site, notes] of [
				['burst pipe', pine, 'Kitchen sink'],
				['roof drip', vale, null],
				['paint wall', pine, null],
				['door hinge', vale, 'secret code 1234']
			] as const)
				yield* act('jobs.create', [{ title, site, ...(notes === null ? {} : { notes }) }]);
			const embedRows = yield* embedRun.pipe(Effect.provide(context));
			yield* embedRows({}, { id: crypto.randomUUID(), starter: null }).pipe(Effect.provide(context));
		})
	)
).pipe(Layer.provideMerge(TestWorkspace.layer({ manifest, ports })));

layer(seeded, { excludeTestServices: true })('$search and $similar (rule 16)', (it) => {
	it.effect(
		'$search: every word, each a prefix or a slipped spelling, over every searched field',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { titles } = yield* workspace();
					expect(yield* titles({ $search: 'pipe' })).toEqual(['burst pipe']);
					expect(yield* titles({ $search: 'kitchen pipe' })).toEqual(['burst pipe']); // a word in notes, a word in title
					expect(yield* titles({ $search: 'brust pipe' })).toEqual(['burst pipe']); // a slipped spelling
					expect(yield* titles({ $search: 'pipe paint' })).toEqual([]); // every word, not any
				})
			)
	);

	it.effect("a link in search.text finds the row by the linked record's own search text", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { titles, ranked } = yield* workspace();
				expect(yield* titles({ $search: 'ridgewood' })).toEqual(['burst pipe', 'paint wall']);
				expect(yield* ranked('sunset')).toEqual(['door hinge', 'roof drip']);
				expect(yield* ranked('pipe')).toEqual(['burst pipe']); // its own words still match
				// every word in one document: the row's own, or one linked row's
				expect(yield* titles({ $search: 'pipe ridgewood' })).toEqual([]);
			})
		)
	);

	it.effect('nests under a relation and composes with other conditions', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { titles } = yield* workspace();
				expect(yield* titles({ site: { is: { $search: 'pine grove' } } })).toEqual([
					'burst pipe',
					'paint wall'
				]);
				expect(
					yield* titles({ site: { is: { $search: 'ridgewood' } }, title: { like: '%paint%' } })
				).toEqual(['paint wall']);
				expect(yield* titles({ not: { site: { is: { $search: "sunset vale's" } } } })).toEqual([
					'burst pipe',
					'paint wall'
				]);
			})
		)
	);

	it.effect(
		'$similar: the nearest in meaning and every row nearly as near, at most top, embedded once before the read',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { titles } = yield* workspace();
					// door hinge and paint wall are far from the nearest: outside the band, though top would admit them
					expect(yield* titles({ $similar: 'water leak' })).toEqual(['burst pipe', 'roof drip']);
					expect(yield* titles({ $similar: { to: 'water leak', top: 1 } })).toEqual(['burst pipe']);
					expect(
						yield* titles({
							$similar: { to: 'water leak', top: 2 },
							site: { is: { $search: 'vale' } }
						})
					).toEqual(['roof drip']);
				})
			)
	);

	it.effect(
		'refuses a model without the index; a caller matches only the covered values it reads',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { titles, dispatcher } = yield* workspace();
					expect((yield* Effect.flip(titles({ site: { is: { $similar: 'x' } } }))).message).toMatch(
						/declares no search.semantic/
					);
					expect((yield* Effect.flip(titles({ $search: '' }))).message).toMatch(/1–500 characters/);
					// `notes` is in jobs' search document: a caller it is masked to matches only what it reads, never "secret code"
					expect(yield* titles({ $search: 'secret' }, dispatcher)).toEqual([]);
					expect(yield* titles({ $search: 'pipe' }, dispatcher)).toEqual(['burst pipe']);
					expect(yield* titles({ $similar: { to: 'water leak', top: 1 } }, dispatcher)).toEqual([
						'burst pipe'
					]); // the embedding covers title only
					expect(yield* titles({ site: { is: { $search: 'pine' } } }, dispatcher)).toEqual([
						'burst pipe',
						'paint wall'
					]);
				})
			)
	);
});
