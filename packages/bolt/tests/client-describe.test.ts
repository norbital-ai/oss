import { Effect } from 'effect';
import { expect, it } from '@effect/vitest';
import { create_bolt } from '../src/page/bolt.ts';

it.effect('describe exists only with AI, streams progress steps over SSE, and returns where/order_by', () =>
	Effect.gen(function* () {
		const sent: { url: string; body: unknown }[] = [];
		const sse = (events: readonly unknown[]) =>
			new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
				status: 200,
				headers: { 'content-type': 'text/event-stream' }
			});
		let events: unknown[] = [
			{ t: 'step', step: { id: 'think-1', label: 'Understanding request…', status: 'running' } },
			{ t: 'step', step: { id: 'think-1', label: 'Understood request', status: 'done' } },
			{
				t: 'done',
				where: { status: { eq: 'open' } },
				order_by: { created_at: 'desc' },
				steps: [{ id: 'think-1', label: 'Understood request', status: 'done' }]
			}
		];
		const fetch: typeof globalThis.fetch = async (url, init) => {
			const req = new Request(url, init);
			sent.push({ url: req.url, body: await req.json() });
			return sse(events);
		};
		expect(
			(yield* create_bolt({ operation_outputs: { automations: {} }, actor: null, locale: 'en', base: 'https://workspace.test', fetch }))
				.describe
		).toBeUndefined();
		const bolt = yield* create_bolt({
			operation_outputs: { automations: {} },
			actor: null,
			locale: 'en',
			base: 'https://workspace.test',
			fetch,
			describe: true
		});
		if (bolt.describe === undefined) throw new Error('expected describe');
		const seen: unknown[] = [];
		expect(
			yield* bolt.describe('jobs', 'open jobs, newest first', undefined, (step) => seen.push(step))
		).toEqual({
			where: { status: { eq: 'open' } },
			order_by: { created_at: 'desc' },
			steps: [{ id: 'think-1', label: 'Understood request', status: 'done' }]
		});
		expect(seen).toEqual([
			{ id: 'think-1', label: 'Understanding request…', status: 'running' },
			{ id: 'think-1', label: 'Understood request', status: 'done' }
		]);
		expect(sent[0]).toMatchObject({
			url: 'https://workspace.test/__bolt/filter/describe',
			body: { model: 'jobs', text: 'open jobs, newest first' }
		});
		// a sort alone is an answer: there is no condition to return
		events = [{ t: 'done', order_by: { title: 'asc' } }];
		expect(yield* bolt.describe('jobs', 'sort by title')).toEqual({ order_by: { title: 'asc' } });
		events = [
			{
				t: 'error',
				code: 'invalid',
				message: 'Could not build a filter from that description.'
			}
		];
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
		const bolt = yield* create_bolt({
			operation_outputs: { automations: {} },
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
