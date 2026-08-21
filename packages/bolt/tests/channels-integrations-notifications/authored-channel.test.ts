import { afterEach, describe, expect, it } from 'vitest';
import { seedSession } from '../support/fixture-identity.js';
import { parseAst } from 'vite';
import {
	EnvironmentName,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import {
	channel,
	policy,
	workspace,
	type ChannelDeclaration
} from '../../src/authoring/workspace-schema.js';
import { renderArtifact } from '../../src/compiler/sync.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import {
	listAccessibleChannels,
	publicChannelNames,
	sessionVisibleInScope
} from '../../src/client/ui/agent/conversation-selector.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';
import type { PlatformChannel } from '../../src/client/ui/state/platform.js';

/**
 * One authored channel, followed from the file an author writes to the branch a reader's screen
 * depends on.
 *
 * Three separate places used to drop it, so fixing any one of them changed nothing anybody could
 * see: the compiler derived a channel from its filename and stamped `transport: 'agent'` and
 * `audience: 'both'` on every one; the manifest projection published only the name; and the client
 * fed the conversation selector a hard-coded empty channel map. This test is one chain rather than
 * three unit tests for that reason — each hop consumes the previous hop's actual output, so a
 * regression in any of them fails here, and none of them can be "fixed" alone into a green result.
 *
 * The declared transport and audience are deliberately the two the compiler used to fabricate:
 * `telegram` (not `agent`) and `public` (not `both`). Reverting the compiler fix makes the first
 * assertion read back the fabricated pair, and the selector then hides the channel it should show.
 */
const root = '/workspace';

const authoredModule = {
	transport: 'telegram',
	policy: 'sales_rep',
	description: 'Customer-facing sales enquiries',
	audience: 'public',
	groupMessages: 'disabled',
	task: 'Answer questions about quotes and accounts for this customer.'
} as const;

/**
 * Runs the artifact's own channel statement, rather than pattern-matching the text it is written in.
 *
 * A test that greps the generated source passes on the spelling of a line. This one executes the
 * emitted `declaredWorkspace` descriptor and the emitted merge against the authored module, so it
 * passes only if a declaration actually comes out of the compiler carrying what the author wrote.
 */
const compileChannelDeclaration = (): ChannelDeclaration => {
	const artifact = renderArtifact({
		metadata: { name: 'crm', version: '1.0.0', description: 'Bolt workspace' },
		collections: [],
		relations: [],
		apps: [],
		policies: [],
		remotes: [],
		toolFiles: [],
		channelFiles: [`${root}/src/channels/+sales_desk.channel.ts`],
		automations: [],
		automationFiles: [],
		pipelineFiles: [],
		skills: [],
		agentName: 'crm',
		root,
		assets: [],
		customTypeDefinitions: [],
		environmentFile: undefined,
		migrations: []
	});

	const declarationStart = artifact.indexOf('const declaredWorkspace = ');
	const mergeStart = artifact.indexOf('const channels = declaredWorkspace.channels.map(');
	if (declarationStart < 0 || mergeStart < 0)
		throw new Error('the artifact no longer declares and merges channels in one statement each');
	const mergeEnd = artifact.indexOf('\n', mergeStart);
	const source = `${artifact.slice(declarationStart, artifact.indexOf('\n};\n', declarationStart) + '\n};'.length)}\n${artifact.slice(mergeStart, mergeEnd)}\nreturn channels;`;

	const compiled = new Function('declaredChannels', source)({
		sales_desk: authoredModule
	}) as ReadonlyArray<ChannelDeclaration>;
	const [declaration] = compiled;
	if (declaration === undefined) throw new Error('the compiler produced no channel at all');
	return declaration;
};

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const manifestInvocation = () =>
	Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make('authored-channel-1'),
		scope: {
			tenantId: TenantId.make('test-tenant'),
			environment: EnvironmentName.make('development'),
			releaseId: ReleaseId.make('local')
		},
		deadlineEpochMs: Date.now() + 30_000,
		command: 'workspace.manifest',
		input: null,
		headers: { authorization: ['Bearer admin-token'] }
	});

