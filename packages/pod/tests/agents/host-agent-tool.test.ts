import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { decodeWireValue, encodeWireValue } from '@norbital-ai/platform-utils/runtime/wire';
import type { HostAgentToolBinding } from '@norbital-ai/platform-utils/runtime/binding';
import { requiredRuntimeFacilities } from '@norbital-ai/platform-utils/runtime/binding';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import { facilityProxy } from '../../src/lib/runtime/serve.js';
import { assertHostAgentTools, hostAgentTools } from '../../src/lib/host/agent-tools.js';

/**
 * The host half of the stdio binding call, standing in for Core: decode the arguments, invoke the
 * real binding, encode and structured-clone the result. The clone is the point — it is what the
 * isolate boundary does to a return value, and it is what a callback would not survive.
 *
 * Deliberately the same dispatcher `facility-binding-shape.test.ts` uses. A host tool is reached
 * through exactly the wire `db` and `fileStorage` are reached through; if it needed a different one,
 * it would not be a facility.
 */
function hostDispatcher(bindings: Record<string, unknown>) {
	return async (facility: string, method: string, args: readonly unknown[]): Promise<unknown> => {
		const target = bindings[facility] as Record<string, unknown> | undefined;
		if (!target) throw new Error(`No ${facility} binding`);
		const member = target[method];
		if (typeof member !== 'function') {
			throw new Error(`${facility}.${method} is not callable across the isolate boundary`);
		}
		const decoded = args.map(decodeWireValue);
		const result: unknown = await (member as (...a: unknown[]) => unknown).apply(target, decoded);
		return structuredClone(encodeWireValue(result));
	};
}

const sandboxEcho = {
	name: 'sandbox_echo',
	description: 'Run a command in the host sandbox and return what it printed.',
	input: z.object({ command: z.string().min(1) }),
	run: (input: { command: string }) => ({ ran: 'host', stdout: `$ ${input.command}` })
};

function manifest(overrides: Partial<NorbitalManifest> = {}): NorbitalManifest {
	return {
		version: 1,
		collections: {},
		relationships: {},
		automations: {},
		...overrides
	} as NorbitalManifest;
}

describe('host agent tools across the isolate boundary', () => {
	/**
	 * The whole viability question in one test.
	 *
	 * A facility binding cannot carry a map of host functions — the proxy answers every property get
	 * with a call forwarder, and functions do not survive structured clone. But it can carry a
	 * `list()` whose *result* is data and a `run()` that names one tool, and that is enough: the tool
	 * set becomes something discovered at runtime rather than declared in the binding's type.
	 */
	it('discovers and invokes a host tool through the real serve.ts proxy', async () => {
		const call = hostDispatcher({ agentTools: hostAgentTools([sandboxEcho]) });
		const binding = facilityProxy<HostAgentToolBinding>('agentTools', call);

		const listed = await binding.list();
		expect(listed.map((tool) => tool.name)).toEqual(['sandbox_echo']);
		// A JSON Schema, not a Zod schema: the description has to be data on the far side.
		expect(listed[0]?.inputSchema).toMatchObject({ type: 'object' });

		const result = await binding.run('sandbox_echo', { command: 'pod build' });
		expect(result).toEqual({ ran: 'host', stdout: '$ pod build' });
	});

	/** Input is validated by the host, not only by the guest that relayed it. */
	it('refuses input the tool did not declare', async () => {
		const binding = facilityProxy<HostAgentToolBinding>(
			'agentTools',
			hostDispatcher({ agentTools: hostAgentTools([sandboxEcho]) })
		);
		await expect(binding.run('sandbox_echo', { command: 42 })).rejects.toThrow();
		await expect(binding.run('nothing_here', {})).rejects.toThrow(
			/supplies no agent tool named nothing_here/
		);
	});

	/** A tool whose result is not data comes back as nothing usable — the boundary's rule, restated. */
	it('cannot return a callback across the boundary', async () => {
		const binding = facilityProxy<HostAgentToolBinding>(
			'agentTools',
			hostDispatcher({
				agentTools: hostAgentTools([
					{
						name: 'gives_a_callback',
						description: 'Returns something the boundary cannot carry.',
						input: z.object({}),
						run: () => ({ next: () => 'never arrives' })
					}
				])
			})
		);
		await expect(binding.run('gives_a_callback', {})).rejects.toThrow();
	});
});

