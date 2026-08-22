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
import { envoy, policy, workspace } from '../../src/authoring/workspace-schema.js';
import { describeEnvoy } from '../../src/authoring/policy-introspection.js';
import { renderArtifact } from '../../src/compiler/sync.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import {
	listAccessibleEnvoys,
	publicEnvoyNames,
	sessionVisibleInScope
} from '../../src/client/ui/agent/conversation-selector.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';
import type { PlatformEnvoy } from '../../src/client/ui/state/platform.js';

/**
 * One authored envoy, followed from the file an author writes to the branch a reader's screen
 * depends on.
 *
 * Three separate places used to drop it, so fixing any one of them changed nothing anybody could
 * see: the compiler derived a channel from its filename and stamped `transport: 'agent'` and
 * `audience: 'both'` on every one; the manifest projection published only the name; and the client
 * fed the conversation selector a hard-coded empty map. This test is one chain rather than three
 * unit tests for that reason — each hop consumes the previous hop's actual output, so a regression
 * in any of them fails here, and none of them can be "fixed" alone into a green result.
 *
 * The declared transport and audience are deliberately the two the compiler used to fabricate:
 * `telegram` (not `agent`) and `public` (not `both`). Reverting the compiler fix makes the first
 * assertion read back the fabricated pair, and the selector then hides the envoy it should show.
 */
const root = '/workspace';

const authoredModule = {
	transport: 'telegram',
	audience: 'public',
	policies: ['sales_rep'],
	groupMessages: 'disabled',
	task: 'Answer questions about quotes and accounts for this customer.'
} as const;

const renderInput = (envoyFiles: ReadonlyArray<string>) =>
	({
		metadata: { name: 'crm', version: '1.0.0', description: 'Bolt workspace' },
		collections: [],
		relations: [],
		apps: [],
		policies: [],
		functions: [],
		toolFiles: [],
		envoyFiles,
		automations: [],
		automationFiles: [],
		pipelineFiles: [],
		skills: [],
		prompt: 'You are the crm workspace agent.',
		root,
		assets: [],
		customTypeDefinitions: [],
		environmentFile: undefined,
		migrations: []
	}) satisfies Parameters<typeof renderArtifact>[0];

/**
 * Runs the artifact's own envoy statement, rather than pattern-matching the text it is written in.
 *
 * A test that greps the generated source passes on the spelling of a line. This one executes the
 * emitted `declaredWorkspace` descriptor and the emitted merge against the authored module, so it
 * passes only if a declaration actually comes out of the compiler carrying what the author wrote.
 */
