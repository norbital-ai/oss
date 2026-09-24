import {
	AIGenerationResult,
	AIResponse,
	EffectId,
	ProviderObservation,
	type AIRequest
} from '@norbital-ai/bolt-protocol';
import { Effect, Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { describe, expect, it } from 'vitest';
import * as AccessControl from '../src/runtime/access/access-control.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { inferCollectionFilter } from '../src/runtime/collections/filter-inference.js';
import { AI } from '../src/runtime/facilities/services.js';
import { Subject } from '../src/runtime/identity/identity.js';

const encodeMessage = Schema.encodeSync(Prompt.Message);
const call = (id: string, name: string, params: Record<string, unknown>) =>
	encodeMessage(
		Prompt.assistantMessage({
			content: [Prompt.toolCallPart({ id, name, params, providerExecuted: false })]
		})
	);

const subject = Subject.make({
	userId: 'dispatcher-1',
	tenantId: 'tenant-1',
	teamPath: [],
	policies: []
});

const input = {
	collection: 'job_assignments',
	text: "bob's jobs that aren't done, near the airport, by the new guy",
	fields: [
		{
			value: 'assignee_user_id',
			label: 'Assignee',
			kind: 'uuid',
			nullable: true,
			target: 'user',
			operators: ['eq', 'ne', 'isNull', 'isNotNull']
		},
		{
			value: 'status',
			label: 'Status',
			kind: 'enum',
			nullable: false,
			values: ['assigned', 'completed'],
			operators: ['eq', 'ne']
		}
	],
	current: []
};

describe('collection filter inference', () => {
	it('resolves names through the caller, returns editable rows, and reports what it could not map', async () => {
		const requests: Array<AIRequest> = [];
		const reads: Array<Record<string, unknown>> = [];
		const authorized: Array<string> = [];
		const script = [
			call('lookup', 'find_records', { collection: 'user', search: 'bob' }),
			call('result', 'return_result', {
				conditions: [
					{ field: 'assignee_user_id', operator: 'eq', value: 'user-bob' },
					{ field: 'status', operator: 'ne', value: 'completed' },
					// Not an operator the picker offers for status: reported, never applied.
					{ field: 'status', operator: 'ilike', value: '%done%' }
				],
				unresolved: ['near the airport', 'by the new guy']
			})
		];
		const answer = await Effect.runPromise(
			inferCollectionFilter(EffectId.make('filter-1'), subject, input, '2026-09-24').pipe(
				Effect.provideService(AccessControl.Service, {
					invocation: () => ({
						authorize: (_subject: unknown, action: string, collection: string) =>
							Effect.sync(() => void authorized.push(`${action}:${collection}`))
					})
				} as never),
				Effect.provideService(Collections.Service, {
					findMany: (_effectId: unknown, reader: typeof subject, query: Record<string, unknown>) =>
						Effect.sync(() => {
							reads.push({ reader: reader.userId, ...query });
							return [{ id: 'user-bob', name: 'Bob Poh', notes: 'x'.repeat(900) }];
						})
				} as never),
				Effect.provideService(AI.Service, {
					catalog: () =>
						Effect.succeed({ languageModels: [], defaultLanguageModelId: 'provider/fast' }),
					generate: (_effectId: unknown, request: AIRequest) => {
						requests.push(request);
						if (request._tag !== 'Generate') return Effect.die('expected a generate request');
						const message = script[requests.length - 1];
						if (message === undefined) return Effect.die('unscripted turn');
						return Effect.succeed(
							AIResponse.cases.Generated.make({
								result: AIGenerationResult.cases.Message.make({ message }),
								observation: ProviderObservation.make({
									callId: request.callId,
									provider: 'test',
									model: request.modelId,
									operation: 'language'
								})
							})
						);
					},
					embed: () => Effect.die('unexpected embedding request')
				} as never)
			)
		);

		expect(authorized).toEqual(['read:job_assignments']);
		// The lookup ran as the viewer, bounded, and never carried a long text column back.
		expect(reads).toEqual([
			{ reader: 'dispatcher-1', collection: 'user', search: 'bob', limit: 5 }
		]);
		expect(answer).toEqual({
			conditions: [
				{ field: 'assignee_user_id', operator: 'eq', value: 'user-bob' },
				{ field: 'status', operator: 'ne', value: 'completed' }
			],
			unresolved: ['near the airport', 'by the new guy', 'status ilike']
		});
		const first = requests[0];
		expect(first?._tag === 'Generate' ? first.modelId : undefined).toBe('provider/fast');
	});

	it('keeps a related answer whose conditions the related collection offers, and reports one that does not', async () => {
		const messages = {
			value: '@messages',
			label: 'Messages',
			kind: 'relation',
			nullable: false,
			target: 'messages',
			operators: ['related'],
			fields: [
				{
					value: 'status',
					label: 'Status',
					kind: 'enum',
					nullable: false,
					values: ['open', 'closed'],
					operators: ['eq', 'ne']
				},
				{
					value: 'kind',
					label: 'Kind',
					kind: 'enum',
					nullable: false,
					values: ['invoice', 'quote'],
					operators: ['eq', 'ne']
				},
				{
					value: 'total',
					label: 'Total',
					kind: 'number',
					nullable: true,
					operators: ['gt', 'gte', 'lt', 'lte']
				}
			]
		};
		const invoiceCount = {
			field: '@messages',
			operator: 'related',
			value: {
				match: 'count',
				comparison: 'gte',
				value: 1,
				where: [
					{ field: 'status', operator: 'eq', value: 'open' },
					{ field: 'kind', operator: 'eq', value: 'invoice' }
				]
			}
		};
		const guessed = {
			field: '@messages',
			operator: 'related',
			value: { match: 'some', where: [{ field: 'amount', operator: 'gt', value: 10 }] }
		};
		const bigSpenders = {
			field: '@messages',
			operator: 'related',
			value: { match: 'sum', of: 'total', comparison: 'gt', value: 10000, where: [] }
		};
		const sumOfText = {
			field: '@messages',
			operator: 'related',
			value: { match: 'sum', of: 'kind', comparison: 'gt', value: 1, where: [] }
		};
		const reply = call('result', 'return_result', {
			conditions: [invoiceCount, guessed, bigSpenders, sumOfText],
			unresolved: []
		});
		const answer = await Effect.runPromise(
			inferCollectionFilter(
				EffectId.make('filter-2'),
				subject,
				{
					collection: 'customers',
					text: 'customers with at least 1 open invoice message',
					fields: [messages],
					current: []
				},
				'2026-09-24'
			).pipe(
				Effect.provideService(AccessControl.Service, {
					invocation: () => ({ authorize: () => Effect.void })
				} as never),
				Effect.provideService(Collections.Service, { findMany: () => Effect.succeed([]) } as never),
				Effect.provideService(AI.Service, {
					catalog: () =>
						Effect.succeed({ languageModels: [], defaultLanguageModelId: 'provider/fast' }),
					generate: (_effectId: unknown, request: AIRequest) =>
						request._tag !== 'Generate'
							? Effect.die('expected a generate request')
							: Effect.succeed(
									AIResponse.cases.Generated.make({
										result: AIGenerationResult.cases.Message.make({ message: reply }),
										observation: ProviderObservation.make({
											callId: request.callId,
											provider: 'test',
											model: request.modelId,
											operation: 'language'
										})
									})
								),
					embed: () => Effect.die('unexpected embedding request')
				} as never)
			)
		);
		expect(answer.conditions).toEqual([invoiceCount, bigSpenders]);
		expect(answer.unresolved).toEqual(['@messages related', '@messages related']);
	});
});
