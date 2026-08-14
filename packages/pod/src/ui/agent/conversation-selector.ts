export const WEB_CHANNEL_ID = 'web';

export type ConversationSession = {
	readonly id: string;
	readonly title: string;
	readonly userId: string;
	readonly visibility: string;
	readonly platform: string | null;
	readonly channelKey: string | null;
	readonly externalThreadId: string | null;
};

export type ConversationSelectorLabels = {
	readonly web: string;
	readonly users: string;
	readonly groups: string;
	readonly channelFallback: string;
};

export type ConversationHeadingRow = {
	readonly kind: 'heading';
	readonly id: string;
	readonly label: string;
	readonly level: 0 | 1;
};

export type ConversationItemRow = {
	readonly kind: 'conversation';
	readonly id: string;
	readonly title: string;
	readonly icon: string;
	readonly searchText: string;
	readonly audience: 'user' | 'group';
};

export type ConversationSelectorRow = ConversationHeadingRow | ConversationItemRow;

export type ConversationChannel = {
	readonly id: string;
	readonly label: string;
	readonly icon: string;
};

export type ConversationSelectorModel = {
	readonly channels: readonly ConversationChannel[];
	readonly showTabs: boolean;
	readonly rowsByChannel: Readonly<Record<string, readonly ConversationSelectorRow[]>>;
};

export type ConversationScopeInput = {
	readonly scopeUserId: string | null;
	readonly currentUserId: string | null;
	readonly isAdmin: boolean;
	readonly publicChannelKeys: ReadonlySet<string>;
};

export type ManifestChannelRef = {
	readonly audience: string;
	readonly transport: string;
};

/** Channel tab id for a session: personal stays on web, otherwise the transport key. */
export function sessionChannelId(
	session: ConversationSession,
	labels: ConversationSelectorLabels
): string {
	if (session.visibility === 'personal') return WEB_CHANNEL_ID;
	return session.channelKey ?? labels.channelFallback;
}

/** Whether this session belongs in the current admin/member conversation scope. */
export function sessionVisibleInScope(
	session: ConversationSession,
	scope: ConversationScopeInput
): boolean {
	if (!isKnownVisibility(session.visibility)) return false;
	const isPublicChannel =
		session.channelKey != null && scope.publicChannelKeys.has(session.channelKey);
	if (isPublicChannel) {
		return scope.isAdmin && scope.scopeUserId === scope.currentUserId;
	}
	if (session.visibility === 'channel_group') {
		return !scope.isAdmin;
	}
	if (session.visibility === 'personal' && scope.scopeUserId == null) return true;
	return scope.scopeUserId != null && session.userId === scope.scopeUserId;
}

/** Filters replicated sessions down to the rows the current scope may list. */
export function scopeConversationSessions(
	sessions: readonly ConversationSession[],
	scope: ConversationScopeInput
): ConversationSession[] {
	return sessions.filter((session) => sessionVisibleInScope(session, scope));
}

