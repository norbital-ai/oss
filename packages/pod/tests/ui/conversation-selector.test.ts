import { describe, expect, it } from 'vitest';
import {
	WEB_CHANNEL_ID,
	buildConversationSelector,
	listAccessibleChannels,
	sessionVisibleInScope,
	type ConversationSession
} from '../../src/ui/agent/conversation-selector.js';

const labels: Parameters<typeof buildConversationSelector>[0]['labels'] = {
	web: 'Web',
	users: 'Users',
	groups: 'Groups',
	channelFallback: 'Channel agent'
};

function session(
	input: Partial<ConversationSession> & Pick<ConversationSession, 'norbital_id'>
): ConversationSession {
	return {
		title: input.title ?? input.norbital_id,
		user_id: input.user_id ?? 'me',
		visibility: input.visibility ?? 'personal',
		platform: input.platform ?? null,
		channel_key: input.channel_key ?? null,
		external_thread_id: input.external_thread_id ?? null,
		...input
	};
}

describe('sessionVisibleInScope', () => {
	const publicKeys = new Set(['support_bot']);
	const visible = (
		sessions: readonly ConversationSession[],
		scope: Parameters<typeof sessionVisibleInScope>[1]
	) => sessions.filter((row) => sessionVisibleInScope(row, scope));

	it('keeps a member inbox to their own threads and authenticated groups', () => {
		const scoped = visible(
			[
				session({ norbital_id: 'mine', title: 'Workspace agent' }),
				session({ norbital_id: 'alice', title: 'Alice thread', user_id: 'alice' }),
				session({
					norbital_id: 'group',
					title: 'Team',
					visibility: 'channel_group',
					channel_key: 'sales_desk',
					user_id: 'channel'
				}),
				session({
					norbital_id: 'public',
					title: 'Anon',
					visibility: 'channel_dm',
					channel_key: 'support_bot',
					user_id: 'anon'
				})
			],
			{
				scopeUserId: 'me',
				currentUserId: 'me',
				isAdmin: false,
				publicChannelKeys: publicKeys
			}
		);
		expect(scoped.map((row) => row.norbital_id)).toEqual(['mine', 'group']);
	});

	it('lets an admin personal scope include public channels and hide other members', () => {
		const scoped = visible(
			[
				session({ norbital_id: 'mine', title: 'Workspace agent' }),
				session({ norbital_id: 'alice', title: 'Onboarding', user_id: 'alice' }),
				session({
					norbital_id: 'public-dm',
					title: 'Visitor',
					visibility: 'channel_dm',
					channel_key: 'support_bot',
					user_id: 'anon'
				}),
				session({
					norbital_id: 'auth-group',
					title: 'Night shift',
					visibility: 'channel_group',
					channel_key: 'field_ops',
					user_id: 'channel'
				})
			],
			{
				scopeUserId: 'me',
				currentUserId: 'me',
				isAdmin: true,
				publicChannelKeys: publicKeys
			}
		);
		expect(scoped.map((row) => row.norbital_id)).toEqual(['mine', 'public-dm']);
	});

	it('keeps personal threads visible before the requestor id is known', () => {
		const scoped = visible(
			[session({ norbital_id: 'mine', title: 'Workspace agent', user_id: 'unknown-user' })],
			{
				scopeUserId: null,
				currentUserId: null,
				isAdmin: false,
				publicChannelKeys: publicKeys
			}
		);
		expect(scoped.map((row) => row.norbital_id)).toEqual(['mine']);
	});

	it('scopes an admin onto another member without public channels', () => {
		const scoped = visible(
			[
				session({ norbital_id: 'mine', title: 'Workspace agent' }),
				session({ norbital_id: 'alice', title: 'Onboarding', user_id: 'alice' }),
				session({
					norbital_id: 'public-dm',
					title: 'Visitor',
					visibility: 'channel_dm',
					channel_key: 'support_bot',
					user_id: 'anon'
				})
			],
			{
				scopeUserId: 'alice',
				currentUserId: 'me',
				isAdmin: true,
				publicChannelKeys: publicKeys
			}
		);
		expect(scoped.map((row) => row.norbital_id)).toEqual(['alice']);
	});
});

