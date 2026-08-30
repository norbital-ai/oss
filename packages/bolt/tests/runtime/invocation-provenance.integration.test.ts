import { readFileSync } from 'node:fs';
import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	EnvironmentName,
	InvocationId,
	Invocation,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { approveBy } from '../../src/authoring/approval-flow.js';
import { automation } from '../../src/authoring/automations-schema.js';
import {
	describePolicy,
	policyRuntimeFunctionsFor
} from '../../src/authoring/policy-introspection.js';
import { collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import * as AccessControl from '../../src/runtime/access/access-control.js';
import * as Approvals from '../../src/runtime/approvals/approvals.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import { PendingApproval } from '../../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime } from '../../src/runtime/collections/authored.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	testWorkspace,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

/** Requests approval through the authored admin-team policy; administrator status bypasses it. */
const policySubject = { ...adminSubject, admin: false };

/**
 * Which invocation tags may reach the command switch at all.
 *
 * `POST /_bolt/plugin/<anything>/<command>` builds a `Plugin` invocation out of a URL and a request
 * body with no authentication anywhere, and a `Task` carries no credential by construction. Both
 * used to hand their input to the switch untouched, so the switch was a second, unauthenticated
 * command port. The provenance gate now defaults both credential-free tags to deny.
 *
 * These tests therefore hold the *whole* switch against the gate rather than a chosen sample, and
 * read the command list out of the dispatcher's own source so a case added tomorrow is covered
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
 * Every `case` label of the command switch, read from the dispatcher itself.
 *
 * A written-out list is a list somebody has to remember to extend, which is exactly how five
 * `schema.*` commands each shipped without a check. Slicing from the switch header keeps an
 * unrelated `switch` elsewhere in the file out of the result.
 *
 * The anchor is located rather than assumed. `indexOf` answers `-1` when the header moves, and
 * `slice(-1)` then hands the regex one character: the list comes back empty, and two of the three
 * tests below iterate it and pass having checked nothing at all. Renaming the switch's subject from
 * `invocation.command` to `command` did exactly that, and only the length assertion noticed.
 */
const dispatchSource = readFileSync(
	new URL('../../src/runtime/dispatch.ts', import.meta.url),
	'utf8'
);
const SWITCH_HEADER = 'switch (command) {';
const switchStart = dispatchSource.indexOf(SWITCH_HEADER);
if (switchStart < 0)
	throw new Error(`dispatch.ts no longer contains \`${SWITCH_HEADER}\`; this scrape reads nothing`);
const switchBody = dispatchSource.slice(switchStart);
const SWITCH_COMMANDS: ReadonlyArray<string> = [
	...switchBody.matchAll(/^\t+case '([a-zA-Z.]+)':/gmu)
].map((match) => match[1] ?? '');

/** The two prefixes the boundary resolves before the switch, so neither appears as a `case`. */
const PREFIX_COMMANDS: ReadonlyArray<string> = ['invoke.anything', 'schema.migrate'];

/**
 * The commands `dispatch.ts` names as runtime-enqueued, which are the only ones a `Task` may run.
 *
 * `automations.<name>` is not here because it is not a fixed string: it is resolved against the
 * automations the workspace declares, which the automation tests below cover from both sides.
 */
const ENQUEUED_COMMANDS: ReadonlyArray<string> = [
	'integrations.pull',
	'integrations.flush',
	'envoys.drain',
	// `tasks.tick` is not listed because it is not task-runnable: the command that runs other
	// commands is not itself one of them, so the tick is refused on a row.
	'envoys.complete',
	'collections.resume',
	'collections.discard'
];

const scopedInvocation = {
	protocolVersion: PROTOCOL_VERSION,
	scope,
	deadlineEpochMs: Date.now() + 30_000
};

const command = (name: string, credential: string, input: unknown = null) =>
	Invocation.cases.Command.make({
		...scopedInvocation,
		id: InvocationId.make(`command-${name}`),
		command: name,
		input: input as never,
		headers: { authorization: [`Bearer ${credential}`] }
	});

