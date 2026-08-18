import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { EffectId, InvocationId, type TransportRequest } from '@norbital-ai/bolt-protocol';
import { testCallContext } from '../support/bolt-test-layer.js';
import { app, workspace } from '../../src/authoring/index.js';
import { FacilityError } from '../../src/runtime/facilities/database.js';
import { Transport } from '../../src/runtime/facilities/services.js';
import { Workspace } from '../../src/runtime/workspace.js';

/**
 * One context per invocation, built the same way every time.
 *
 * What these tests are about is that two invocations running at once share nothing, so each gets
 * its own context rather than a module-level one they both point at. The environment is the
 * harness default: nothing here reads it — the transport facility passes invocation id, deadline
 * and subject to the binding and no mode — so a value chosen per test would be decoration.
 */
const callContext = (invocationId: string) =>
	testCallContext(invocationId, { deadlineEpochMs: Date.now() + 1000 });

describe('artifact statelessness', () => {
	it('keeps independent workspace registries isolated', async () => {
		const make = (name: string) =>
			workspace({
				name,
				version: '1',
				collections: [],
				apps: [app({ name, label: name })],
				policies: [],
				agents: [],
				automations: [],
				channels: [],
				integrations: [],
				requiredFacilities: []
			});
		const read = (name: string) =>
			Effect.runPromise(
				Effect.gen(function* () {
					return (yield* Workspace.Service).definition.name;
				}).pipe(Effect.provide(Workspace.layer(make(name))))
			);
		expect(await Promise.all([read('first'), read('second')])).toEqual(['first', 'second']);
	});

	it('keeps concurrent transport bindings isolated', async () => {
		const callsA: Array<{ invocationId: string; request: TransportRequest }> = [];
		const callsB: Array<{ invocationId: string; request: TransportRequest }> = [];
		const bindingA = {
			call: (_metadata: { invocationId: string }, request: TransportRequest) => {
				callsA.push({ invocationId: _metadata.invocationId, request });
				return Promise.resolve({ _tag: 'Success' as const, value: { connectionId: 'conn-a' } });
			}
		};
		const bindingB = {
			call: (_metadata: { invocationId: string }, request: TransportRequest) => {
				callsB.push({ invocationId: _metadata.invocationId, request });
				return Promise.resolve({ _tag: 'Success' as const, value: { connectionId: 'conn-b' } });
			}
		};
		const run = (invocationId: string, binding: typeof bindingA) =>
			Effect.runPromise(
				Effect.gen(function* () {
					const transport = yield* Transport.Service;
					return yield* transport.execute(EffectId.make(`${invocationId}:open`), {
						_tag: 'Open',
						protocol: 'sse',
						direction: 'one-way'
					});
				}).pipe(Effect.provide(Transport.layer(binding, callContext(invocationId))))
			);
		const [responseA, responseB] = await Promise.all([
			run('inv-a', bindingA),
			run('inv-b', bindingB)
		]);
		expect(responseA.connectionId).toBe('conn-a');
		expect(responseB.connectionId).toBe('conn-b');
		expect(callsA).toHaveLength(1);
		expect(callsB).toHaveLength(1);
		expect(callsA[0]?.invocationId).toBe(InvocationId.make('inv-a'));
		expect(callsB[0]?.invocationId).toBe(InvocationId.make('inv-b'));
		expect(callsA).toEqual([callsA[0]]);
		expect(callsB).toEqual([callsB[0]]);
	});

	it('completes transport send without leaving module-level registry state', async () => {
		const active = { count: 0 };
		const binding = {
			call: async (_metadata: unknown, _request: TransportRequest) => {
				active.count += 1;
				try {
					return { _tag: 'Success' as const, value: {} };
				} finally {
					active.count -= 1;
				}
			}
		};
		const run = (invocationId: string) =>
			Effect.runPromise(
				Effect.gen(function* () {
					const transport = yield* Transport.Service;
					yield* transport.execute(EffectId.make(`${invocationId}:open`), {
						_tag: 'Open',
						protocol: 'websocket',
						direction: 'two-way'
					});
					yield* transport.execute(EffectId.make(`${invocationId}:send`), {
						_tag: 'Send',
						connectionId: 'conn-1',
						kind: 'text',
						bytes: new TextEncoder().encode('ping')
					});
				}).pipe(Effect.provide(Transport.layer(binding, callContext(invocationId))))
			);
		await Promise.all([run('send-a'), run('send-b')]);
		expect(active.count).toBe(0);
	});

	it('reports facility_unavailable when transport is not bound', async () => {
		const error = await Effect.runPromise(
			Effect.flip(
				Effect.gen(function* () {
					const transport = yield* Transport.Service;
					return yield* transport.execute(EffectId.make('transport-missing'), {
						_tag: 'Open',
						protocol: 'sse',
						direction: 'one-way'
					});
				}).pipe(Effect.provide(Transport.layer(undefined, callContext('transport-missing'))))
			)
		);
		expect(error).toBeInstanceOf(FacilityError);
		if (error instanceof FacilityError) {
			expect(error.code).toBe('facility_unavailable');
			expect(error.retryable).toBe(false);
			expect(error.outcome).toBe('known');
		}
	});
});
