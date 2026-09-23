import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { envoy, policy, workspace } from '../src/authoring/workspace-schema.js';
import { buildSchemaPlan } from '../src/runtime/schema/schema-plan.js';
import * as Channels from '../src/runtime/channels/channels.js';
import { automationChannels } from '../src/runtime/channels/channels.js';
import * as Database from '../src/runtime/facilities/database.js';
import * as TaskQueue from '../src/runtime/tasks/tasks.js';
import { makeBoltTestRuntime, testChannels } from './support/bolt-test-layer.js';

/** A workspace that declares a channel and an envoy on it, and nothing else of note. */
const channelled = (channels = testChannels('whatsapp')) =>
	workspace({
		name: 'channelled',
		version: '1',
		collections: [],
		apps: [],
		policies: [policy({ name: 'member', effect: 'allow', actions: ['read'] })],
		automations: [],
		channels,
		envoys: [
			envoy({
				name: 'support',
				channel: 'whatsapp',
				audience: 'authenticated',
				policies: ['member'],
				delegation: 'enabled',
				task: 'Answer support questions for this member.'
			})
		],
		integrations: [],
		prompt: 'You are the test workspace agent.',
		tools: [],
		skills: [],
		requiredFacilities: []
	});

describe('channel and sync tables', () => {
	/** The plan is the only thing that creates these tables; the ids make a regression visible. */
	it('plans the channel and sync tables the runtime reads and writes', () => {
		const ids = buildSchemaPlan(channelled()).steps.map(({ id }) => id);
		for (const table of [
			'channel_messages',
			'bolt_channel_state',
			'bolt_channel_outbox',
			'bolt_channel_links',
			'bolt_integration_state',
			'bolt_integration_links',
			'bolt_integration_pushes',
			'bolt_integration_conflicts'
		])
			expect(ids).toContain(`collection:${table}`);
	});

	it('answers channel status against a freshly provisioned database', async () => {
		const harness = await makeBoltTestRuntime(channelled());
		try {
			const status = (label: string) =>
				harness.runtime.runPromise(
					Effect.flatMap(Channels.Service, (channels) => channels.status(harness.effectId(label), 'whatsapp'))
				);
			expect(await status('before')).toEqual({
				channel: 'whatsapp',
				transport: 'whatsapp',
				history: 'unlinked',
				horizon: null,
				lastInboundAt: null,
				received: 0,
				sent: 0,
				pending: 0,
				failed: 0
			});
		} finally {
			await harness.dispose();
		}
	});

	it('refuses a notification with nowhere to go', async () => {
		const harness = await makeBoltTestRuntime(channelled());
		try {
			const notify = (via: ReadonlyArray<string>) =>
				harness.runtime.runPromise(
					Effect.gen(function* () {
						const ops = automationChannels(
							yield* Database.Service,
							yield* TaskQueue.Service,
							testChannels('whatsapp'),
							[],
							harness.effectId('notify')
						);
						return yield* ops.notify({
							key: 'k',
							recipients: ['user-1'],
							title: 't',
							body: 'b',
							via: via as readonly [string, ...string[]]
						});
					})
				);
			await expect(notify([])).rejects.toMatchObject({ message: expect.stringMatching(/non-empty via/) });
			await expect(notify(['inbox'])).rejects.toMatchObject({ message: expect.stringMatching(/no person channel/) });
		} finally {
			await harness.dispose();
		}
	});
});
