import type { PlatformChannel } from '../state/platform.js';

export const WEB_CHANNEL_ID = 'web';

const SELECTOR_LABEL_KEYS = ['web', 'users', 'groups', 'channelFallback'] as const;
const CONVERSATION_VISIBILITIES = new Set<string>(['personal', 'channel_dm', 'channel_group']);

type SelectorLabels = Record<(typeof SELECTOR_LABEL_KEYS)[number], string>;

export type ConversationSession = {
	readonly norbital_id: string;
	readonly title: string | null;
	readonly user_id: string;
	readonly visibility: string;
	readonly platform?: string | null;
	readonly channel_key?: string | null;
	readonly external_thread_id?: string | null;
};

/** Channel tab id for a session: personal stays on web, otherwise the transport key. */
export function sessionChannelId(
	session: ConversationSession,
	labels: Pick<SelectorLabels, 'channelFallback'>
): string {
	if (session.visibility === 'personal') return WEB_CHANNEL_ID;
	return session.channel_key ?? labels.channelFallback;
}

/** Whether this session belongs in the current admin/member conversation scope. */
export function sessionVisibleInScope(
	session: ConversationSession,
	scope: {
		readonly scopeUserId: string | null;
		readonly currentUserId: string | null;
		readonly isAdmin: boolean;
		readonly publicChannelKeys: ReadonlySet<string>;
	}
): boolean {
	if (!CONVERSATION_VISIBILITIES.has(session.visibility)) return false;
	const isPublicChannel =
		session.channel_key != null && scope.publicChannelKeys.has(session.channel_key);
	if (isPublicChannel) {
		return scope.isAdmin && scope.scopeUserId === scope.currentUserId;
	}
	if (session.visibility === 'channel_group') {
		return !scope.isAdmin;
	}
	if (session.visibility === 'personal' && scope.scopeUserId == null) return true;
	return scope.scopeUserId != null && session.user_id === scope.scopeUserId;
}

/**
 * The declared channels an outsider can reach without an account.
 *
 * Split out of the panel so the rule is where the other channel rules are and can be exercised on
 * its own: a channel's `audience` is the only thing that decides whether its threads belong in the
 * admin inbox, and the panel used to derive that set inline from a manifest projection that was
 * always empty.
 */
export function publicChannelNames(channels: readonly PlatformChannel[]): ReadonlySet<string> {
	return new Set(channels.filter((channel) => channel.audience === 'public').map(({ name }) => name));
}

/** Channels the current scope may inspect: Web, allowed manifest entries, plus any scoped thread. */
export function listAccessibleChannels(input: {
	readonly sessions: readonly ConversationSession[];
	readonly labels: SelectorLabels;
	readonly declaredChannels: readonly PlatformChannel[];
	readonly scope: Parameters<typeof sessionVisibleInScope>[1];
}) {
	const channels = new Map<
		string,
		{ readonly id: string; readonly label: string; readonly icon: string }
	>([
		[
			WEB_CHANNEL_ID,
			{
				id: WEB_CHANNEL_ID,
				label: input.labels.web,
				icon: channelIcon(WEB_CHANNEL_ID, null)
			}
		]
	]);

	for (const channel of input.declaredChannels) {
		const publicOnlyOnOwnAdminInbox =
			channel.audience === 'public' &&
			!(input.scope.isAdmin && input.scope.scopeUserId === input.scope.currentUserId);
		if (channel.name === WEB_CHANNEL_ID || publicOnlyOnOwnAdminInbox) continue;
		channels.set(channel.name, {
			id: channel.name,
			label: channel.name,
			icon: channelIcon(channel.name, channel.transport)
		});
	}

	for (const session of input.sessions) {
		if (!CONVERSATION_VISIBILITIES.has(session.visibility)) continue;
		const id = sessionChannelId(session, input.labels);
		if (channels.has(id)) continue;
		channels.set(id, {
			id,
			label: id === WEB_CHANNEL_ID ? input.labels.web : id,
			icon: channelIcon(id, session.platform ?? null)
		});
	}

	return [...channels.values()].sort((left, right) => {
		if (left.id === WEB_CHANNEL_ID) return -1;
		if (right.id === WEB_CHANNEL_ID) return 1;
		return left.label.localeCompare(right.label);
	});
}

/** Groups scoped sessions into channel tabs and per-tab conversation rows. */
export function buildConversationSelector(input: {
	readonly sessions: readonly ConversationSession[];
	readonly labels: SelectorLabels;
}) {
	const byChannel = new Map<string, ConversationSession[]>();
	for (const session of input.sessions) {
		if (!CONVERSATION_VISIBILITIES.has(session.visibility)) continue;
		const id = sessionChannelId(session, input.labels);
		byChannel.set(id, [...(byChannel.get(id) ?? []), session]);
	}

	const channels = [...byChannel.entries()]
		.map(([id, sessions]) => ({
			id,
			label: id === WEB_CHANNEL_ID ? input.labels.web : id,
			icon: channelIcon(id, sessions[0]?.platform ?? null)
		}))
		.sort((left, right) => {
			if (left.id === WEB_CHANNEL_ID) return -1;
			if (right.id === WEB_CHANNEL_ID) return 1;
			return left.label.localeCompare(right.label);
		});

	const rowsByChannel = Object.fromEntries(
		channels.map((channel) => {
			const sessions = byChannel.get(channel.id) ?? [];
			const audiences = [
				{
					audience: 'user',
					label: input.labels.users,
					sessions: sessions.filter(
						(session) => session.visibility === 'personal' || session.visibility === 'channel_dm'
					)
				},
				{
					audience: 'group',
					label: input.labels.groups,
					sessions: sessions.filter((session) => session.visibility === 'channel_group')
				}
			] as const;
			const showHeadings = audiences.every((audience) => audience.sessions.length > 0);
			const rows = audiences.flatMap((audience) => [
				...(showHeadings && audience.sessions.length > 0
					? [
							{
								kind: 'heading' as const,
								id: `heading:${channel.id}:${audience.audience}s`,
								label: audience.label,
								level: 0 as const
							}
						]
					: []),
				...audience.sessions.map((session) => ({
					kind: 'conversation' as const,
					id: session.norbital_id,
					title: session.title,
					icon: audience.audience === 'group' ? 'lucide:users-round' : 'lucide:message-square',
					searchText: [
						session.title,
						session.channel_key,
						session.external_thread_id,
						session.platform
					]
						.filter((part): part is string => Boolean(part && part.length > 0))
						.join(' '),
					audience: audience.audience
				}))
			]);
			return [channel.id, rows] as const;
		})
	);

	return {
		channels,
		showTabs: channels.length > 1,
		rowsByChannel
	};
}

export type ConversationSelectorModel = ReturnType<typeof buildConversationSelector>;

/** Icon for a channel tab: web chrome, or the transport's mark. */
function channelIcon(channelId: string, platform: string | null): string {
	if (channelId === WEB_CHANNEL_ID) return 'lucide:monitor';
	switch (platform) {
		case 'telegram':
			return 'lucide:send';
		case 'whatsapp':
			return 'lucide:phone';
		case 'discord':
			return 'lucide:hash';
		default:
			return 'lucide:messages-square';
	}
}
