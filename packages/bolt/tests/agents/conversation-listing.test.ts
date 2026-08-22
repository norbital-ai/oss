import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { envoy } from '../../src/authoring/workspace-schema.js';
import * as Agents from '../../src/runtime/agents/agents.js';
import type * as Identity from '../../src/runtime/identity/identity.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

let harness: BoltTestRuntime | undefined;
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
		id: 'subagent:admin-personal:tool:0',
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
	it('keeps personal threads isolated and exposes only exact declared-public envoy rows to admins', async () => {
		harness = await makeBoltTestRuntime(testWorkspace({ envoys: [publicDesk, memberDesk] }));
		for (const row of fixtures) {
			await harness.database.query(
				`insert into chat_session
					(conversation_id, agent_name, user_id, title, visibility, envoy_key, parent_id)
				 values ($1, $2, $3, $4, $5, $6, $7)`,
				[
					row.id,
					row.agent,
					row.user,
					`Title: ${row.id}`,
					row.visibility,
					row.envoyKey,
					row.parentId ?? null
				]
			);
		}
		await harness.database.query(
			"insert into chat_message (conversation_id, role, content) values ($1, 'user', $2::jsonb)",
			['public-dm', JSON.stringify('Can I get a quote?')]
		);

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
			{ role: 'user', content: 'Can I get a quote?', turn_id: null }
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
