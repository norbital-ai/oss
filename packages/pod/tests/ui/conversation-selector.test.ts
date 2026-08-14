import { describe, expect, it } from 'vitest';
import {
	WEB_CHANNEL_ID,
	buildConversationSelector,
	conversationComboboxOptions,
	listAccessibleChannels,
	scopeConversationSessions,
	type ConversationSelectorLabels,
	type ConversationScopeInput,
	type ConversationSession
} from '../../src/ui/agent/conversation-selector.js';

const labels: ConversationSelectorLabels = {
	web: 'Web',
	users: 'Users',
	groups: 'Groups',
	channelFallback: 'Channel agent'
};

function session(
	input: Partial<ConversationSession> & Pick<ConversationSession, 'id'>
): ConversationSession {
	return {
		title: input.title ?? input.id,
		userId: input.userId ?? 'me',
		visibility: input.visibility ?? 'personal',
		platform: input.platform ?? null,
		channelKey: input.channelKey ?? null,
		externalThreadId: input.externalThreadId ?? null,
		...input
	};
}

describe('scopeConversationSessions', () => {
	const publicKeys = new Set(['support_bot']);

	it('keeps a member inbox to their own threads and authenticated groups', () => {
		const scoped = scopeConversationSessions(
			[
				session({ id: 'mine', title: 'Workspace agent' }),
				session({ id: 'alice', title: 'Alice thread', userId: 'alice' }),
				session({
					id: 'group',
					title: 'Team',
					visibility: 'channel_group',
					channelKey: 'sales_desk',
					userId: 'channel'
				}),
				session({
					id: 'public',
					title: 'Anon',
					visibility: 'channel_dm',
					channelKey: 'support_bot',
					userId: 'anon'
				})
			],
			{
				scopeUserId: 'me',
				currentUserId: 'me',
				isAdmin: false,
				publicChannelKeys: publicKeys
			}
		);
		expect(scoped.map((row) => row.id)).toEqual(['mine', 'group']);
	});

	it('lets an admin personal scope include public channels and hide other members', () => {
		const scoped = scopeConversationSessions(
			[
				session({ id: 'mine', title: 'Workspace agent' }),
				session({ id: 'alice', title: 'Onboarding', userId: 'alice' }),
				session({
					id: 'public-dm',
					title: 'Visitor',
					visibility: 'channel_dm',
					channelKey: 'support_bot',
					userId: 'anon'
				}),
				session({
					id: 'auth-group',
					title: 'Night shift',
					visibility: 'channel_group',
					channelKey: 'field_ops',
					userId: 'channel'
				})
			],
			{
				scopeUserId: 'me',
				currentUserId: 'me',
				isAdmin: true,
				publicChannelKeys: publicKeys
			}
		);
		expect(scoped.map((row) => row.id)).toEqual(['mine', 'public-dm']);
	});

	it('keeps personal threads visible before the requestor id is known', () => {
		const scoped = scopeConversationSessions(
			[session({ id: 'mine', title: 'Workspace agent', userId: 'unknown-user' })],
			{
				scopeUserId: null,
				currentUserId: null,
				isAdmin: false,
				publicChannelKeys: publicKeys
			}
		);
		expect(scoped.map((row) => row.id)).toEqual(['mine']);
	});

	it('scopes an admin onto another member without public channels', () => {
		const scoped = scopeConversationSessions(
			[
				session({ id: 'mine', title: 'Workspace agent' }),
				session({ id: 'alice', title: 'Onboarding', userId: 'alice' }),
				session({
					id: 'public-dm',
					title: 'Visitor',
					visibility: 'channel_dm',
					channelKey: 'support_bot',
					userId: 'anon'
				})
			],
			{
				scopeUserId: 'alice',
				currentUserId: 'me',
				isAdmin: true,
				publicChannelKeys: publicKeys
			}
		);
		expect(scoped.map((row) => row.id)).toEqual(['alice']);
	});
});

describe('buildConversationSelector', () => {
	it('keeps a web inbox flat and without tabs', () => {
		const model = buildConversationSelector({
			sessions: [
				session({ id: 'c1', title: 'Workspace agent' }),
				session({ id: 'c2', title: 'Skills discussion' })
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
				session({ id: 'mine', title: 'My thread', userId: 'me' }),
				session({ id: 'alice-1', title: 'Onboarding', userId: 'alice' })
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
				session({ id: 'web-1', title: 'Workspace agent' }),
				session({
					id: 'tg-1',
					title: 'Invoice question',
					visibility: 'channel_dm',
					platform: 'telegram',
					channelKey: 'sales_desk',
					userId: 'channel'
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
					id: 'dm',
					title: 'Ada',
					visibility: 'channel_dm',
					platform: 'whatsapp',
					channelKey: 'field_ops',
					userId: 'ada'
				}),
				session({
					id: 'group',
					title: 'Night shift',
					visibility: 'channel_group',
					platform: 'whatsapp',
					channelKey: 'field_ops',
					externalThreadId: 'wa-group-1'
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
			sessions: [session({ id: 'x', visibility: 'shared' })],
			labels
		});
		expect(model.channels).toEqual([]);
		expect(model.showTabs).toBe(false);
	});
});

describe('conversationComboboxOptions', () => {
	it('keeps a personal inbox flat without group headers', () => {
		const model = buildConversationSelector({
			sessions: [
				session({ id: 'c1', title: 'Workspace agent' }),
				session({ id: 'c2', title: 'Skills discussion' })
			],
			labels
		});
		expect(conversationComboboxOptions(model)).toEqual([
			expect.objectContaining({ value: 'c1', label: 'Workspace agent' }),
			expect.objectContaining({ value: 'c2', label: 'Skills discussion' })
		]);
		expect(conversationComboboxOptions(model).every((option) => option.type == null)).toBe(true);
	});

	it('groups users and groups when both exist on a channel', () => {
		const model = buildConversationSelector({
			sessions: [
				session({
					id: 'dm',
					title: 'Ada',
					visibility: 'channel_dm',
					channelKey: 'desk',
					userId: 'ada'
				}),
				session({
					id: 'group',
					title: 'Night shift',
					visibility: 'channel_group',
					channelKey: 'desk'
				})
			],
			labels
		});
		expect(conversationComboboxOptions(model)).toEqual([
			expect.objectContaining({ value: 'dm', label: 'Ada', type: 'Users' }),
			expect.objectContaining({ value: 'group', label: 'Night shift', type: 'Groups' })
		]);
	});
});

describe('listAccessibleChannels', () => {
	const memberScope: ConversationScopeInput = {
		scopeUserId: 'me',
		currentUserId: 'me',
		isAdmin: false,
		publicChannelKeys: new Set(['support_bot'])
	};
	const adminOwnScope: ConversationScopeInput = {
		...memberScope,
		isAdmin: true
	};
	const adminImpersonating: ConversationScopeInput = {
		scopeUserId: 'alice',
		currentUserId: 'me',
		isAdmin: true,
		publicChannelKeys: new Set(['support_bot'])
	};

	it('always includes web and authenticated manifest channels for a member', () => {
		expect(
			listAccessibleChannels({
				sessions: [session({ id: 'web-1' })],
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
				sessions: [session({ id: 'alice', userId: 'alice' })],
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
						id: 'legacy',
						visibility: 'channel_dm',
						channelKey: 'retired_desk',
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