describe('assertHostAgentTools', () => {
	it('accepts a host tool whose name nothing else claims', () => {
		expect(() => assertHostAgentTools([sandboxEcho], manifest())).not.toThrow();
	});

	/**
	 * The requirement that motivated the check: a host tool must never silently shadow a workspace
	 * one. The workspace tool keeps compiling and keeps appearing in source — it just stops being what
	 * runs — so this has to be a refusal, and it has to happen at startup.
	 */
	it('refuses a host tool that shadows a workspace tool', () => {
		expect(() =>
			assertHostAgentTools(
				[{ ...sandboxEcho, name: 'create_quote' }],
				manifest({ agentTools: { create_quote: { name: 'create_quote', description: null } } })
			)
		).toThrow(/collides with the workspace agent tool/);
	});

	it('refuses a host tool that shadows a built-in loop tool', () => {
		expect(() =>
			assertHostAgentTools([{ ...sandboxEcho, name: 'read_collection' }], manifest())
		).toThrow(/collides with a built-in agent tool/);
	});

	it('refuses an unusable tool name and a duplicate one', () => {
		expect(() =>
			assertHostAgentTools([{ ...sandboxEcho, name: 'sandbox echo' }], manifest())
		).toThrow(/is not usable/);
		expect(() => assertHostAgentTools([sandboxEcho, sandboxEcho], manifest())).toThrow(
			/Duplicate host agent tool/
		);
	});

	/** The other direction: an agent naming a tool this host does not have, which is otherwise silent. */
	it('refuses a workspace whose agent names a host tool this host lacks', () => {
		const declared = manifest({
			automations: {
				nightly_deploy: {
					trigger: { schedule: '0 3 * * *' },
					spec: { kind: 'agent', task: 'Deploy.', hostTools: ['deploy_workspace'] }
				}
			}
		});
		expect(() => assertHostAgentTools([sandboxEcho], declared)).toThrow(
			/names host tool "deploy_workspace", which this host does not supply.*Available host tools: sandbox_echo/s
		);
		expect(() =>
			assertHostAgentTools([{ ...sandboxEcho, name: 'deploy_workspace' }], declared)
		).not.toThrow();
	});

	it('validates the Pod-owned interactive agent host tools too', () => {
		const declared = manifest({
			agent: {
				kind: 'agent',
				task: 'Help in this workspace.',
				hostTools: ['sandbox_read']
			}
		});
		expect(() => assertHostAgentTools([sandboxEcho], declared)).toThrow(
			/workspace agent.*names host tool "sandbox_read"/s
		);
		expect(() =>
			assertHostAgentTools([{ ...sandboxEcho, name: 'sandbox_read' }], declared)
		).not.toThrow();
		expect(requiredRuntimeFacilities(declared)).toEqual(
			expect.arrayContaining(['ai', 'agentTools'])
		);
		expect(requiredRuntimeFacilities(declared)).not.toContain('queue');
	});

	/** And the facility gate sees it, so a host with no tools at all refuses the workspace outright. */
	it('makes agentTools a facility the manifest can require', () => {
		expect(
			requiredRuntimeFacilities(
				manifest({
					automations: {
						nightly_deploy: {
							trigger: { schedule: '0 3 * * *' },
							spec: { kind: 'agent', task: 'Deploy.', hostTools: ['deploy_workspace'] }
						}
					}
				})
			)
		).toContain('agentTools');
	});
});
