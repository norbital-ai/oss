import { Effect } from 'effect';
import { expect, it } from '@effect/vitest';
import { createBolt } from '../src/page/bolt.ts';
const capabilities = {
	collection: 'jobs',
	id: 'j1',
	revision: 3,
	fields: {
		title: { writable: false, proposal: false, reasons: ['integrationOwned'] },
		note: { writable: true, proposal: false, reasons: [] }
	},
	update: { allowed: true, proposal: false, reasons: [] },
	delete: { allowed: false, proposal: false, reasons: ['noGrant'] },
	moves: {},
	proposalMoves: {}
};
it.effect('loads and validates the native current-row capability projection', () =>
	Effect.gen(function* () {
		let request: { url: string; credentials: unknown } | undefined;
		const fetch: typeof globalThis.fetch = async (url, init) => {
			request = {
				url: new URL(String(url)).pathname + new URL(String(url)).search,
				credentials: init?.credentials
			};
			return Response.json({
				value: { ...capabilities, credential: 'must never leave the codec' }
			});
		};
		const bolt = yield* createBolt({
			actor: null,
			locale: 'en',
			base: 'https://workspace.test',
			fetch
		});
		expect(yield* bolt.recordCapabilities('jobs', 'j1')).toEqual(capabilities);
		expect(request).toEqual({
			url: '/__bolt/record-capabilities?collection=jobs&id=j1',
			credentials: 'same-origin'
		});
		yield* bolt.recordCapabilities('jobs', 'j1', {
			collection: 'orders',
			id: 'o1',
			relation: 'lines',
			revision: 4
		});
		expect(request).toEqual({
			url: '/__bolt/record-capabilities?collection=jobs&id=j1&parentCollection=orders&parentId=o1&relation=lines&parentRevision=4',
			credentials: 'same-origin'
		});
	})
);
it.effect('an unreadable record is null; malformed and refused capabilities fail', () =>
	Effect.gen(function* () {
		let response = Response.json(
			{ error: { code: 'notFound', message: 'Not found or no access.' } },
			{ status: 404 }
		);
		const fetch: typeof globalThis.fetch = async () => response;
		const bolt = yield* createBolt({
			actor: null,
			locale: 'en',
			base: 'https://workspace.test',
			fetch
		});
		expect(yield* bolt.recordCapabilities('jobs', 'j1')).toBeNull();
		response = Response.json({
			value: { ...capabilities, fields: { title: { writable: true, reasons: ['invented'] } } }
		});
		expect(yield* Effect.flip(bolt.recordCapabilities('jobs', 'j1'))).toMatchObject({
			_tag: 'ProtocolFailed'
		});
		response = Response.json({ value: { ...capabilities, revision: 3.5 } });
		expect(yield* Effect.flip(bolt.recordCapabilities('jobs', 'j1'))).toMatchObject({
			_tag: 'ProtocolFailed'
		});
		response = Response.json({}, { status: 503 });
		expect((yield* Effect.flip(bolt.recordCapabilities('jobs', 'j1'))).message).toBe(
			'Record permissions could not be loaded.'
		);
	})
);
