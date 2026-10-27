import { Effect } from 'effect';
import { expect, it } from '@effect/vitest';
import { createBolt } from '../src/page/bolt.ts';

it.effect('describe exists only with AI and returns the committed where/orderBy', () =>
	Effect.gen(function* () {
		const sent: unknown[] = [];
		let reply: unknown = {
			outcome: {
				kind: 'committed',
				output: { where: { status: { eq: 'open' } }, orderBy: { created_at: 'desc' } },
				records: []
			},
			v: 0
		};
		const fetch: typeof globalThis.fetch = async (url, init) => {
			const body: unknown = await new Request(url, init).json();
			sent.push(body);
			return Response.json(reply);
		};
		expect(
			(yield* createBolt({ actor: null, locale: 'en', base: 'https://workspace.test', fetch }))
				.describe
		).toBeUndefined();
		const bolt = yield* createBolt({
			actor: null,
			locale: 'en',
			base: 'https://workspace.test',
			fetch,
			describe: true
		});
		if (bolt.describe === undefined) throw new Error('expected describe');
		expect(yield* bolt.describe('jobs', 'open jobs, newest first')).toEqual({
			where: { status: { eq: 'open' } },
			orderBy: { created_at: 'desc' }
		});
		expect(sent[0]).toMatchObject({
			callable: 'filter.describe',
			input: { model: 'jobs', text: 'open jobs, newest first' }
		});
		reply = {
			outcome: {
				kind: 'refused',
				code: 'invalidInput',
				message: 'Could not build a filter from that description.'
			},
			v: 0
		};
		expect((yield* Effect.flip(bolt.describe('jobs', 'x'))).message).toContain(
			'Could not build a filter'
		);
	})
);

it.effect('options returns the catalogue the builder renders', () =>
	Effect.gen(function* () {
		const sent: unknown[] = [];
		const fetch: typeof globalThis.fetch = async (url, init) => {
			const body: unknown = await new Request(url, init).json();
			sent.push(body);
			return Response.json({
				outcome: {
					kind: 'committed',
					output: {
						fields: [
							{
								label: 'Title',
								path: [{ k: 'field', name: 'title' }],
								op: 'like',
								opLabel: 'contains',
								kind: 'text'
							}
						]
					},
					records: []
				},
				v: 0
			});
		};
		const bolt = yield* createBolt({
			actor: null,
			locale: 'en',
			base: 'https://workspace.test',
			fetch
		});
		expect(bolt.options).toBeDefined();
		expect(yield* bolt.options('jobs')).toEqual({
			fields: [
				{
					label: 'Title',
					path: [{ k: 'field', name: 'title' }],
					op: 'like',
					opLabel: 'contains',
					kind: 'text'
				}
			]
		});
		expect(sent[0]).toMatchObject({ callable: 'filter.options', input: { model: 'jobs' } });
	})
);