/** Channels the current scope may inspect: Web, allowed manifest entries, plus any scoped thread. */
export function listAccessibleChannels(input: {
	readonly sessions: readonly ConversationSession[];
	readonly labels: ConversationSelectorLabels;
	readonly manifestChannels: Readonly<Record<string, ManifestChannelRef>>;
	readonly scope: ConversationScopeInput;
}): ConversationChannel[] {
	const channels = new Map<string, ConversationChannel>();
	channels.set(WEB_CHANNEL_ID, {
		id: WEB_CHANNEL_ID,
		label: input.labels.web,
		icon: channelIcon(WEB_CHANNEL_ID, null)
	});

	for (const [id, channel] of Object.entries(input.manifestChannels)) {
		const publicOnlyOnOwnAdminInbox =
			channel.audience === 'public' &&
			!(input.scope.isAdmin && input.scope.scopeUserId === input.scope.currentUserId);
		if (id === WEB_CHANNEL_ID || publicOnlyOnOwnAdminInbox) continue;
		channels.set(id, {
			id,
			label: id,
			icon: channelIcon(id, channel.transport)
		});
	}

	for (const session of input.sessions) {
		if (!isKnownVisibility(session.visibility)) continue;
		const id = sessionChannelId(session, input.labels);
		if (channels.has(id)) continue;
		channels.set(id, {
			id,
			label: id === WEB_CHANNEL_ID ? input.labels.web : id,
			icon: channelIcon(id, session.platform)
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
	readonly labels: ConversationSelectorLabels;
}): ConversationSelectorModel {
	const byChannel = new Map<string, ConversationSession[]>();
	const channelMeta = new Map<string, ConversationChannel>();

	for (const session of input.sessions) {
		if (!isKnownVisibility(session.visibility)) continue;
		const id = sessionChannelId(session, input.labels);
		const rows = byChannel.get(id) ?? [];
		rows.push(session);
		byChannel.set(id, rows);
		if (!channelMeta.has(id)) {
			channelMeta.set(id, {
				id,
				label: id === WEB_CHANNEL_ID ? input.labels.web : id,
				icon: channelIcon(id, session.platform)
			});
		}
	}

	const channels = [...byChannel.keys()]
		.sort((left, right) => {
			if (left === WEB_CHANNEL_ID) return -1;
			if (right === WEB_CHANNEL_ID) return 1;
			return (channelMeta.get(left)?.label ?? left).localeCompare(
				channelMeta.get(right)?.label ?? right
			);
		})
		.map((id) => channelMeta.get(id))
		.filter((channel): channel is ConversationChannel => channel !== undefined);

	const rowsByChannel: Record<string, readonly ConversationSelectorRow[]> = {};
	for (const channel of channels) {
		rowsByChannel[channel.id] = buildChannelRows({
			sessions: byChannel.get(channel.id) ?? [],
			channelId: channel.id,
			labels: input.labels
		});
	}

	return {
		channels,
		showTabs: channels.length > 1,
		rowsByChannel
	};
}

export type ConversationComboboxOption = {
	readonly value: string;
	readonly label: string;
	readonly icon: string;
	readonly search_term: string;
	readonly type?: string;
};

/** Flattens selector rows into Combobox options, grouping users/groups only when both exist. */
export function conversationComboboxOptions(
	model: ConversationSelectorModel
): ConversationComboboxOption[] {
	const rows = model.channels.flatMap((channel) => model.rowsByChannel[channel.id] ?? []);
	const groupLabel = new Map<string, string>();
	for (const row of rows) {
		if (row.kind !== 'heading') continue;
		if (row.id.endsWith(':users')) groupLabel.set('user', row.label);
		else if (row.id.endsWith(':groups')) groupLabel.set('group', row.label);
	}
	const options: ConversationComboboxOption[] = [];
	for (const row of rows) {
		if (row.kind !== 'conversation') continue;
		const type = groupLabel.get(row.audience);
		options.push({
			value: row.id,
			label: row.title,
			icon: row.icon,
			search_term: row.searchText,
			...(type ? { type } : {})
		});
	}
	return options;
}

/** Splits one channel's sessions into optional user/group headings and conversation rows. */
function buildChannelRows(input: { // stupidity:allow Q3 -- named helper
	readonly sessions: readonly ConversationSession[];
	readonly channelId: string;
	readonly labels: ConversationSelectorLabels;
}): ConversationSelectorRow[] {
	const users = input.sessions.filter(
		(session) => session.visibility === 'personal' || session.visibility === 'channel_dm'
	);
	const groups = input.sessions.filter((session) => session.visibility === 'channel_group');
	const showKindHeadings = users.length > 0 && groups.length > 0;
	const rows: ConversationSelectorRow[] = [];

	if (users.length > 0) {
		if (showKindHeadings) {
			rows.push({
				kind: 'heading',
				id: `heading:${input.channelId}:users`,
				label: input.labels.users,
				level: 0
			});
		}
		for (const session of users) {
			rows.push(toItem(session, 'user'));
		}
	}

	if (groups.length > 0) {
		if (showKindHeadings) {
			rows.push({
				kind: 'heading',
				id: `heading:${input.channelId}:groups`,
				label: input.labels.groups,
				level: 0
			});
		}
		for (const session of groups) {
			rows.push(toItem(session, 'group'));
		}
	}

	return rows;
}

/** Projects a session into the combobox row the selector renders. */
function toItem(session: ConversationSession, audience: 'user' | 'group'): ConversationItemRow {
	return {
		kind: 'conversation',
		id: session.id,
		title: session.title,
		icon: audience === 'group' ? 'lucide:users-round' : 'lucide:message-square',
		searchText: [session.title, session.channelKey, session.externalThreadId, session.platform]
			.filter((part): part is string => Boolean(part && part.length > 0))
			.join(' '),
		audience
	};
}

/** Icon for a channel tab: web chrome, or the transport's mark. */
function channelIcon(channelId: string, platform: string | null): string { // stupidity:allow Q3 -- named helper
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

/** True when visibility is one of the three conversation audiences this selector understands. */
function isKnownVisibility(visibility: string): boolean {
	return visibility === 'personal' || visibility === 'channel_dm' || visibility === 'channel_group';
}
