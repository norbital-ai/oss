import { Schema } from 'effect';
import {
	EnvironmentName,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId,
	type HostScheduleOccurrence
} from '@norbital-ai/bolt-protocol';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import * as TaskQueue from '../../src/runtime/tasks/tasks.js';
import { TEST_ENVIRONMENT, TEST_TENANT, type BoltTestRuntime } from './bolt-test-layer.js';

/**
 * The host's half of the task contract, for a test: every occurrence the runtime wakes the host
 * with is run at once through `dispatchInvocation` and settled — which is what a child
 * conversation, a sibling's answer or a parent's wake-up needs to actually happen while the test's
 * own turn goes on. Returns the runs so a test can await them all before asserting.
 */
export const bindTaskRunner = (harness: BoltTestRuntime) => {
	let serial = 0;
	const runs: Array<Promise<void>> = [];
	harness.tasks.bind((occurrence) => {
		const run = deliver(harness, occurrence, (serial += 1));
		runs.push(run);
		return run;
	});
	// A run may enqueue another (a child's report wakes its parent); wait until none are new.
	return {
		settled: async () => {
			let seen = 0;
			while (seen < runs.length) {
				seen = runs.length;
				await Promise.all(runs);
			}
		}
	};
};

const deliver = async (
	harness: BoltTestRuntime,
	occurrence: HostScheduleOccurrence,
	serial: number
): Promise<void> => {
	const response = await harness.runtime.runPromise(
		dispatchInvocation(
			Invocation.cases.Task.make({
				protocolVersion: PROTOCOL_VERSION,
				id: InvocationId.make(`task-runner-${serial}`),
				scope: {
					tenantId: TenantId.make(TEST_TENANT),
					environment: EnvironmentName.make(TEST_ENVIRONMENT),
					releaseId: ReleaseId.make('local')
				},
				command: occurrence.command,
				input: occurrence.input,
				taskId: occurrence.taskId,
				attempt: occurrence.attempt
			})
		)
	);
	const queue = await harness.runtime.runPromise(TaskQueue.Service);
	await harness.runtime.runPromise(
		queue.settle(
			harness.effectId(`task-runner-settle-${serial}`),
			occurrence.taskId,
			occurrence.attempt,
			{ _tag: 'Done', result: Schema.decodeUnknownSync(Schema.Json)(response.value) }
		)
	);
};
