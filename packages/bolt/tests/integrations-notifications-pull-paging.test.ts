import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { EffectId } from '@norbital-ai/bolt-protocol';
import type { AuthoredIntegrationBinding } from '../src/authoring/integration-introspection.js';
import type {
	IntegrationDeclaration,
	IntegrationPullDeclaration
} from '../src/authoring/workspace-schema.js';
import { runPullBinding, type PullDependencies } from '../src/runtime/integrations/pull.js';

/**
 * The two cursor reads, pinned against bodies shaped like the ones real sources send.
 *
 * `live-pull.test.ts` proves these against pokeapi, Crossref and GitHub, but it only runs when
 * `BOLT_LIVE_INTEGRATION=1` — so on its own it leaves both of the defects below unguarded in the
 * default suite. Both were found live and both were silent: neither failed a run, they just made a
 * mirror that looked like it was working read less than it should.
 */

type Answer = Readonly<{
	readonly status?: number;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body: Schema.Json;
}>;

type Written = Readonly<{
	readonly id: string;
	readonly values: Readonly<Record<string, Schema.Json>>;
}>;

/** A dependency set that answers from a script and records what was asked and what was written. */
const harness = (answers: ReadonlyArray<Answer>) => {
	const urls: Array<string> = [];
	const written: Array<Written> = [];
	const dependencies: PullDependencies = {
		request: (_effectId, _connector, descriptor) => {
			urls.push(descriptor.url);
			const answer = answers[urls.length - 1];
			return answer === undefined
				? Effect.fail({
						message: `no scripted answer for request ${urls.length}`,
						retryable: false
					})
				: Effect.succeed({
						status: answer.status ?? 200,
						headers: answer.headers ?? {},
						body: answer.body
					});
		},
		secret: (_effectId, name) => Effect.fail({ message: `no secret named ${name}` }),
		existing: () => Effect.succeed(new Map<string, ReadonlyArray<string>>()),
		remove: () => Effect.succeed(undefined),
		write: (_effectId, _collection, id, values) => {
			written.push({ id, values });
			return Effect.succeed(undefined);
		},
		pipeline: () => undefined,
		// Refuses rather than answers: neither binding here declares a `resolve`, so the loop must
		// never reach this. A stub that quietly succeeded would hide the loop starting to call it.
		resolve: () => Effect.fail({ message: 'this binding declares no resolve' }),
		sleep: () => Effect.succeed(undefined),
		now: Effect.succeed(0)
	};
	return { dependencies, urls, written };
};

const integrationOf = (binding: IntegrationPullDeclaration): IntegrationDeclaration => ({
	name: 'items.source',
	collection: 'items',
	policies: [],
	connection: { baseUrl: 'https://source.example' },
	receive: [binding],
	webhooks: [],
	send: []
});

const identityValue = (record: unknown): string => {
	const value =
		record === null || typeof record !== 'object' ? undefined : Reflect.get(record, 'id');
	return `item:${String(value)}`;
};

const authoredOf = (input: Schema.Codec<unknown, unknown>): AuthoredIntegrationBinding => ({
	input,
	identityColumn: 'external_id',
	identityValue
});

const NumericRecord: Schema.Codec<unknown, unknown> = Schema.Struct({ id: Schema.Number });
const TextRecord: Schema.Codec<unknown, unknown> = Schema.Struct({ id: Schema.String });

const run = (
	binding: IntegrationPullDeclaration,
	input: Schema.Codec<unknown, unknown>,
	answers: ReadonlyArray<Answer>,
	storedCursor: string | null = null
) => {
	const bound = harness(answers);
	return Effect.runPromise(
		runPullBinding(
			bound.dependencies,
			EffectId.make('pull'),
			integrationOf(binding),
			binding,
			authoredOf(input),
			storedCursor
		)
	).then((report) => ({ report, urls: bound.urls, written: bound.written }));
};

