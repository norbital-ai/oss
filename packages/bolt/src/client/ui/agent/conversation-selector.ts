import type { CollectionRegistryFor, PlatformSchema } from '#lib/authoring/internals.js';
import type { PlatformEnvoy } from '#lib/client/ui/state/platform.js';

/**
 * The web agent's own tab, and a name `envoy()` refuses so nothing can shadow it.
 *
 * It is not an envoy and has no declaration: the web agent is defined entirely by who is using it.
 * This constant is the selector's entry for its threads, and the reason an envoy called `web` is a
 * build error rather than a tab that silently never appears.
 */
export const WEB_AGENT_ID = 'web';

const SELECTOR_LABEL_KEYS = ['web', 'users', 'groups', 'envoyFallback'] as const;
/**
 * The three kinds of thread, and the column that finally carries them.
 *
 * `chat_session` had neither `visibility` nor `envoy_key` — so every session read as
 * `undefined`, the group bucket was permanently empty, and a public envoy's threads never reached
 * the admin inbox this file routes them to. Both columns exist now and `Agents.openConversation`
 * writes them, which is what makes every branch below reachable.
 */
const CONVERSATION_VISIBILITIES = new Set<string>(['personal', 'envoy_dm', 'envoy_group']);

type SelectorLabels = Record<(typeof SELECTOR_LABEL_KEYS)[number], string>;

/**
 * The `chat_session` fields the web agent's selector reads.
 *
 * Composed from the platform row rather than redeclared: the wire already types this row, and a
 * second shape beside it would drift (it once promised `platform` and `external_thread_id`, which
 * the model never carried — so every tab there fell back to the default glyph, and every search
 * appended two always-empty parts).
 */
type ConversationSession = Pick<
	CollectionRegistryFor<PlatformSchema>['chat_session']['row'],
	'conversation_id' | 'user_id' | 'title' | 'visibility' | 'envoy_key'
>;

/** Tab id for a session: personal stays on web, otherwise the envoy it arrived on. */
export function sessionEnvoyId(
	session: ConversationSession,
	labels: Pick<SelectorLabels, 'envoyFallback'>
): string {
	if (session.visibility === 'personal') return WEB_AGENT_ID;
	return session.envoy_key ?? labels.envoyFallback;
}

/** Whether this session belongs in the current admin/member conversation scope. */
export function sessionVisibleInScope(
	session: ConversationSession,
	scope: {
		readonly scopeUserId: string | null;
		readonly currentUserId: string | null;
		readonly isAdmin: boolean;
		readonly publicEnvoyKeys: ReadonlySet<string>;
	}
): boolean {
	if (!CONVERSATION_VISIBILITIES.has(session.visibility)) return false;
	const isPublicEnvoy = session.envoy_key != null && scope.publicEnvoyKeys.has(session.envoy_key);
	if (isPublicEnvoy) {
		return scope.isAdmin && scope.scopeUserId === scope.currentUserId;
	}
	if (session.visibility === 'envoy_group') {
		return !scope.isAdmin;
	}
	if (session.visibility === 'personal' && scope.scopeUserId == null) return true;
	return scope.scopeUserId != null && session.user_id === scope.scopeUserId;
}

/**
 * The declared envoys an outsider can reach without an account.
 *
 * Split out of the panel so the rule sits with the other envoy rules and can be exercised on its
 * own: an envoy's `audience` is the only thing that decides whether its threads belong in the admin
 * inbox, and the panel used to derive that set inline from a manifest projection that was always
 * empty.
 */
export function publicEnvoyNames(envoys: readonly PlatformEnvoy[]): ReadonlySet<string> {
	return new Set(envoys.filter((envoy) => envoy.audience === 'public').map(({ name }) => name));
}

