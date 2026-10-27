// A read request's rows feed the live revision ledger an update observes; an editor keeps its draft's revision (rule 25).
import { Effect, Schema } from 'effect';
import { expect, it } from '@effect/vitest';
import { createBolt } from '../src/page/bolt.ts';
import { ActBody, QBody } from '../src/protocol/schema.ts';

const Call = Schema.Union([QBody, ActBody]);
const present = <A>(value: A | undefined): A => {
	if (value === undefined) throw new Error('Missing recorded request');
	return value;
};

it.effect('a read request records the live revision; an update sends it as observed', () =>
	Effect.gen(function* () {
		const sent: { url: string; body: typeof Call.Type }[] = [];
		const fetch: typeof globalThis.fetch = async (url, init) => {
			const request = new Request(url, init);
			const body = Schema.decodeUnknownSync(Call)(await request.json());
			sent.push({ url: request.url, body });
			if ('reads' in body)
				return Response.json({
					answers: [{ jobs: { rows: [{ id: 'j1', revision: 3, title: 'live' }], next: null } }]
				});
			return Response.json({
				outcome: { kind: 'refused', code: 'invalidInput', message: 'no' },
				v: 0
			});
		};
		const bolt = yield* createBolt({
			base: 'https://workspace.test',
			actor: null,
			locale: 'en',
			fetch
		});
		const request = { jobs: { where: { id: { eq: 'j1' } } } };
		expect(yield* bolt.query(request)).toMatchObject({
			jobs: { rows: [{ revision: 3, title: 'live' }] }
		});
		expect(Schema.decodeUnknownSync(QBody)(present(sent[0]).body).reads[0]).toEqual({
			m: 'query',
			a: [request]
		});
		yield* Effect.flip(bolt.act('jobs.update', [{ target: 'j1', set: { title: 'x' } }]));
		expect(Schema.decodeUnknownSync(ActBody)(present(sent[1]).body).observed).toEqual({ j1: 3 });
	})
);

it.effect(
	'an editor observes the revision its draft started from even after another read refreshes the ledger',
	() =>
		Effect.gen(function* () {
			const sent: (typeof Call.Type)[] = [];
			let revision = 3;
			const fetch: typeof globalThis.fetch = async (url, init) => {
				const body = Schema.decodeUnknownSync(Call)(await new Request(url, init).json());
				sent.push(body);
				return Response.json(
					'reads' in body
						? { answers: [{ jobs: { rows: [{ id: 'j1', revision, title: 'live' }], next: null } }] }
						: {
								outcome: {
									kind: 'conflict',
									records: [{ model: 'jobs', id: 'j1', fields: ['title'] }]
								},
								v: 0
							}
				);
			};
			const bolt = yield* createBolt({
				base: 'https://workspace.test',
				actor: null,
				locale: 'en',
				fetch
			});
			const request = { jobs: { where: { id: { eq: 'j1' } } } };
			yield* bolt.query(request);
			revision = 4;
			yield* bolt.query(request);
			const outcome = yield* Effect.flip(
				bolt.act('jobs.update', [{ target: 'j1', set: { title: 'draft' } }], { observed: { j1: 3 } })
			);
			expect(sent[2]).toMatchObject({ observed: { j1: 3 } });
			expect(outcome._tag).toBe('ActConflict');
		})
);