const base = {
	name: 'items',
	schedule: '0 * * * *',
	method: 'GET',
	path: '/items',
	identityColumn: 'external_id'
} as const satisfies Omit<IntegrationPullDeclaration, never>;

describe('pull cursor reads', () => {
	/**
	 * Crossref answers `{ message: { items, next-cursor } }` and MediaWiki answers
	 * `{ continue: { apcontinue } }`. A top-level-only read finds neither, and the failure mode is not
	 * an error — the loop concludes there is no next page and stops after one.
	 */
	it('follows a paging cursor the source buried inside an envelope', async () => {
		const binding: IntegrationPullDeclaration = {
			...base,
			records: { path: ['message', 'items'] },
			pages: {
				style: 'cursor',
				query: 'cursor',
				next: { path: ['message', 'next-cursor'] },
				max: 5
			}
		};
		const { report, urls, written } = await run(binding, NumericRecord, [
			{ body: { message: { items: [{ id: 1 }, { id: 2 }], 'next-cursor': 'CURSOR-2' } } },
			{ body: { message: { items: [{ id: 3 }], 'next-cursor': '' } } }
		]);

		expect(report.pages).toBe(2);
		expect(report.fetched).toBe(3);
		expect(report.created).toBe(3);
		expect(urls[1]).toContain('cursor=CURSOR-2');
		expect(written.map(({ values }) => values['external_id'])).toEqual([
			'item:1',
			'item:2',
			'item:3'
		]);
	});

	/** The reason `path` had to exist: `field` reads the top level and the token is not there. */
	it('reads nothing and stops after one page when an enveloped cursor is declared as a top-level field', async () => {
		const binding: IntegrationPullDeclaration = {
			...base,
			records: { path: ['message', 'items'] },
			pages: { style: 'cursor', query: 'cursor', next: { field: 'next-cursor' }, max: 5 }
		};
		const { report } = await run(binding, NumericRecord, [
			{ body: { message: { items: [{ id: 1 }, { id: 2 }], 'next-cursor': 'CURSOR-2' } } },
			{ body: { message: { items: [{ id: 3 }], 'next-cursor': '' } } }
		]);

		expect(report.pages).toBe(1);
		expect(report.fetched).toBe(2);
	});

	/**
	 * The watermark bug, in the shape it was found in: GitHub's `?since=` is a numeric id cursor, and
	 * a run that had read up to 371 persisted 98 because `"98" > "371"` as text. Nothing failed — the
	 * next run simply re-read most of what it already had, forever.
	 */
	it('takes the numerically greatest watermark, not the lexicographically greatest', async () => {
		const binding: IntegrationPullDeclaration = {
			...base,
			cursor: { send: { query: 'since' }, next: { maxOf: 'id' } }
		};
		const { report } = await run(binding, NumericRecord, [
			{ body: [{ id: 98 }, { id: 371 }, { id: 26 }] }
		]);
		expect(report.cursor).toBe('371');
	});

	/** ISO-8601 is the case the watermark was written for, and it must still order as text. */
	it('still orders an ISO-8601 watermark as text', async () => {
		const binding: IntegrationPullDeclaration = {
			...base,
			cursor: { send: { query: 'since' }, next: { maxOf: 'id' } }
		};
		const { report } = await run(binding, TextRecord, [
			{
				body: [
					{ id: '2024-01-02T00:00:00Z' },
					{ id: '2024-01-10T00:00:00Z' },
					{ id: '2023-12-31T00:00:00Z' }
				]
			}
		]);
		expect(report.cursor).toBe('2024-01-10T00:00:00Z');
	});

	/** A stored cursor is sent on the first request, which is what makes the next run incremental. */
	it('sends the stored cursor on the first request', async () => {
		const binding: IntegrationPullDeclaration = {
			...base,
			cursor: { send: { query: 'since' }, next: { maxOf: 'id' } }
		};
		const { urls } = await run(binding, NumericRecord, [{ body: [{ id: 5 }] }], '371');
		expect(urls[0]).toContain('since=371');
	});
});