/** Tabs the current scope may inspect: Web, allowed manifest entries, plus any scoped thread. */
export function listAccessibleEnvoys(input: {
	readonly sessions: readonly ConversationSession[];
	readonly labels: SelectorLabels;
	readonly declaredEnvoys: readonly PlatformEnvoy[];
	readonly scope: Parameters<typeof sessionVisibleInScope>[1];
}) {
	const tabs = new Map<
		string,
		{ readonly id: string; readonly label: string; readonly icon: string }
	>([
		[
			WEB_AGENT_ID,
			{ id: WEB_AGENT_ID, label: input.labels.web, icon: envoyIcon(WEB_AGENT_ID, null) }
		]
	]);

	for (const envoy of input.declaredEnvoys) {
		const publicOnlyOnOwnAdminInbox =
			envoy.audience === 'public' &&
			!(input.scope.isAdmin && input.scope.scopeUserId === input.scope.currentUserId);
		if (envoy.name === WEB_AGENT_ID || publicOnlyOnOwnAdminInbox) continue;
		tabs.set(envoy.name, {
			id: envoy.name,
			label: envoy.name,
			icon: envoyIcon(envoy.name, envoy.transport)
		});
	}

	for (const session of input.sessions) {
		if (!CONVERSATION_VISIBILITIES.has(session.visibility)) continue;
		const id = sessionEnvoyId(session, input.labels);
		if (tabs.has(id)) continue;
		tabs.set(id, {
			id,
			label: id === WEB_AGENT_ID ? input.labels.web : id,
			icon: envoyIcon(id, null)
		});
	}

	return [...tabs.values()].sort((left, right) => {
		if (left.id === WEB_AGENT_ID) return -1;
		if (right.id === WEB_AGENT_ID) return 1;
		return left.label.localeCompare(right.label);
	});
}

/** Groups scoped sessions into envoy tabs and per-tab conversation rows. */
export function buildConversationSelector(input: {
	readonly sessions: readonly ConversationSession[];
	readonly labels: SelectorLabels;
}) {
	const byEnvoy = new Map<string, ConversationSession[]>();
	for (const session of input.sessions) {
		if (!CONVERSATION_VISIBILITIES.has(session.visibility)) continue;
		const id = sessionEnvoyId(session, input.labels);
		byEnvoy.set(id, [...(byEnvoy.get(id) ?? []), session]);
	}

	const tabs = [...byEnvoy.entries()]
		.map(([id]) => ({
			id,
			label: id === WEB_AGENT_ID ? input.labels.web : id,
			icon: envoyIcon(id, null)
		}))
		.sort((left, right) => {
			if (left.id === WEB_AGENT_ID) return -1;
			if (right.id === WEB_AGENT_ID) return 1;
			return left.label.localeCompare(right.label);
		});

	const rowsByEnvoy = Object.fromEntries(
		tabs.map((tab) => {
			const sessions = byEnvoy.get(tab.id) ?? [];
			const audiences = [
				{
					audience: 'user',
					label: input.labels.users,
					sessions: sessions.filter(
						(session) => session.visibility === 'personal' || session.visibility === 'envoy_dm'
					)
				},
				{
					audience: 'group',
					label: input.labels.groups,
					sessions: sessions.filter((session) => session.visibility === 'envoy_group')
				}
			] as const;
			const showHeadings = audiences.every((audience) => audience.sessions.length > 0);
			const rows = audiences.flatMap((audience) => [
				...(showHeadings && audience.sessions.length > 0
					? [
							{
								kind: 'heading' as const,
								id: `heading:${tab.id}:${audience.audience}s`,
								label: audience.label,
								level: 0 as const
							}
						]
					: []),
				...audience.sessions.map((session) => ({
					kind: 'conversation' as const,
					id: session.conversation_id,
					title: session.title,
					icon: audience.audience === 'group' ? 'lucide:users-round' : 'lucide:message-square',
					searchText: [session.title, session.envoy_key]
						.filter((part): part is string => Boolean(part && part.length > 0))
						.join(' '),
					audience: audience.audience
				}))
			]);
			return [tab.id, rows] as const;
		})
	);

	return {
		envoys: tabs,
		showTabs: tabs.length > 1,
		rowsByEnvoy
	};
}

export type ConversationSelectorModel = ReturnType<typeof buildConversationSelector>;

/** Icon for a tab: web chrome, or the transport's mark. */
function envoyIcon(tabId: string, platform: string | null): string {
	if (tabId === WEB_AGENT_ID) return 'lucide:monitor';
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
