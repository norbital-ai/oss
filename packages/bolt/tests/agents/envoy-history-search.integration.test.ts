import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import * as Collections from '../../src/runtime/collections/collections.js';
import * as Database from '../../src/runtime/facilities/database.js';
import { HostTools } from '../../src/runtime/facilities/services.js';
import { executePlatformTool } from '../../src/runtime/agents/platform-tools.js';
import * as Workspace from '../../src/runtime/workspace.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('envoy history search scope', () => {
	it('takes no conversation id, gates envoy-wide reach, and pages nearest-first', async () => {
		harness = await makeBoltTestRuntime();
		for (const conversationId of ['desk:dm:first', 'desk:dm:second']) {
			await harness.database.query(
				`insert into chat_session
				 (conversation_id, agent_name, user_id, sandbox_key, visibility, envoy_key)
				 values ($1, 'desk', $2, 'envoy:desk', 'envoy_dm', 'desk')`,
				[conversationId, adminSubject.userId]
			);
		}
		await harness.database.query(
			`insert into chat_message (conversation_id, role, content, created_at) values
			 ($1, 'user', $2::jsonb, '2026-08-24T10:00:00.000Z'),
			 ($3, 'user', $4::jsonb, '2026-08-24T10:05:00.000Z')`,
			[
				'desk:dm:first',
				JSON.stringify({ kind: 'user_message', text: 'first marker', documents: [] }),
				'desk:dm:second',
				JSON.stringify({ kind: 'user_message', text: 'second marker', documents: [] })
			]
		);

		const run = (envoyWideHistory: boolean, input: Parameters<typeof executePlatformTool>[1]) =>
			harness!.runtime.runPromise(
				Effect.gen(function* () {
					const database = yield* Database.Service;
					const workspace = yield* Workspace.Service;
					const collections = yield* Collections.Service;
					const hostTools = yield* HostTools.Service;
					return yield* executePlatformTool('search_envoy_history', input, {
						effectId: harness!.effectId('search'),
						subject: adminSubject,
						agentName: 'desk',
						conversationId: 'desk:dm:first',
						database,
						envoyWideHistory,
						skills: [],
						toolNames: ['search_envoy_history'],
						collectionNames: [],
						workspace,
						collections,
						hostTools
					});
				})
			);

		await expect(run(false, { scope: 'this_envoy' })).rejects.toThrow(/not allowed/i);
		const local = (await run(false, {})) as { readonly messages: ReadonlyArray<unknown> };
		expect(JSON.stringify(local.messages)).toContain('first marker');
		expect(JSON.stringify(local.messages)).not.toContain('second marker');

		const wide = (await run(true, {
			scope: 'this_envoy',
			nearestTo: '2026-08-24T10:04:30.000Z',
			limit: 1
		})) as {
			readonly messages: ReadonlyArray<{ readonly content: string }>;
			readonly nextCursor: string | null;
		};
		expect(wide.messages[0]?.content).toContain('second marker');
		expect(wide.nextCursor).toBe('1');
		if (wide.nextCursor === null) throw new Error('expected a second history page');
		const next = (await run(true, {
			scope: 'this_envoy',
			nearestTo: '2026-08-24T10:04:30.000Z',
			limit: 1,
			cursor: wide.nextCursor
		})) as { readonly messages: ReadonlyArray<{ readonly content: string }> };
		expect(next.messages[0]?.content).toContain('first marker');
	});
});