const task = (name: string, input: unknown = null) =>
	Invocation.cases.Task.make({
		...scopedInvocation,
		id: InvocationId.make(`task-${name}`),
		command: name,
		input: input as never,
		attempt: 0
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
					create: {
						approval: { flow: () => approveBy('approvers'), superceded_by: [] }
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
const gatedAuthored = {
	...emptyAuthoredRuntime,
	policyAuthorizations: gatedFunctions.authorizations,
	approvalFlows: gatedFunctions.approvalFlows
};

describe('invocation provenance', () => {
	// A regex that silently stops matching would make every loop below pass over an empty list, which
	// is the shape a green suite takes when it is proving nothing.
	it('reads the whole command switch out of the dispatcher', () => {
		expect(SWITCH_COMMANDS.length).toBeGreaterThan(40);
		expect(SWITCH_COMMANDS).toContain('identity.authenticate');
		expect(SWITCH_COMMANDS).toContain('notifications.drain');
		expect(SWITCH_COMMANDS).toContain('collections.resume');
		expect(new Set(SWITCH_COMMANDS).size).toBe(SWITCH_COMMANDS.length);
	});

	it('refuses every command in the switch on a plugin that is not the data browser', async () => {
		harness = await makeBoltTestRuntime(testWorkspace());
		for (const name of [...SWITCH_COMMANDS, ...PREFIX_COMMANDS]) {
			const failure = await failureOf(harness, plugin(name));
			expect(failure, name).toBeInstanceOf(AccessControl.AccessDenied);
			expect((failure as AccessControl.AccessDenied).reason, name).toContain(
				'carries no credential'
			);
			expect((failure as AccessControl.AccessDenied).resource, name).toBe(name);
		}
	});

	it('refuses every command in the switch on a task, except the ones the runtime enqueues', async () => {
		harness = await makeBoltTestRuntime(testWorkspace());
		for (const name of [...SWITCH_COMMANDS, ...PREFIX_COMMANDS]) {
			const outcome = await outcomeOf(harness, task(name));
			if (ENQUEUED_COMMANDS.includes(name)) {
				// Allowed past the gate, then refused by the schema its own case declares — which is the
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
			expect((failure as AccessControl.AccessDenied).reason, name).toContain(
				'not a command the runtime enqueues'
			);
		}
	});

	/**
	 * `automations.<name>` is the one enqueued command that is not a fixed string, and the five host
	 * commands under the same prefix are the reason it is resolved against the declared automations
	 * rather than matched on `automations.`.
	 */
	it('admits a declared automation on a task and still refuses the host commands sharing its prefix', async () => {
		harness = await makeBoltTestRuntime(gatedWorkspace, { authored: gatedAuthored });

		const declared = await outcomeOf(harness, task('automations.nightly', {}));
		expect(declared._tag).toBe('Failure');
		// Past the gate. The switch has no case for it because nothing dispatches a `Task` back into
		// Bolt yet, so the honest answer today is `unknown_command` and not a refusal.
		expect(declared._tag === 'Failure' ? declared.failure : undefined).not.toBeInstanceOf(
			AccessControl.AccessDenied
		);
		expect(
			declared._tag === 'Failure'
				? (declared.failure as { readonly code?: string }).code
				: undefined
		).toBe('unknown_command');

		for (const name of [
			'automations.start',
			'automations.runStep',
			'automations.resume',
			'automations.stop'
		]) {
			const failure = await failureOf(
				harness,
				task(name, { name: 'nightly', input: {}, taskId: 'task-1' })
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
		const id = recordId('person-1');

		const held = await runtime.runPromise(
			Effect.flip(
				Effect.gen(function* () {
					yield* (yield* Collections.Service).mutate(
						effectId('create-held'),
						policySubject,
						'people',
						[{ id, name: 'Ada' }],
						false,
						0,
						{ root: { id, action: 'create' } }
					);
				})
			)
		);
		expect(held).toBeInstanceOf(PendingApproval);
		const requestId = held instanceof PendingApproval ? held.requestId : '';

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
		// deliberately drops `storedGraph`, `subject` and `reviewDigest` — the three things a resume
		// replays from — so writing that projection back would approve a request nothing could resume.
		await harness.database.query(
			`update bolt_approvals
			 set state = jsonb_set(jsonb_set(state, '{_tag}', '"Approved"'::jsonb), '{decidedBy}', to_jsonb($2::text))
			 where request_id = $1`,
			[requestId, adminSubject.userId]
		);

		// A gated create stores its graph in the approval and writes no record, so the record settling
		// is what tells a refused resume from an accepted one: nothing before, and still nothing after
		// the post, which lands no row rather than landing one nobody approved.
		const beforePlugin = await harness.database.query('select approval_id from people');
		expect(beforePlugin).toEqual([]);
		const posted = await outcomeOf(harness, plugin('collections.resume', { requestId }));
		expect(await harness.database.query('select approval_id from people')).toEqual([]);
		expect(posted._tag === 'Failure' ? posted.failure : undefined).toBeInstanceOf(
			AccessControl.AccessDenied
		);

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