const compileEnvoyDeclaration = () => {
	const artifact = renderArtifact(renderInput([`${root}/src/envoys/+sales_desk.ts`]));

	const declarationStart = artifact.indexOf('const declaredWorkspace = ');
	const mergeStart = artifact.indexOf('const envoys = declaredWorkspace.envoys.map(');
	if (declarationStart < 0 || mergeStart < 0)
		throw new Error('the artifact no longer declares and merges envoys in one statement each');
	const mergeEnd = artifact.indexOf('\n', mergeStart);
	const source = `${artifact.slice(declarationStart, artifact.indexOf('\n};\n', declarationStart) + '\n};'.length)}\n${artifact.slice(mergeStart, mergeEnd)}\nreturn envoys;`;

	const compiled = new Function('declaredEnvoys', 'describeEnvoy', source)(
		{ sales_desk: authoredModule },
		describeEnvoy
	) as ReadonlyArray<ReturnType<typeof describeEnvoy>>;
	const [declaration] = compiled;
	if (declaration === undefined) throw new Error('the compiler produced no envoy at all');
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
		id: InvocationId.make('authored-envoy-1'),
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

describe('an authored envoy declaration', () => {
	it('survives compile, manifest and the conversation selector', async () => {
		// ── compile ────────────────────────────────────────────────────────────────────────────────
		// The name comes from the file and everything else from the module. There is no `agent` key:
		// the back-pointer the descriptor used to carry had the same value for every envoy in every
		// workspace, because there was only ever one synthesized agent to point at.
		const declaration = compileEnvoyDeclaration();
		expect(declaration).toEqual({ name: 'sales_desk', ...authoredModule });

		// ── manifest ───────────────────────────────────────────────────────────────────────────────
		harness = await makeBoltTestRuntime(
			workspace({
				name: 'crm',
				version: '1',
				collections: [],
				apps: [],
				policies: [
					policy({
						name: 'admin',
						effect: 'allow',
						actions: ['*'],
						capabilities: { apps: ['*'] }
					}),
					policy({ name: 'sales_rep', effect: 'allow', actions: ['read'] })
				],
				teams: { admin: ['admin'] },
				prompt: 'You are the crm workspace agent.',
				tools: [],
				skills: [],
				automations: [],
				envoys: [envoy({ name: 'sales_desk', ...authoredModule })],
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
			'envoys'
		] as ReadonlyArray<PlatformEnvoy>;
		expect(published).toEqual([
			{
				name: 'sales_desk',
				transport: 'telegram',
				audience: 'public',
				groupMessages: 'disabled'
			}
		]);

		// ── consumer ───────────────────────────────────────────────────────────────────────────────
		// An admin looking at their own inbox: the public envoy's tab is offered, and a thread that
		// arrived on it is theirs to answer. This is the branch `envoy.audience === 'public'` guards,
		// and with a fabricated `'both'` neither half of it happens.
		const ownInbox = {
			scopeUserId: 'admin-1',
			currentUserId: 'admin-1',
			isAdmin: true,
			publicEnvoyKeys: publicEnvoyNames(published)
		};
		expect([...ownInbox.publicEnvoyKeys]).toEqual(['sales_desk']);

		const outsiderThread = {
			conversation_id: 'session-1',
			title: 'Quote for 40 seats',
			user_id: 'outsider-1',
			visibility: 'envoy_dm',
			platform: 'telegram',
			envoy_key: 'sales_desk'
		};
		expect(sessionVisibleInScope(outsiderThread, ownInbox)).toBe(true);
		// A member, on the other hand, never sees an outsider's thread — the same declared value,
		// read the other way.
		expect(
			sessionVisibleInScope(outsiderThread, {
				scopeUserId: 'member-1',
				currentUserId: 'member-1',
				isAdmin: false,
				publicEnvoyKeys: ownInbox.publicEnvoyKeys
			})
		).toBe(false);

		const tabs = listAccessibleEnvoys({
			sessions: [outsiderThread],
			labels: { web: 'Web', users: 'Users', groups: 'Groups', envoyFallback: 'Envoy' },
			declaredEnvoys: published,
			scope: ownInbox
		});
		expect(tabs.map(({ id }) => id)).toEqual(['web', 'sales_desk']);
		// The transport reaches the tab's icon, which is the other authored value the compiler used to
		// overwrite: `transport: 'agent'` renders the generic mark for every envoy in every workspace.
		expect(tabs.find(({ id }) => id === 'sales_desk')?.icon).toBe('lucide:send');
	});

	/**
	 * The emitted import lines, which the test above cannot see.
	 *
	 * That one lifts two statements out of the artifact and runs them through `new Function`, so it
	 * proves the merge is correct while saying nothing about whether the file around it is valid
	 * JavaScript. Reading an envoy module means emitting an `import` per envoy and a lookup table
	 * keyed by name, and a compiler that emits those wrongly produces a workspace that fails to bundle
	 * rather than one that fails an assertion. Two envoys rather than one: a single entry hides
	 * whether the separator between table entries is emitted at all.
	 */
	it('emits a parseable artifact that imports every envoy module', () => {
		const artifact = renderArtifact(
			renderInput([`${root}/src/envoys/+sales_desk.ts`, `${root}/src/envoys/+member_desk.ts`])
		);
		expect(artifact).toContain('import envoy0 from "../../src/envoys/+sales_desk.js";');
		expect(artifact).toContain('import envoy1 from "../../src/envoys/+member_desk.js";');
		expect(artifact).toContain(
			'const declaredEnvoys = {"sales_desk": envoy0, "member_desk": envoy1};'
		);
		expect(() => parseAst(artifact)).not.toThrow();
	});

	/**
	 * `web` is the web agent's own tab, so an envoy cannot have it.
	 *
	 * Refused at authoring time rather than dropped at render time: the selector already puts a `web`
	 * entry in its map before it reads a single declaration, so an envoy called `web` would be
	 * silently swallowed by the tab that is already there — reachable by nobody, with nothing
	 * anywhere to say why.
	 */
	it('refuses the reserved name web', () => {
		expect(() => envoy({ name: 'web', ...authoredModule })).toThrow(/reserved/);
	});

	/** An envoy naming no policies would hold nothing, which is never what an envoy is for. */
	it('refuses an envoy that names no policies', () => {
		expect(() => envoy({ ...authoredModule, name: 'sales_desk', policies: [] })).toThrow(
			/names no policies/
		);
	});
});
