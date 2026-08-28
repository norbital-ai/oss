import { Effect, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	EnvironmentName,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	SyncSchemaFacts,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { collection, field } from '../../src/authoring/workspace-schema.js';
import {
	canonicalSchemaStepEncoding,
	digestSchemaSteps,
	type SchemaStep
} from '../../src/compiler/schema-plan.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import {
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';
import { seedSession } from '../support/fixture-identity.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const command = (name: string) =>
	Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`schema-wire:${name}`),
		scope: {
			tenantId: TenantId.make('test-tenant'),
			environment: EnvironmentName.make('development'),
			releaseId: ReleaseId.make('local')
		},
		deadlineEpochMs: Date.now() + 30_000,
		command: name,
		input: null,
		headers: { authorization: ['Bearer schema-wire-token'] }
	});

describe('schema barrier wire', () => {
	it('describes immutable release facts and leaves generation to the host', async () => {
		const base = testWorkspace();
		harness = await makeBoltTestRuntime({
			...base,
			collections: [
				collection({ name: 'zebra', fields: { value: field.string() } }),
				collection({ name: 'private_notes', fields: { value: field.string() }, sync: false }),
				collection({ name: 'accounts', fields: { value: field.string() } })
			]
		});
		await seedSession(harness, {
			token: 'schema-wire-token',
			user: 'schema-wire-user',
			team: 'admin'
		});

		const [schemaAnswer, provisioningAnswer] = await Promise.all([
			harness.runtime.runPromise(dispatchInvocation(command('sync.schema'))),
			harness.runtime.runPromise(dispatchInvocation(command('sync.provisioning')))
		]);
		const facts = Schema.decodeUnknownSync(SyncSchemaFacts)(schemaAnswer.value);
		const provisioning = provisioningAnswer.value as {
			readonly fingerprint: string;
			readonly steps: ReadonlyArray<SchemaStep>;
		};

		expect(facts).toMatchObject({
			cursor: 'xid-sequence',
			version: 1,
			fingerprint: provisioning.fingerprint,
			minimumProtocolVersion: PROTOCOL_VERSION,
			migrationDigest: digestSchemaSteps(provisioning.steps)
		});
		// Runtime-owned materialized collections join authored ones. Returning all of them is the
		// conservative release-only answer when the guest cannot know which prior release is leaving.
		expect(facts.affectedCollections).toEqual([...facts.affectedCollections].toSorted());
		expect(facts.affectedCollections).toEqual(
			expect.arrayContaining(['accounts', 'approval_request', 'zebra'])
		);
		expect(facts.affectedCollections).not.toContain('private_notes');
		expect(facts.affectedCollections).not.toContain('user');
		expect(facts.affectedCollections).not.toContain('automation_run');
		expect(facts).not.toHaveProperty('generation');
	});

	it('pins the canonical digest input to ordered id/sql JSON encoded as UTF-8', () => {
		const steps = [
			{ id: 'lineage:1:0', sql: 'alter table "café" add column "名" text' },
			{ id: 'sync-trigger:café', sql: 'create trigger t after insert on "café"' }
		] satisfies ReadonlyArray<SchemaStep>;
		expect(canonicalSchemaStepEncoding(steps)).toBe(
			'[{"id":"lineage:1:0","sql":"alter table \\"café\\" add column \\"名\\" text"},{"id":"sync-trigger:café","sql":"create trigger t after insert on \\"café\\""}]'
		);
		expect(digestSchemaSteps(steps)).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(digestSchemaSteps([...steps].reverse())).not.toBe(digestSchemaSteps(steps));
	});
});
