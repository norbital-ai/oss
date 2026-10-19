// A historical get never moves the live revision ledger used by a subsequent update (rule 25).
import { Effect, Schema } from 'effect';
import { expect, it } from '@effect/vitest';
import { createBolt } from '../src/page/bolt.ts';
import { ActBody, QBody } from '../src/protocol/schema.ts';

const Call = Schema.Union([QBody, ActBody]);
const Revision = Schema.Struct({ revision: Schema.optionalKey(Schema.Number) });
const present = <A>(value: A | undefined): A => {
	if (value === undefined) throw new Error('Missing recorded request');
	return value;
};

it.effect('a revision get sends { revision } and leaves the ledger at the live revision', () =>
	Effect.gen(function* () {
		const sent: { url: string; body: typeof Call.Type }[] = [];
		const fetch: typeof globalThis.fetch = async (url, init) => {
			const request = new Request(url, init);
			const body = Schema.decodeUnknownSync(Call)(await request.json());
			sent.push({ url: request.url, body });
			if ('reads' in body) {
				const read = present(body.reads[0]);
				const revision = Schema.decodeUnknownSync(Revision)(read.a[2] ?? {}).revision;
				return Response.json({
					answers: [
						{ id: 'j1', revision: revision ?? 3, title: revision === undefined ? 'live' : 'past' }
					]
				});
			}
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
		expect(yield* bolt.get('jobs', 'j1')).toMatchObject({ revision: 3, title: 'live' });
		expect(yield* bolt.get('jobs', 'j1', undefined, { revision: 1 })).toMatchObject({
			revision: 1,
			title: 'past'
		});
		expect(Schema.decodeUnknownSync(QBody)(present(sent[1]).body).reads[0]).toEqual({
			m: 'get',
			a: ['jobs', 'j1', { revision: 1 }]
		});
		expect(Schema.decodeUnknownSync(QBody)(present(sent[0]).body).reads[0]).toEqual({
			m: 'get',
			a: ['jobs', 'j1']
		});
		yield* Effect.flip(bolt.act('jobs.update', { target: 'j1', set: { title: 'x' } }));
		expect(Schema.decodeUnknownSync(ActBody)(present(sent[2]).body).observed).toEqual({ j1: 3 });
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
						? { answers: [{ id: 'j1', revision, title: 'live' }] }
						: {
								outcome: {
									kind: 'conflict',
									records: [{ collection: 'jobs', id: 'j1', fields: ['title'] }]
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
			yield* bolt.get('jobs', 'j1');
			revision = 4;
			yield* bolt.get('jobs', 'j1');
			const outcome = yield* Effect.flip(
				bolt.act('jobs.update', { target: 'j1', set: { title: 'draft' } }, { observed: { j1: 3 } })
			);
			expect(sent[2]).toMatchObject({ observed: { j1: 3 } });
			expect(outcome._tag).toBe('ActConflict');
		})
);