describe('an authored channel declaration', () => {
	it('survives compile, manifest and the conversation selector', async () => {
		// ── compile ────────────────────────────────────────────────────────────────────────────────
		const declaration = compileChannelDeclaration();
		expect(declaration).toEqual({
			name: 'sales_desk',
			agent: 'crm',
			...authoredModule
		});

		// ── manifest ───────────────────────────────────────────────────────────────────────────────
		harness = await makeBoltTestRuntime(
			workspace({
				name: 'crm',
				version: '1',
				collections: [],
				apps: [],
				policies: [policy({ name: 'admin', effect: 'allow', actions: ['*'], apps: ['*'] })],
				teams: {
					admin: ['admin']
				},
				agents: [],
				automations: [],
				channels: [channel(declaration)],
				integrations: [],
				requiredFacilities: []
			})
		);
		// Placed in `admin`, which the workspace above declares — the team is what carries the policy
		// granting `*`, so a consumer with no team would be refused before reaching the inbox.
		await seedSession(harness, {
			token: 'admin-token',
			user: 'user-admin-token',
			team: 'admin',
			email: 'admin@example.test'
		});
		const response = await harness.runtime.runPromise(dispatchInvocation(manifestInvocation()));
		const published = ((response.value ?? {}) as Record<string, unknown>)[
			'channels'
		] as ReadonlyArray<PlatformChannel>;
		expect(published).toEqual([
			{
				name: 'sales_desk',
				agent: 'crm',
				transport: 'telegram',
				audience: 'public',
				description: 'Customer-facing sales enquiries',
				groupMessages: 'disabled'
			}
		]);

		// ── consumer ───────────────────────────────────────────────────────────────────────────────
		// An admin looking at their own inbox: the public channel's tab is offered, and a thread that
		// arrived on it is theirs to answer. This is the branch `channel.audience === 'public'` guards,
		// and with a fabricated `'both'` neither half of it happens.
		const ownInbox = {
			scopeUserId: 'admin-1',
			currentUserId: 'admin-1',
			isAdmin: true,
			publicChannelKeys: publicChannelNames(published)
		};
		expect([...ownInbox.publicChannelKeys]).toEqual(['sales_desk']);

		const outsiderThread = {
			norbital_id: 'session-1',
			title: 'Quote for 40 seats',
			user_id: 'outsider-1',
			visibility: 'channel_dm',
			platform: 'telegram',
			channel_key: 'sales_desk'
		};
		expect(sessionVisibleInScope(outsiderThread, ownInbox)).toBe(true);
		// A member, on the other hand, never sees an outsider's thread — the same declared value,
		// read the other way.
		expect(
			sessionVisibleInScope(outsiderThread, {
				scopeUserId: 'member-1',
				currentUserId: 'member-1',
				isAdmin: false,
				publicChannelKeys: ownInbox.publicChannelKeys
			})
		).toBe(false);

		const tabs = listAccessibleChannels({
			sessions: [outsiderThread],
			labels: { web: 'Web', users: 'Users', groups: 'Groups', channelFallback: 'Agent' },
			declaredChannels: published,
			scope: ownInbox
		});
		expect(tabs.map(({ id }) => id)).toEqual(['web', 'sales_desk']);
		// The transport reaches the tab's icon, which is the other authored value the compiler used to
		// overwrite: `transport: 'agent'` renders the generic mark for every channel in every workspace.
		expect(tabs.find(({ id }) => id === 'sales_desk')?.icon).toBe('lucide:send');
	});

	/**
	 * The emitted import lines, which the test above cannot see.
	 *
	 * That one lifts two statements out of the artifact and runs them through `new Function`, so it
	 * proves the merge is correct while saying nothing about whether the file around it is valid
	 * JavaScript. Reading a channel module means emitting an `import` per channel and a lookup table
	 * keyed by name, and a compiler that emits those wrongly produces a workspace that fails to bundle
	 * rather than one that fails an assertion. Two channels rather than one: a single entry hides
	 * whether the separator between table entries is emitted at all.
	 */
	it('emits a parseable artifact that imports every channel module', () => {
		const artifact = renderArtifact({
			metadata: { name: 'crm', version: '1.0.0', description: 'Bolt workspace' },
			collections: [],
			relations: [],
			apps: [],
			policies: [],
			remotes: [],
			toolFiles: [],
			channelFiles: [
				`${root}/src/channels/+sales_desk.channel.ts`,
				`${root}/src/channels/+member_desk.channel.ts`
			],
			automations: [],
			automationFiles: [],
			pipelineFiles: [],
			skills: [],
			agentName: 'crm',
			root,
			assets: [],
			customTypeDefinitions: [],
			environmentFile: undefined,
			migrations: []
		});
		expect(artifact).toContain('import channel0 from "../../src/channels/+sales_desk.channel.js";');
		expect(artifact).toContain(
			'import channel1 from "../../src/channels/+member_desk.channel.js";'
		);
		expect(artifact).toContain(
			'const declaredChannels = {"sales_desk": channel0, "member_desk": channel1};'
		);
		expect(() => parseAst(artifact)).not.toThrow();
	});
});
