import { readFileSync } from 'node:fs';
import { fixtureUserId, seedSession } from '../support/fixture-identity.js';
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
import { automation } from '../../src/authoring/automations-schema.js';
import { collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import { AccessControl } from '../../src/runtime/access/access-control.js';
import { Approvals } from '../../src/runtime/approvals/approvals.js';
import { Collections, PendingApproval } from '../../src/runtime/collections/collections.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	testWorkspace,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

/**
 * Which invocation tags may reach the command switch at all.
 *
 * `POST /_bolt/plugin/<anything>/<command>` builds a `Plugin` invocation out of a URL and a request
 * body with no authentication anywhere, and a `Task` carries no credential by construction. Both
 * used to hand their input to the switch untouched, so the switch was a second, unauthenticated
 * command port. The identity gate closed the cases that name an identity to forge; what it could not
 * see is the larger half that carries none — `identity.endSession` revokes a session by bare token,
 * `notifications.list` reads any recipient's mail, `integrations.install` and `channels.register`
 * rewire the host.
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
	// A delegated turn. `sandbox-tools.ts` has enqueued `agents.turn` since delegation was written,
	// and it was never listed here — harmless only for as long as nothing executed the queue. The
	// first tick would have refused every subagent, and the refusal would have named the provenance
	// gate rather than the missing entry. (`tasks.tick` is not listed because it is not task-runnable:
	// the command that runs other commands is not itself one of them, so the tick is refused on a
	// row.)
	'agents.turn',
	'agents.resume',
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
			fields: { name: field.string({ required: true }) },
			approvalLock: true
		})
	],
	apps: [],
	policies: [
		policy({ name: 'admin', effect: 'allow', actions: ['*'], apps: ['*'] })
	],
	teams: {
		admin: ['admin']
	},
	agents: [],
	automations: [
		automation({
			name: 'nightly',
			trigger: { _tag: 'Schedule', cron: '0 0 * * *' },
			command: 'automations.nightly'
		})
	],
	channels: [],
	integrations: [],
	requiredFacilities: []
});

describe('invocation provenance', () => {
	// A regex that silently stops matching would make every loop below pass over an empty list, which
	// is the shape a green suite takes when it is proving nothing.
	it('reads the whole command switch out of the dispatcher', () => {
		expect(SWITCH_COMMANDS.length).toBeGreaterThan(70);
		expect(SWITCH_COMMANDS).toContain('identity.endSession');
		expect(SWITCH_COMMANDS).toContain('notifications.list');
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
	 * `automations.<name>` is the one enqueued command that is not a fixed string, and the six host
	 * commands under the same prefix are the reason it is resolved against the declared automations
	 * rather than matched on `automations.`.
	 */
	it('admits a declared automation on a task and still refuses the host commands sharing its prefix', async () => {
		harness = await makeBoltTestRuntime(gatedWorkspace);

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
			'automations.register',
			'automations.runStep',
			'automations.resume',
			'automations.status',
			'automations.cancel'
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
	 * The exploit, not the refusal.
	 *
	 * `identity.endSession` takes a bare token and revokes it, and carries no identity for the earlier
	 * gate to notice — so an unauthenticated `POST /_bolt/plugin/x/identity.endSession` logged out any
	 * session whose token the caller held or guessed. The session is read back *before* the refusal is
	 * asserted, so reverting the gate fails this on the revoked session rather than on a missing error:
	 * the diagnostic is the exploit landing, not a message about it.
	 */
	it('leaves a live session usable after an unauthenticated plugin tries to revoke it', async () => {
		harness = await makeBoltTestRuntime(testWorkspace());
		// `admin` is the team `testWorkspace` declares holding the policy that grants `*` — the session
		// has to be a usable one for the revocation attempt below to have anything to take away.
		await seedSession(harness, { token: 'admin-token', user: 'user-admin-token', team: 'admin' });

		const outcome = await outcomeOf(
			harness,
			plugin('identity.endSession', { credential: 'admin-token' })
		);

		expect(
			await harness.database.query(
				'select count(*)::int as live from bolt_auth_session where "token" = $1',
				['admin-token']
			)
		).toEqual([{ live: 1 }]);
		const still = await harness.runtime.runPromise(
			dispatchInvocation(
				command('identity.authenticate', 'admin-token', { credential: 'admin-token' })
			)
		);
		expect(still.value).toMatchObject({
			userId: fixtureUserId('user-admin-token'),
			tenantId: 'test-tenant'
		});
		expect(outcome._tag === 'Failure' ? outcome.failure : undefined).toBeInstanceOf(
			AccessControl.AccessDenied
		);
	});

	/**
	 * The durable surface the gate exists to preserve, from both sides.
	 *
	 * A blanket "refuse every credential-free tag" would have been simpler and would have killed this:
	 * `Approvals.decide` enqueues `collections.resume` with `{ requestId }` and nothing else, and its
	 * authority is the stored approval — `authorizeResume` requires `Approved`, and the write replays
	 * under the subject recorded when the original create was authenticated. The same payload arriving
	 * on a `Plugin` is a post, not an enqueue, and lands no row.
	 */
	it('resumes an approved write on a task and refuses the same payload posted as a plugin', async () => {
		harness = await makeBoltTestRuntime(gatedWorkspace);
		const { runtime, effectId } = harness;
		const id = recordId('person-1');

		const held = await runtime.runPromise(
			Effect.flip(
				Effect.gen(function* () {
					yield* (yield* Collections.Service).create(effectId('create-held'), adminSubject, {
						collection: 'people',
						id,
						values: { name: 'Ada' }
					});
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
		await harness.database.query('update bolt_approvals set state = $2 where request_id = $1', [
			requestId,
			{ _tag: 'Approved', requestId, decidedBy: adminSubject.userId, operation: pending.operation }
		]);

		// The lock first, for the same reason the row used to come first: the failure to see when the
		// gate is gone is the record settling. It is the lock and not the row's existence that says so
		// now — a gated create writes its row up front and holds it, so "no row" no longer distinguishes
		// a refused resume from an accepted one, and asserting it would have passed either way.
		const heldAfterPlugin = await harness.database.query('select norbital_approval_id from people');
		const posted = await outcomeOf(harness, plugin('collections.resume', { requestId }));
		expect(heldAfterPlugin[0]?.['norbital_approval_id']).toEqual(expect.any(String));
		expect(await harness.database.query('select norbital_approval_id from people')).toEqual(
			heldAfterPlugin
		);
		expect(posted._tag === 'Failure' ? posted.failure : undefined).toBeInstanceOf(
			AccessControl.AccessDenied
		);

		const resumed = await runtime.runPromise(
			dispatchInvocation(task('collections.resume', { requestId }))
		);
		expect(resumed.value).toMatchObject({ resumed: true, requestId });
		expect(await harness.database.query('select name from people')).toEqual([{ name: 'Ada' }]);
		// Released only by the task: the record is settled, and nothing holds it.
		expect(await harness.database.query('select norbital_approval_id from people')).toEqual([
			{ norbital_approval_id: null }
		]);
	});
});
