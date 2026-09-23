import { afterEach, describe, expect, it } from 'vitest';
import { Effect, Exit, Option } from 'effect';
import { describePolicy } from '../src/authoring/policy-introspection.js';
import { collection, field, workspace } from '../src/authoring/workspace-schema.js';
import { emptyAuthoredRuntime, type AuthoredRuntime } from '../src/runtime/collections/authored.js';
import * as Collections from '../src/runtime/collections/collections.js';
import type * as Identity from '../src/runtime/identity/identity.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { unwrapMutationPhase } from './support/mutation-phase.js';

const definition = workspace({
	name: 'field-masking',
	version: '1',
	collections: [
		collection({
			name: 'assignments',
			fields: {
				title: field.string({ required: true }),
				controller_note: field.string(),
				source: field.string()
			}
		})
	],
	apps: [],
	/**
	 * One policy owns every `assignments` coordinate, because a coordinate may have exactly one
	 * owner. The unmasked half of this fixture is the administrator bypass rather than a second
	 * grant: `adminSubject` carries `admin: true`, which reaches an authored collection whole and is
	 * how a real workspace expresses "sees everything" beside a field-masked role.
	 */
	policies: [
		describePolicy('field-worker', {
			description: 'May work only with the public assignment fields.',
			grants: {
				assignments: {
					read: { fields: ['id', 'title'] },
					mutate: { new: { fields: ['title'] }, existing: { fields: ['title'] } }
				}
			}
		})
	],
	teams: { 'field-worker': ['field-worker'] },
	automations: [],
	channels: [],
	envoys: [],
	integrations: [],
	prompt: 'Test workspace.',
	tools: [],
	skills: [],
	requiredFacilities: []
});

const fieldWorker: Identity.Subject = {
	userId: 'worker-1',
	tenantId: 'test-tenant',
	teamPath: ['field-worker'],
	policies: []
};

/** Every column is declared writable; the policy field grant is what narrows a caller. */
const declared: AuthoredRuntime['collections']['assignments'] = {
	create: { input: { columns: { title: true, controller_note: true, source: true } } },
	update: { input: { columns: { title: true, controller_note: true, source: true } } }
};
type Payload = Readonly<Record<string, unknown>>;
type Transform = (
	inputs: ReadonlyArray<Payload>,
	context: Readonly<{ existing: ReadonlyArray<Payload | undefined> }>
) => ReadonlyArray<Payload>;
const authoredWith = (transform?: Transform): AuthoredRuntime => ({
	...emptyAuthoredRuntime,
	collections: { assignments: { ...declared, ...(transform === undefined ? {} : { transform }) } }
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const write = (
	runtime: BoltTestRuntime,
	effectId: string,
	subject: Identity.Subject,
	action: 'create' | 'update',
	input: Payload
) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			yield* (yield* Collections.Service).write(runtime.effectId(effectId), subject, [
				{ collection: 'assignments', action, inputs: [input] }
			]);
		})
	);

describe('authored policy field masks', () => {
	it('omits forbidden fields from collection reads', async () => {
		harness = await makeBoltTestRuntime(definition, { authored: authoredWith() });
		const id = recordId('masked-assignment');
		await write(harness, 'create', adminSubject, 'create', {
			id,
			title: 'Inspect site',
			controller_note: 'Do not disclose'
		});

		const rows = await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).findMany(
					harness!.effectId('read'),
					fieldWorker,
					{ collection: 'assignments' }
				);
			})
		);

		expect(rows).toEqual([{ id, row_version: 1, title: 'Inspect site' }]);
		expect(JSON.stringify(rows)).not.toContain('controller_note');
		expect(JSON.stringify(rows)).not.toContain('Do not disclose');
	});

	it('checks caller fields before the update transform and permits server-derived fields', async () => {
		harness = await makeBoltTestRuntime(definition, {
			authored: authoredWith((inputs, { existing }) =>
				inputs.map((input, index) =>
					existing[index] === undefined
						? input
						: { ...input, controller_note: 'injected by transform' }
				)
			)
		});
		const id = recordId('hooked-assignment');
		await write(harness, 'create', adminSubject, 'create', {
			id,
			title: 'Original',
			controller_note: 'Private'
		});

		await write(harness, 'restricted-update', fieldWorker, 'update', { id, title: 'Changed' });
		await write(harness, 'restricted-declarative-update', fieldWorker, 'update', {
			id,
			title: 'Changed through graph'
		});

		const [record] = await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).findMany(
					harness!.effectId('verify'),
					adminSubject,
					{ collection: 'assignments' }
				);
			})
		);
		expect(record).toMatchObject({
			title: 'Changed through graph',
			controller_note: 'injected by transform'
		});
	});

	it('rejects forged create fields before the transform while allowing server-computed fields', async () => {
		harness = await makeBoltTestRuntime(definition, {
			authored: authoredWith((inputs, { existing }) =>
				inputs.map((input, index) =>
					existing[index] === undefined
						? { title: String(input['title']), source: 'server-computed' }
						: input
				)
			)
		});

		const forged = await harness.runtime.runPromiseExit(
			Effect.gen(function* () {
				yield* (yield* Collections.Service).write(harness!.effectId('forged-create'), fieldWorker, [
					{
						collection: 'assignments',
						action: 'create',
						inputs: [{ title: 'Forged', source: 'caller-forged' }]
					}
				]);
			})
		);
		const refusal = Option.getOrUndefined(Exit.findErrorOption(forged));
		// The caller is judged on what it submitted, before the transform runs (RFC §6).
		expect(unwrapMutationPhase(refusal)).toMatchObject({
			action: 'create',
			resource: 'assignments',
			reason: 'create includes fields outside the matching policy grant'
		});
		expect(await harness.database.query('select id from assignments')).toEqual([]);

		await write(harness, 'allowed-create', fieldWorker, 'create', { title: 'Allowed' });
		const rows = await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).findMany(
					harness!.effectId('verify-create'),
					adminSubject,
					{ collection: 'assignments' }
				);
			})
		);
		expect(rows).toEqual([
			expect.objectContaining({
				title: 'Allowed',
				source: 'server-computed'
			})
		]);
	});
});
