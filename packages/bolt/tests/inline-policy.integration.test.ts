import { expect, layer } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { dynamicRead } from '../src/protocol/read-request.ts';

const manifest: EngineManifest = {
	needs: [],
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		documents: {
			description: 'A scoped document',
			label: 'name',
			fields: {
				name: { kind: 'text' },
				profile: {
					kind: 'json',
					shape: {
						kind: 'object',
						fields: {
							region: { kind: 'text' },
							rank: { kind: 'int' },
							flags: { kind: 'list', of: { kind: 'text' } }
						}
					}
				}
			}
		}
	},
	relationships: {},
	exposures: { documents: { outputs: { default: { documents: { fields: 'all' } } } } },
	policies: {
		north: {
			description: 'Only northern documents',
			grants: {
				documents: {
					outputs: { default: { scopes: { documents: { profile: { region: { eq: 'north' } } } } } }
				}
			}
		},
		south: {
			description: 'Only southern documents',
			grants: {
				documents: {
					outputs: { default: { scopes: { documents: { profile: { region: { eq: 'south' } } } } } }
				}
			}
		}
	},
	integrations: {},
	teams: {},
	automations: {},
	connections: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
};
const seed = {
	documents: [
		{
			id: '11111111-1111-4111-8111-111111111111',
			name: 'N1',
			profile: { region: 'north', rank: 2, flags: ['ready'] }
		},
		{
			id: '22222222-2222-4222-8222-222222222222',
			name: 'S1',
			profile: { region: 'south', rank: 1, flags: ['ready'] }
		},
		{
			id: '33333333-3333-4333-8333-333333333333',
			name: 'N2',
			profile: { region: 'north', rank: 2, flags: ['blocked'] }
		},
		{
			id: '44444444-4444-4444-8444-444444444444',
			name: 'N3',
			profile: { region: 'north', rank: 10, flags: ['ready'] }
		},
		{
			id: '55555555-5555-4555-8555-555555555555',
			name: 'S2',
			profile: { region: 'south', rank: 20, flags: ['ready'] }
		}
	]
};
const Answer = Schema.Struct({
	documents: Schema.Struct({
		rows: Schema.Array(Schema.Struct({ name: Schema.String })),
		next: Schema.NullOr(Schema.String),
		total: Schema.Number
	})
});

layer(TestWorkspace.layer({ manifest, seed }))(
	'inline predicates under native policy scope',
	(it) => {
		it.effect('scopes every filtered page and its full count before applying inline ordering', () =>
			Effect.gen(function* () {
				const t = yield* TestWorkspace;
				for (const [policy, expected] of [
					['north', ['N1', 'N2', 'N3']],
					['south', ['S1', 'S2']]
				] as const) {
					const actor = t.as(t.member([policy]));
					const seen: string[] = [];
					let after: string | undefined;
					for (let page = 0; page < 4; page++) {
						const answer = yield* actor.query(
							dynamicRead({
								documents: {
									where: {
										or: [
											{ profile: { region: { eq: 'north' } } },
											{ profile: { region: { eq: 'south' } } }
										]
									},
									fields: ['name'],
									orderBy: { 'profile.rank': 'asc' },
									limit: 1,
									...(after === undefined ? {} : { after })
								}
							})
						);
						const { documents } = yield* Schema.decodeUnknownEffect(Answer)(answer);
						expect(documents.total).toBe(expected.length);
						expect(documents.rows).toHaveLength(1);
						seen.push(...documents.rows.map((row) => row.name));
						after = documents.next ?? undefined;
						if (after === undefined) break;
					}
					expect(after).toBeUndefined();
					expect(seen).toEqual(expected);
				}
			})
		);

		it.effect(
			'nested list and negation conditions narrow a grant and never reveal outside rows',
			() =>
				Effect.gen(function* () {
					const t = yield* TestWorkspace;
					const actor = t.as(t.member(['north']));
					const query = dynamicRead({
						documents: {
							where: { not: { profile: { flags: { some: { eq: 'blocked' } } } } },
							fields: ['name'],
							orderBy: 'name',
							limit: 10
						}
					});
					const { documents } = yield* Schema.decodeUnknownEffect(Answer)(
						yield* actor.query(query)
					);
					expect(documents.rows.map((row) => row.name)).toEqual(['N1', 'N3']);
					expect(documents.total).toBe(2);
					const outside = dynamicRead({
						documents: { where: { profile: { region: { eq: 'south' } } }, fields: ['name'] }
					});
					expect(
						(yield* Schema.decodeUnknownEffect(Answer)(yield* actor.query(outside))).documents.rows
					).toEqual([]);
					expect(yield* Effect.flip(t.as(t.member([])).query(query))).toMatchObject({
						code: 'forbidden'
					});
				})
		);
	}
);