describe('buildConversationSelector', () => {
	it('keeps a web inbox flat and without tabs', () => {
		const model = buildConversationSelector({
			sessions: [
				session({ norbital_id: 'c1', title: 'Workspace agent' }),
				session({ norbital_id: 'c2', title: 'Skills discussion' })
			],
			labels
		});

		expect(model.showTabs).toBe(false);
		expect(model.channels).toEqual([{ id: WEB_CHANNEL_ID, label: 'Web', icon: 'lucide:monitor' }]);
		expect(model.rowsByChannel[WEB_CHANNEL_ID]).toEqual([
			expect.objectContaining({ kind: 'conversation', id: 'c1', title: 'Workspace agent' }),
			expect.objectContaining({ kind: 'conversation', id: 'c2', title: 'Skills discussion' })
		]);
	});

	it('does not group a personal inbox by person', () => {
		const model = buildConversationSelector({
			sessions: [
				session({ norbital_id: 'mine', title: 'My thread', user_id: 'me' }),
				session({ norbital_id: 'alice-1', title: 'Onboarding', user_id: 'alice' })
			],
			labels
		});
		expect(model.rowsByChannel[WEB_CHANNEL_ID]?.map((row) => row.kind)).toEqual([
			'conversation',
			'conversation'
		]);
	});

	it('adds channel tabs only when a non-web channel exists', () => {
		const model = buildConversationSelector({
			sessions: [
				session({ norbital_id: 'web-1', title: 'Workspace agent' }),
				session({
					norbital_id: 'tg-1',
					title: 'Invoice question',
					visibility: 'channel_dm',
					platform: 'telegram',
					channel_key: 'sales_desk',
					user_id: 'channel'
				})
			],
			labels
		});

		expect(model.showTabs).toBe(true);
		expect(model.channels.map((channel) => channel.id)).toEqual([WEB_CHANNEL_ID, 'sales_desk']);
		expect(model.channels[1]).toEqual({
			id: 'sales_desk',
			label: 'sales_desk',
			icon: 'lucide:send'
		});
	});

	it('splits a channel tab into users and groups when both exist', () => {
		const model = buildConversationSelector({
			sessions: [
				session({
					norbital_id: 'dm',
					title: 'Ada',
					visibility: 'channel_dm',
					platform: 'whatsapp',
					channel_key: 'field_ops',
					user_id: 'ada'
				}),
				session({
					norbital_id: 'group',
					title: 'Night shift',
					visibility: 'channel_group',
					platform: 'whatsapp',
					channel_key: 'field_ops',
					external_thread_id: 'wa-group-1'
				})
			],
			labels
		});

		expect(model.showTabs).toBe(false);
		expect(
			model.rowsByChannel.field_ops?.map((row) =>
				row.kind === 'heading' ? `${row.level}:${row.label}` : row.title
			)
		).toEqual(['0:Users', 'Ada', '0:Groups', 'Night shift']);
	});

	it('ignores unknown visibilities', () => {
		const model = buildConversationSelector({
			sessions: [session({ norbital_id: 'x', visibility: 'shared' })],
			labels
		});
		expect(model.channels).toEqual([]);
		expect(model.showTabs).toBe(false);
	});
});

describe('listAccessibleChannels', () => {
	const memberScope: Parameters<typeof sessionVisibleInScope>[1] = {
		scopeUserId: 'me',
		currentUserId: 'me',
		isAdmin: false,
		publicChannelKeys: new Set(['support_bot'])
	};
	const adminOwnScope: Parameters<typeof sessionVisibleInScope>[1] = {
		...memberScope,
		isAdmin: true
	};
	const adminImpersonating: Parameters<typeof sessionVisibleInScope>[1] = {
		scopeUserId: 'alice',
		currentUserId: 'me',
		isAdmin: true,
		publicChannelKeys: new Set(['support_bot'])
	};

	it('always includes web and authenticated manifest channels for a member', () => {
		expect(
			listAccessibleChannels({
				sessions: [session({ norbital_id: 'web-1' })],
				labels,
				manifestChannels: {
					sales_desk: { audience: 'authenticated', transport: 'telegram' },
					support_bot: { audience: 'public', transport: 'whatsapp' }
				},
				scope: memberScope
			}).map((channel) => channel.id)
		).toEqual([WEB_CHANNEL_ID, 'sales_desk']);
	});

	it('lets an admin personal scope include public channels', () => {
		expect(
			listAccessibleChannels({
				sessions: [],
				labels,
				manifestChannels: {
					support_bot: { audience: 'public', transport: 'whatsapp' }
				},
				scope: adminOwnScope
			}).map((channel) => channel.id)
		).toEqual([WEB_CHANNEL_ID, 'support_bot']);
	});

	it('hides public channels while impersonating another member', () => {
		expect(
			listAccessibleChannels({
				sessions: [session({ norbital_id: 'alice', user_id: 'alice' })],
				labels,
				manifestChannels: {
					support_bot: { audience: 'public', transport: 'whatsapp' }
				},
				scope: adminImpersonating
			}).map((channel) => channel.id)
		).toEqual([WEB_CHANNEL_ID]);
	});

	it('keeps a scoped thread whose channel left the manifest', () => {
		expect(
			listAccessibleChannels({
				sessions: [
					session({
						norbital_id: 'legacy',
						visibility: 'channel_dm',
						channel_key: 'retired_desk',
						platform: 'discord'
					})
				],
				labels,
				manifestChannels: {},
				scope: memberScope
			}).map((channel) => channel.id)
		).toEqual([WEB_CHANNEL_ID, 'retired_desk']);
	});
});
