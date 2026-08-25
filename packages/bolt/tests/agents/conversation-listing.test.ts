import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { SYSTEM_MODEL_TABLES } from '../../src/authoring/system-models.js';
import { envoy } from '../../src/authoring/workspace-schema.js';
import * as Agents from '../../src/runtime/agents/agents.js';
import type * as Identity from '../../src/runtime/identity/identity.js';
import { composer } from '../../src/runtime/persistence.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

let harness: BoltTestRuntime | undefined;
const { chat_session: chatSession, chat_message: chatMessage } = SYSTEM_MODEL_TABLES;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const memberSubject: Identity.Subject = {
	userId: 'member-1',
	tenantId: adminSubject.tenantId,
	teamPath: [],
	policies: [],
	admin: false
};

const publicDesk = envoy({
	name: 'public_desk',
	transport: 'whatsapp',
	audience: 'public',
	policies: ['admin'],
	task: 'Answer public enquiries.',
	groupMessages: 'mention_or_reply'
});

const memberDesk = envoy({
	name: 'member_desk',
	transport: 'whatsapp',
	audience: 'authenticated',
	policies: ['admin'],
	task: 'Answer signed-in members.',
	groupMessages: 'disabled'
});

type ConversationFixture = Readonly<{
	readonly id: string;
	readonly agent: string;
	readonly user: string;
	readonly visibility: 'personal' | 'envoy_dm' | 'envoy_group';
	readonly envoyKey: string | null;
	readonly parentId?: string;
}>;

const fixtures: ReadonlyArray<ConversationFixture> = [
	{
		id: 'admin-personal',
		agent: 'web',
		user: adminSubject.userId,
		visibility: 'personal',
		envoyKey: null
	},
	{
		id: 'member-personal',
		agent: 'web',
		user: memberSubject.userId,
		visibility: 'personal',
		envoyKey: null
	},
	{
		id: 'member-authenticated-envoy',
		agent: 'member_desk',
		user: memberSubject.userId,
		visibility: 'envoy_dm',
		envoyKey: 'member_desk'
	},
	{
		id: 'public-dm',
		agent: 'public_desk',
		user: 'envoy:public_desk#public-dm',
		visibility: 'envoy_dm',
		envoyKey: 'public_desk'
	},
	{
		id: 'public-group',
		agent: 'public_desk',
		user: 'envoy:public_desk#public-group',
		visibility: 'envoy_group',
		envoyKey: 'public_desk'
	},
	// A private sandbox carrying a public key is still private: the sandbox-key invariant refuses it.
	{
		id: 'mislabelled-private',
		agent: 'public_desk',
		user: 'member-2',
		visibility: 'envoy_dm',
		envoyKey: 'public_desk'
	},
	// A removed declaration is not an inbox grant in the release currently serving this request.
	{
		id: 'retired-public',
		agent: 'retired_desk',
		user: 'envoy:retired_desk#retired-public',
		visibility: 'envoy_dm',
		envoyKey: 'retired_desk'
	},
	{
		id: 'delegated-review',
		agent: 'web',
		user: adminSubject.userId,
		visibility: 'personal',
		envoyKey: null,
		parentId: 'admin-personal'
	}
];

const listFor = (runtime: BoltTestRuntime, subject: Identity.Subject) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			return yield* (yield* Agents.Service).listConversations(
				runtime.effectId(`list:${subject.userId}`),
				subject
			);
		})
	);

const historyFor = (runtime: BoltTestRuntime, subject: Identity.Subject, conversationId: string) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			return yield* (yield* Agents.Service).history(
				runtime.effectId(`history:${subject.userId}:${conversationId}`),
				subject,
				conversationId
			);
		})
	);

describe('agent conversation inbox authority', () => {
	it('commits a new conversation, turn, mailbox, task and run before inference', async () => {
		harness = await makeBoltTestRuntime(testWorkspace());
		const runtime = harness;
		const admitted = await runtime.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Agents.Service).enqueue(
					runtime.effectId('atomic-admission'),
					adminSubject,
					'web',
					'atomic-conversation',
					{ kind: 'user_message', text: 'Run payroll', documents: [] }
				);
			})
		);
		expect(admitted).toMatchObject({
			conversationId: 'atomic-conversation',
			status: 'queued'
		});

		const counts = await runtime.database.query(
			`select
				(select count(*)::int from chat_session where conversation_id = $1) as sessions,
				(select count(*)::int from chat_message where conversation_id = $1) as messages,
				(select count(*)::int from agent_mailbox where conversation_id = $1) as mailboxes,
				(select count(*)::int from bolt_task where lane = $1) as tasks,
				(select count(*)::int from agent_run where conversation_id = $1) as runs`,
			['atomic-conversation']
		);
		expect(counts[0]).toEqual({ sessions: 1, messages: 2, mailboxes: 1, tasks: 1, runs: 1 });
	});

	it('keeps personal threads isolated and exposes only exact declared-public envoy rows to admins', async () => {
		harness = await makeBoltTestRuntime(testWorkspace({ envoys: [publicDesk, memberDesk] }));
		for (const row of fixtures) {
			const inserted = composer
				.insert(chatSession)
				.values({
					conversation_id: row.id,
					agent_name: row.agent,
					user_id: row.user,
					sandbox_key:
						row.id === 'mislabelled-private'
							? row.user
							: row.envoyKey === null
								? row.user
								: `envoy:${row.envoyKey}`,
					title: `Title: ${row.id}`,
					visibility: row.visibility,
					envoy_key: row.envoyKey,
					parent_id: row.parentId ?? null
				})
				.toSQL();
			await harness.database.query(inserted.sql, inserted.params);
		}
		const message = composer
			.insert(chatMessage)
			.values({
				conversation_id: 'public-dm',
				role: 'user',
				content: JSON.stringify({
					kind: 'user_message',
					text: 'Can I get a quote?',
					documents: []
				})
			})
			.toSQL();
		await harness.database.query(message.sql, message.params);

		const adminRows = await listFor(harness, adminSubject);
		expect(adminRows.map(({ id }) => id).sort()).toEqual(
			['admin-personal', 'public-dm', 'public-group'].sort()
		);
		expect(adminRows.find(({ id }) => id === 'public-dm')).toEqual({
			id: 'public-dm',
			agent_name: 'public_desk',
			title: 'Title: public-dm',
			user_id: 'envoy:public_desk#public-dm',
			visibility: 'envoy_dm',
			envoy_key: 'public_desk'
		});

		const memberRows = await listFor(harness, memberSubject);
		expect(memberRows.map(({ id }) => id).sort()).toEqual(
			['member-authenticated-envoy', 'member-personal'].sort()
		);
		expect(memberRows).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ envoy_key: 'public_desk' })])
		);

		const publicHistory = await historyFor(harness, adminSubject, 'public-dm');
		expect(publicHistory.messages).toEqual([
			{
				role: 'user',
				content: { kind: 'user_message', text: 'Can I get a quote?', documents: [] },
				turn_id: null
			}
		]);
		await expect(historyFor(harness, adminSubject, 'member-personal')).rejects.toMatchObject({
			_tag: 'Bolt.AccessControl.AccessDenied'
		});
		await expect(historyFor(harness, memberSubject, 'public-dm')).rejects.toMatchObject({
			_tag: 'Bolt.AccessControl.AccessDenied'
		});
		expect((await historyFor(harness, memberSubject, 'member-personal')).conversationId).toBe(
			'member-personal'
		);
	});
});
