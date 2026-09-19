import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import {
	EnvironmentName,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { dispatchInvocation } from '../src/runtime/dispatch.js';
import * as Database from '../src/runtime/facilities/database.js';
import { keep, loggerFor, makeSink, record, Sink } from '../src/runtime/telemetry.js';
import {
	makeBoltTestRuntime,
	TEST_ENVIRONMENT,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { seedSession } from './support/fixture-identity.js';

/**
 * What the runtime keeps of itself: every invocation ends with its records in `telemetry`, a
 * failure among them at error, and the window pruned — through the same dispatch a host calls.
 */
const scope = {
	tenantId: TenantId.make('test-tenant'),
	environment: EnvironmentName.make(TEST_ENVIRONMENT),
	releaseId: ReleaseId.make('local')
};

let sequence = 0;
const command = (name: string, input: unknown) =>
	Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`telemetry-${name}-${(sequence += 1)}`),
		scope,
		command: name,
		input: input as never,
		headers: { authorization: ['Bearer admin-token'] }
	});
const task = (name: string, input: unknown) =>
	Invocation.cases.Task.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`telemetry-task-${name}-${(sequence += 1)}`),
		scope,
		command: name,
		input: input as never,
		attempt: 0
	});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

type Row = Readonly<{
	severity: string;
	event: string;
	invocation: string;
	attributes: Record<string, unknown>;
}>;
const rows = async (runtime: BoltTestRuntime) =>
	(await runtime.database.query(
		'select severity, event, invocation, attributes from telemetry order by at'
	)) as ReadonlyArray<Row>;

const seedAged = (runtime: BoltTestRuntime) =>
	runtime.database.query(
		`insert into telemetry (id, at, severity, event, attributes) values (gen_random_uuid(), now() - interval '100 hours', 'INFO', 'aged', '{}')`
	);

describe('the runtime keeps its own records', () => {
	it('keeps a settled command’s records under its id, in one statement', async () => {
		harness = await makeBoltTestRuntime();
		await seedSession(harness, { token: 'admin-token', user: 'user-admin', team: 'admin' });
		await seedAged(harness);
		const invocation = command('collections.findMany', { collection: 'people' });
		await harness.runtime.runPromise(dispatchInvocation(invocation));
		const kept = await rows(harness);
		expect(kept.map((row) => row.event)).toContain('aged');
		const settled = kept.filter((row) => row.invocation === invocation.id);
		expect(settled.map((row) => row.event)).toEqual(['dispatch.settled']);
		expect(settled[0]!.attributes).toMatchObject({
			tenant: 'test-tenant',
			outcome: 'success',
			command: 'collections.findMany'
		});
	});

	it('surfaces a refused task as one warning record and prunes the aged window with it', async () => {
		harness = await makeBoltTestRuntime();
		await seedAged(harness);
		const invocation = task('collections.findMany', { collection: 'people' });
		await harness.runtime.runPromise(dispatchInvocation(invocation).pipe(Effect.ignore));
		const kept = await rows(harness);
		expect(kept.map((row) => row.event)).not.toContain('aged');
		expect(kept).toHaveLength(1);
		expect(kept[0]).toMatchObject({
			severity: 'WARN',
			event: 'dispatch.refused',
			invocation: invocation.id
		});
		expect(String(kept[0]!.attributes['error'])).toContain('AccessDenied');
	});

	it('keeps a slice of a long invocation’s records before it ends', async () => {
		harness = await makeBoltTestRuntime();
		const invocation = task('collections.findMany', { collection: 'people' });
		const sink = makeSink(invocation);
		await harness.runtime.runPromise(
			Effect.gen(function* () {
				const database = yield* Database.Service;
				for (let index = 0; index < 100; index += 1) yield* record('tool.call', { index });
				yield* keep(database);
			}).pipe(Effect.provideService(Sink, sink), Effect.provide(loggerFor(sink)))
		);
		expect(sink.rows).toHaveLength(0);
		expect(sink.slices).toBe(1);
		expect(await rows(harness)).toHaveLength(100);
	});
});
