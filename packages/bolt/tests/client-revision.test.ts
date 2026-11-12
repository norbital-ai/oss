// Writes carry the row revision the editor read, even after another query sees a newer row.
import { Effect, Schema } from 'effect';
import { expect, it } from '@effect/vitest';
import { create_bolt } from '../src/page/bolt.ts';
import { ActBody, QBody, type WireRead } from '../src/protocol/schema.ts';

const Call = Schema.Union([QBody, ActBody]);
const Jobs = Schema.Struct({
	jobs: Schema.Struct({
		rows: Schema.Array(Schema.Struct({ id: Schema.String, revision: Schema.Number, title: Schema.String })),
		next: Schema.NullOr(Schema.String),
		total: Schema.Number
	})
});
const present = <A>(value: A | undefined): A => {
	if (value === undefined) throw new Error('Missing recorded request');
	return value;
};

it.effect('a read request supplies the row revision an update sends as its target', () =>
	Effect.gen(function* () {
		const sent: { url: string; body: typeof Call.Type }[] = [];
		const fetch: typeof globalThis.fetch = async (url, init) => {
			const request = new Request(url, init);
			const body = Schema.decodeUnknownSync(Call)(await request.json());
			sent.push({ url: request.url, body });
			if ('reads' in body)
				return Response.json({
					answers: [{ jobs: { rows: [{ id: 'j1', revision: 3, title: 'live' }], next: null, total: 1 } }]
				});
			return Response.json({
				outcome: { kind: 'refused', code: 'invalid_input', message: 'no' },
				v: 0
			});
		};
		const bolt = yield* create_bolt({
			operation_outputs: { automations: {} },
			base: 'https://workspace.test',
			actor: null,
			locale: 'en',
			fetch
		});
		const request = { jobs: { where: { id: { eq: 'j1' } } } };
		const answer = yield* bolt.native_query({ m: 'query', a: [request] }, Jobs);
		expect(answer).toMatchObject({
			jobs: { rows: [{ revision: 3, title: 'live' }] }
		});
		expect(Schema.decodeUnknownSync(QBody)(present(sent[0]).body).reads[0]).toEqual({
			m: 'query',
			a: [request]
		});
		yield* Effect.flip(bolt.act({ 'jobs.update': [{ target: present(answer.jobs.rows[0]), set: { title: 'x' } }] }));
		expect(Schema.decodeUnknownSync(ActBody)(present(sent[1]).body)).toMatchObject({
			acts: { 'jobs.update': [{ target: { id: 'j1', revision: 3, title: 'live' }, set: { title: 'x' } }] }
		});
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
						? { answers: [{ jobs: { rows: [{ id: 'j1', revision, title: 'live' }], next: null, total: 1 } }] }
						: {
								outcome: {
									kind: 'conflict',
									records: [{ model: 'jobs', id: 'j1' }]
								},
								v: 0
							}
				);
			};
			const bolt = yield* create_bolt({
				operation_outputs: { automations: {} },
				base: 'https://workspace.test',
				actor: null,
				locale: 'en',
				fetch
			});
			const read: WireRead = { m: 'query', a: [{ jobs: { where: { id: { eq: 'j1' } } } }] };
			const opened = yield* bolt.native_query(read, Jobs);
			const target = present(opened.jobs.rows[0]);
			revision = 4;
			yield* bolt.native_query(read, Jobs);
			const outcome = yield* Effect.flip(
				bolt.act({ 'jobs.update': [{ target, set: { title: 'draft' } }] })
			);
			expect(sent[2]).toMatchObject({
				acts: { 'jobs.update': [{ target: { id: 'j1', revision: 3, title: 'live' }, set: { title: 'draft' } }] }
			});
			expect(outcome._tag).toBe('ActConflict');
		})
);
