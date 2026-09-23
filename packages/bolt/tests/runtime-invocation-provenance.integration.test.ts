import { Effect, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	EnvironmentName,
	FixedCommandCatalogue,
	InvocationId,
	Invocation,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { approveBy } from '../src/authoring/approval-flow.js';
import { automation } from '../src/authoring/automations-schema.js';
import {
	describePolicy,
	policyRuntimeFunctionsFor
} from '../src/authoring/policy-introspection.js';
import { collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import * as AccessControl from '../src/runtime/access/access-control.js';
import * as Approvals from '../src/runtime/approvals/approvals.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime, type AuthoredRuntime } from '../src/runtime/collections/authored.js';
import { dispatchInvocation } from '../src/runtime/dispatch.js';
import { DispatchError } from '../src/runtime/workspace.js';
import { FixedCommandBindings } from '../src/runtime/commands.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

/** Requests approval through the authored admin-team policy; administrator status bypasses it. */
const policySubject = { ...adminSubject, admin: false };

/**
 * Which invocation tags may reach the command catalogue at all.
 *
 * `POST /_bolt/plugin/<anything>/<command>` builds a `Plugin` invocation out of a URL and a request
 * body with no authentication anywhere, and a `Task` carries no credential by construction. Both
 * used to hand their input to the deleted switch untouched, so that switch was a second,
 * unauthenticated command port. The provenance gate now defaults both credential-free tags to deny.
 *
 * These tests therefore hold the whole fixed catalogue against the gate rather than a chosen
 * sample, and read names from `FixedCommandCatalogue` so a binding added tomorrow is covered
 * without anybody remembering to extend a list here.
 */

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const scope = {
	tenantId: TenantId.make('test-tenant'),
	environment: EnvironmentName.make('development'),
	releaseId: ReleaseId.make('local')
};

/**
 * Every fixed command name, read from the protocol catalogue that `commands.ts` must bind exactly
 * once.
 *
 * A written-out list is a list somebody has to remember to extend, which is exactly how five
 * `schema.*` commands each shipped without a check. The catalogue is the only name authority; the
 * deleted switch is not consulted.
 */
const FIXED_COMMANDS: ReadonlyArray<string> = FixedCommandCatalogue.map(({ name }) => name);

/** Authored names the interpreter resolves by membership, not as fixed catalogue entries. */
const DYNAMIC_COMMANDS: ReadonlyArray<string> = ['invoke.anything', 'automations.midnight'];

/**
 * The commands `FixedCommandBindings` admits on Task origin, which are the only ones a `Task` may run.
 *
 * `automations.<name>` is not here because it is not a fixed string: it is resolved against the
 * automations the workspace declares, which the automation tests below cover from both sides.
 */
const TASK_COMMANDS: ReadonlyArray<string> = [...FixedCommandBindings.values()]
	.filter(({ origins }) => origins.Task !== undefined)
	.map(({ contract }) => contract.name);

const scopedInvocation = {
	protocolVersion: PROTOCOL_VERSION,
	scope
};

const command = (name: string, credential: string, input: unknown = null) =>
	Invocation.cases.Command.make({
		...scopedInvocation,
		id: InvocationId.make(`command-${name}`),
		command: name,
		input: input as never,
		headers: { authorization: [`Bearer ${credential}`] }
	});

const task = (name: string, input: unknown = null, taskId?: string) =>
	Invocation.cases.Task.make({
		...scopedInvocation,
		id: InvocationId.make(`task-${name}`),
		command: name,
		input: input as never,
		attempt: 0,
		...(taskId === undefined ? {} : { taskId })
	});

/** Any plugin but `data-browser`, which is the one surface the boundary resolves a subject for. */
const plugin = (name: string, input: unknown = null) =>
	Invocation.cases.Plugin.make({
		...scopedInvocation,
		id: InvocationId.make(`plugin-${name}`),
		plugin: 'operator-console',
		command: name,
		input: input as never,
		headers: {},
		trustedContext: {}
	});

const outcomeOf = (runtime: BoltTestRuntime, invocation: Invocation) =>
	runtime.runtime.runPromise(dispatchInvocation(invocation).pipe(Effect.result));

const failureOf = async (runtime: BoltTestRuntime, invocation: Invocation) => {
	const outcome = await outcomeOf(runtime, invocation);
	if (outcome._tag !== 'Failure')
		throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
	return outcome.failure;
};

const gatedWorkspace = workspace({
	name: 'test-workspace',
	version: '1',
	collections: [
		collection({
			name: 'people',
			fields: { name: field.string({ required: true }) }
		})
	],
	apps: [],
	policies: [
		describePolicy('admin', {
			description: 'Requires review before creating a person.',
			grants: {
				people: {
					read: {},
					mutate: {
						new: { approval: { flow: () => approveBy('approvers'), superceded_by: [] } }
					}
				}
			}
		})
	],
	teams: {
		admin: ['admin'],
		approvers: []
	},
	automations: [
		automation({
			name: 'nightly',
			trigger: { _tag: 'Schedule', cron: '0 0 * * *' },
			command: 'automations.nightly',
			policies: ['admin']
		})
	],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: []
});

const gatedFunctions = policyRuntimeFunctionsFor(gatedWorkspace.policies);
const gatedAuthored: AuthoredRuntime = {
	...emptyAuthoredRuntime,
	automations: {
		nightly: {
			name: 'nightly',
			policies: ['admin'],
			trigger: { _tag: 'Schedule' as const, cron: '0 0 * * *' },
			input: Schema.Json,
			output: Schema.Json,
			handler: () => ({ completed: true })
		}
	},
	policyAuthorizations: gatedFunctions.authorizations,
	approvalFlows: gatedFunctions.approvalFlows,
	collections: { people: { create: { input: { columns: { name: true } } } } }
};

describe('invocation provenance', () => {
	// A regex that silently stops matching would make every loop below pass over an empty list, which
	// is the shape a green suite takes when it is proving nothing.
	it('binds the whole protocol catalogue exactly once', () => {
		expect(FIXED_COMMANDS.length).toBeGreaterThan(40);
		expect(FIXED_COMMANDS).not.toContain('identity.authenticate');
		expect(FIXED_COMMANDS).not.toContain('agents.enqueue');
		expect(FIXED_COMMANDS).not.toContain('agents.updateVerifier');
		expect(FIXED_COMMANDS).toContain('notifications.deliver');
		expect(FIXED_COMMANDS).toContain('collections.resume');
		expect(new Set(FIXED_COMMANDS).size).toBe(FIXED_COMMANDS.length);
		expect([...FixedCommandBindings.keys()].sort()).toEqual([...FIXED_COMMANDS].sort());
	});

	it('refuses every catalogue command on a plugin that is not the data browser', async () => {
		harness = await makeBoltTestRuntime(testWorkspace());
		for (const name of [...FIXED_COMMANDS, ...DYNAMIC_COMMANDS]) {
			const failure = await failureOf(harness, plugin(name));
			expect((failure as { readonly code?: string }).code, name).toBe('unauthorized');
		}
	});

	it('refuses every catalogue command on a task, except the ones the runtime enqueues', async () => {
		harness = await makeBoltTestRuntime(testWorkspace());
		for (const name of [...FIXED_COMMANDS, ...DYNAMIC_COMMANDS]) {
			const outcome = await outcomeOf(harness, task(name));
			if (TASK_COMMANDS.includes(name)) {
				// Allowed past the gate, then refused by the contract its binding declares — which is the
				// input being absent here, not the caller being unauthorized.
				expect(outcome._tag, name).toBe('Failure');
				expect(outcome._tag === 'Failure' ? outcome.failure : undefined, name).not.toBeInstanceOf(
					AccessControl.AccessDenied
				);
				continue;
			}
			expect(outcome._tag, name).toBe('Failure');
			const failure = outcome._tag === 'Failure' ? outcome.failure : undefined;
			expect(failure, name).toBeInstanceOf(AccessControl.AccessDenied);
			expect((failure as AccessControl.AccessDenied).reason, name).toContain('provenance');
		}
	});

	/**
	 * `automations.<name>` is the one enqueued command that is not a fixed string, and the five host
	 * commands under the same prefix are the reason it is resolved against the declared automations
	 * rather than matched on `automations.`.
	 */
	it('admits a declared automation on a task and still refuses the host commands sharing its prefix', async () => {
		harness = await makeBoltTestRuntime(gatedWorkspace, { authored: gatedAuthored });

		// Admitted past the gate: what refuses it now is the occurrence it names not running, which
		// is the dispatcher's contract — never the provenance check this file is about.
		const declared = await outcomeOf(
			harness,
			task(
				'automations.nightly',
				{ args: {}, bolt_run_as: adminSubject, bolt_task_id: 'task-nightly' },
				'task-nightly'
			)
		);
		const refusal = declared._tag === 'Failure' ? declared.failure : undefined;
		expect(refusal).not.toBeInstanceOf(AccessControl.AccessDenied);
		expect((refusal as { readonly message?: string } | undefined)?.message).toContain(
			'No running occurrence'
		);

		for (const name of [
			'automations.start',
			'automations.runStep',
			'automations.resume',
			'automations.stop'
		]) {
			const failure = await failureOf(
				harness,
				task(name, { name: 'nightly', input: {}, conversationId: 'task-1' })
			);
			expect(failure, name).toBeInstanceOf(AccessControl.AccessDenied);
		}

		const undeclared = await failureOf(harness, task('automations.midnight', {}));
		expect(undeclared).toBeInstanceOf(AccessControl.AccessDenied);
	});

	/**
	 * The durable surface the gate exists to preserve, from both sides.
	 *
	 * A blanket "refuse every credential-free tag" would have been simpler and would have killed this:
	 * `Approvals.decide` enqueues `collections.resume` with `{ requestId }` and nothing else, and its
	 * authority is the stored approval — `Approvals.resume` requires `Approved`, and the write replays
	 * under the subject recorded when the original create was authenticated. The same payload arriving
	 * on a `Plugin` is a post, not an enqueue, and lands no row.
	 */
	it('resumes an approved write on a task and refuses the same payload posted as a plugin', async () => {
		harness = await makeBoltTestRuntime(gatedWorkspace, { authored: gatedAuthored });
		const { runtime, effectId } = harness;
		const held = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).write(effectId('create-held'), policySubject, [
					{ collection: 'people', action: 'create', inputs: [{ name: 'Ada' }] }
				]);
			})
		);
		const requestId = held.pendingApproval?.requestId ?? '';
		expect(requestId).not.toBe('');

		const pending = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Approvals.Service).status(effectId('status'), requestId);
			})
		);
		if (pending?._tag !== 'Pending')
			throw new Error(`expected a pending approval, got ${String(pending?._tag)}`);
		// `Approvals.decide` is what enqueues the resume in production; it is driven here through the
		// stored state because the Tasks facility is deliberately unavailable in this harness.
		// Only the discriminant and the decider move. `status` answers the *public* projection, which
		// deliberately drops `subject` and the lock set — what the seal reads — so writing that
		// projection back would approve a request nothing could resume.
		await harness.database.query(
			`update bolt_approvals
			 set state = jsonb_set(jsonb_set(state, '{_tag}', '"Approved"'::jsonb), '{decidedBy}', to_jsonb($2::text))
			 where request_id = $1`,
			[requestId, adminSubject.userId]
		);

		// A gated create commits its row under the hold, so the stamp is what tells a refused resume
		// from an accepted one: held before, and still held after the post, which seals nothing.
		const beforePlugin = await harness.database.query('select approval_id from people');
		expect(beforePlugin).toEqual([{ approval_id: requestId }]);
		const posted = await outcomeOf(harness, plugin('collections.resume', { requestId }));
		expect(await harness.database.query('select approval_id from people')).toEqual([
			{ approval_id: requestId }
		]);
		expect(posted._tag === 'Failure' ? posted.failure : undefined).toBeInstanceOf(DispatchError);
		expect(posted._tag === 'Failure' ? posted.failure : undefined).toMatchObject({
			code: 'unauthorized',
			message: 'Missing command credential'
		});

		const resumed = await runtime.runPromise(
			dispatchInvocation(task('collections.resume', { requestId }))
		);
		expect(resumed.value).toMatchObject({ resumed: true, requestId });
		expect(await harness.database.query('select name from people')).toEqual([{ name: 'Ada' }]);
		// Released only by the task: the record is settled, and nothing holds it.
		expect(await harness.database.query('select approval_id from people')).toEqual([
			{ approval_id: null }
		]);
	});
});
