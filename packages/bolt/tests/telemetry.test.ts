import { Effect } from 'effect';
import { TestConsole } from 'effect/testing';
import { describe, expect, it } from 'vitest';
import { invocationAnnotations, loggerFor, makeSink, record } from '../src/runtime/telemetry.js';

describe('the runtime tells what it did as one JSON line per record, and keeps the row', () => {
	it('carries the event, its fields and the invocation ids', async () => {
		const sink = makeSink();
		const lines = await Effect.runPromise(
			Effect.gen(function* () {
				yield* record('model.call', {
					model: 'test/language',
					inputTokens: 1200,
					failed: false
				}).pipe(
					Effect.annotateLogs(
						invocationAnnotations({
							_tag: 'Task',
							protocolVersion: 1,
							id: 'inv-1',
							scope: { tenantId: 't', environment: 'live', releaseId: 'r1' },
							command: 'conversations.answer',
							input: {},
							taskId: 'agent:m1',
							attempt: 2
						} as never)
					),
					Effect.provide(loggerFor(sink))
				);
				return yield* TestConsole.logLines;
			}).pipe(Effect.provide(TestConsole.layer))
		);
		expect(lines).toHaveLength(1);
		const line = JSON.parse(String(lines[0]));
		expect(line).toMatchObject({
			message: 'model.call',
			level: 'INFO',
			annotations: {
				tenant: 't',
				environment: 'live',
				release: 'r1',
				invocation: 'inv-1',
				kind: 'Task',
				task: 'agent:m1',
				attempt: 2,
				model: 'test/language',
				inputTokens: 1200,
				failed: false
			}
		});
		expect(typeof line.timestamp).toBe('string');
		expect(sink.rows).toEqual([
			{
				at: line.timestamp,
				severity: 'INFO',
				event: 'model.call',
				invocation: 'inv-1',
				conversation: null,
				turn: null,
				attributes: {
					tenant: 't',
					environment: 'live',
					release: 'r1',
					kind: 'Task',
					task: 'agent:m1',
					attempt: 2,
					model: 'test/language',
					inputTokens: 1200,
					failed: false
				}
			}
		]);
	});
});
