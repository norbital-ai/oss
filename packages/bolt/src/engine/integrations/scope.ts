// Platform-native listening scope for conversation connections (ingest capture filter) and envoy channel bindings (routing).
import { Effect, Option, Predicate, Schema } from 'effect';
import type { HandleKind } from '../../decl/runtime/integration.ts';
import type { Json } from '../../decl/values.ts';
import { canonicalHandle } from '../envoys/senders.ts';

export const DmScope = Schema.Struct({
	mode: Schema.Literals(['off', 'all', 'selected']),
	/** Teams (`sys_team` ids) whose active members (and descendant teams) are matched. */
	teams: Schema.optionalKey(Schema.Array(Schema.String)),
	/** Specific workspace members (`sys_user` ids). */
	members: Schema.optionalKey(Schema.Array(Schema.String)),
	/** External handles, addresses, or email domains (`@example.com`). */
	handles: Schema.optionalKey(Schema.Array(Schema.String))
});
export type DmScope = typeof DmScope.Type;

export const GroupEntry = Schema.Struct({
	/** Stable provider thread id (e.g. WhatsApp `...@g.us`, Slack/Discord channel id). */
	id: Schema.NonEmptyString,
	/** Optional cached human-readable group/channel label for display. */
	label: Schema.optionalKey(Schema.String)
});
export type GroupEntry = typeof GroupEntry.Type;

export const GroupScope = Schema.Struct({
	mode: Schema.Literals(['off', 'all', 'selected']),
	threads: Schema.optionalKey(Schema.Array(GroupEntry))
});
export type GroupScope = typeof GroupScope.Type;

export const ListeningScope = Schema.Struct({
	dm: Schema.optionalKey(DmScope),
	groups: Schema.optionalKey(GroupScope)
});
export type ListeningScope = typeof ListeningScope.Type;

export const decodeListeningScope = (
	value: unknown
): Option.Option<ListeningScope | null> =>
	value === null || value === undefined
		? Option.some(null)
		: Schema.decodeUnknownOption(ListeningScope)(value);

export const listeningScopeOf = (value: unknown): ListeningScope | null =>
	Option.getOrElse(decodeListeningScope(value), () => null);

export const decodeListeningScopeStrict = (
	value: unknown
): { value: ListeningScope | null } | { problem: string } => {
	if (value === null || value === undefined) return { value: null };
	const decoded = Schema.decodeUnknownOption(ListeningScope)(value, { onExcessProperty: 'error' });
	if (Option.isNone(decoded))
		return {
			problem:
				'Choose a valid listening scope ({ dm?: { mode, teams?, members?, handles? }, groups?: { mode, threads? } }).'
		};
	return { value: normalizeListeningScope(decoded.value) };
};

const uniq = (values: readonly string[] | undefined): string[] => [
	...new Set((values ?? []).map((v) => v.trim()).filter((v) => v !== ''))
];

const uniqGroups = (entries: readonly GroupEntry[] | undefined): GroupEntry[] => {
	const seen = new Map<string, GroupEntry>();
	for (const entry of entries ?? []) {
		const id = entry.id.trim();
		if (id === '') continue;
		const label = entry.label?.trim();
		seen.set(id, label !== undefined && label !== '' ? { id, label } : { id });
	}
	return [...seen.values()];
};

/** Canonical stored form: trims duplicates and collapses an unrestricted all/all scope to `null`. */
export function normalizeListeningScope(scope: ListeningScope | null): ListeningScope | null {
	if (scope === null) return null;
	const dm: DmScope =
		scope.dm === undefined
			? { mode: 'all' }
			: scope.dm.mode === 'selected'
				? {
						mode: 'selected',
						...(uniq(scope.dm.teams).length > 0 ? { teams: uniq(scope.dm.teams) } : {}),
						...(uniq(scope.dm.members).length > 0 ? { members: uniq(scope.dm.members) } : {}),
						...(uniq(scope.dm.handles).length > 0 ? { handles: uniq(scope.dm.handles) } : {})
					}
				: { mode: scope.dm.mode };
	const groups: GroupScope =
		scope.groups === undefined
			? { mode: 'all' }
			: scope.groups.mode === 'selected'
				? {
						mode: 'selected',
						...(uniqGroups(scope.groups.threads).length > 0
							? { threads: uniqGroups(scope.groups.threads) }
							: {})
					}
				: { mode: scope.groups.mode };
	if (dm.mode === 'all' && groups.mode === 'all') return null;
	return { dm, groups };
}

/** Whether a single sender/peer handle matches a configured pattern (exact canonical handle, or `@domain` for email). */
export function handleMatches(
	kind: HandleKind | null,
	pattern: string,
	candidate: string
): boolean {
	const rawPattern = pattern.trim();
	const rawCandidate = candidate.trim();
	if (rawPattern === '' || rawCandidate === '') return false;
	if (kind === 'email') {
		const lowerCandidate = rawCandidate.toLowerCase();
		const lowerPattern = rawPattern.toLowerCase();
		if (lowerPattern.startsWith('@')) {
			const at = lowerCandidate.lastIndexOf('@');
			return at > 0 && lowerCandidate.slice(at) === lowerPattern;
		}
		return lowerCandidate === lowerPattern;
	}
	if (kind === null) return rawCandidate.toLowerCase() === rawPattern.toLowerCase();
	const a = canonicalHandle(kind, rawPattern);
	const b = canonicalHandle(kind, rawCandidate);
	return a !== '' && a === b;
}

export type ScopeMatchInput = {
	readonly group: boolean;
	readonly thread: string;
	/** Candidate peer handles to test against `dm.handles` (inbound sender, or peer handles on personal outbound DMs). */
	readonly handles: readonly string[];
	readonly handleKind: HandleKind | null;
	/** Matched workspace members (`sys_user` ids) corresponding to `handles`. */
	readonly members: readonly string[];
	/** All team ids (including ancestors in the team graph) held by any matched member. */
	readonly teams: readonly string[];
	/** When routing envoys, a private catch-all on an unrecognised sender scores lower than a public or explicit match. */
	readonly audience?: 'private' | 'public' | undefined;
};

export type ScopeMatch = {
	readonly matched: boolean;
	/** Higher specificity wins when multiple envoy bindings share one channel. */
	readonly specificity: number;
};

/** Evaluates one listening scope against an incoming/captured message. */
export function matchesListeningScope(
	scope: ListeningScope | null | undefined,
	input: ScopeMatchInput
): ScopeMatch {
	if (input.group) {
		const groups = scope?.groups ?? { mode: 'all' };
		if (groups.mode === 'off') return { matched: false, specificity: 0 };
		if (groups.mode === 'all') return { matched: true, specificity: 1 };
		const hit = (groups.threads ?? []).some((entry) => entry.id === input.thread);
		return hit ? { matched: true, specificity: 3 } : { matched: false, specificity: 0 };
	}
	const dm = scope?.dm ?? { mode: 'all' };
	if (dm.mode === 'off') return { matched: false, specificity: 0 };
	if (dm.mode === 'all') {
		const privateUnknown = input.audience === 'private' && input.members.length === 0;
		return { matched: true, specificity: privateUnknown ? 0 : 1 };
	}
	if (
		(dm.handles ?? []).some((pattern) =>
			input.handles.some((candidate) => handleMatches(input.handleKind, pattern, candidate))
		)
	)
		return { matched: true, specificity: 4 };
	if (input.members.some((member) => (dm.members ?? []).includes(member)))
		return { matched: true, specificity: 3 };
	if (input.teams.some((team) => (dm.teams ?? []).includes(team)))
		return { matched: true, specificity: 2 };
	return { matched: false, specificity: 0 };
}

export type EnvoyBindingCandidate = {
	readonly id: string;
	readonly envoy: string;
	readonly audience: 'private' | 'public';
	readonly scope: ListeningScope | null;
	readonly group_messages: 'disabled' | 'mention_or_reply' | 'all' | null;
};

/** Picks the highest-specificity matching envoy binding on a shared channel, or `undefined` when out of scope. */
export function resolveEnvoyBinding(
	bindings: readonly EnvoyBindingCandidate[],
	input: Omit<ScopeMatchInput, 'audience'>
): EnvoyBindingCandidate | undefined {
	let best: { readonly binding: EnvoyBindingCandidate; readonly specificity: number } | undefined;
	for (const binding of bindings) {
		const match = matchesListeningScope(binding.scope, { ...input, audience: binding.audience });
		if (!match.matched) continue;
		if (
			best === undefined ||
			match.specificity > best.specificity ||
			(match.specificity === best.specificity && binding.id < best.binding.id)
		)
			best = { binding, specificity: match.specificity };
	}
	return best?.binding;
}

/** Extracts peer addresses from a normalized outbound email payload (`to`, `cc`, `bcc`) for personal capture filtering. */
export function emailRecipientsOf(email: Json | null | undefined): string[] {
	if (!Predicate.isObject(email)) return [];
	const out: string[] = [];
	for (const key of ['to', 'cc', 'bcc'] as const) {
		const list = email[key];
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			if (Predicate.isObject(item) && typeof item['address'] === 'string')
				out.push(item['address'].toLowerCase());
			else if (typeof item === 'string') out.push(item.toLowerCase());
		}
	}
	return out;
}

/** Concise human-readable scope summary tokens (English keys for `t(...)`). */
export function scopeSummaryParts(
	scope: ListeningScope | null | undefined,
	isEmail: boolean
): readonly string[] {
	if (scope === null || scope === undefined) return [];
	const parts: string[] = [];
	const dm = scope.dm ?? { mode: 'all' };
	if (dm.mode === 'off') parts.push(isEmail ? 'No senders' : 'DMs off');
	else if (dm.mode === 'selected') {
		const count = (dm.teams?.length ?? 0) + (dm.members?.length ?? 0) + (dm.handles?.length ?? 0);
		parts.push(
			isEmail
				? count === 0
					? 'No senders selected'
					: `${count} sender rule${count === 1 ? '' : 's'}`
				: count === 0
					? 'No DMs selected'
					: `${count} DM rule${count === 1 ? '' : 's'}`
		);
	}
	if (!isEmail) {
		const groups = scope.groups ?? { mode: 'all' };
		if (groups.mode === 'off') parts.push('Groups off');
		else if (groups.mode === 'selected') {
			const count = groups.threads?.length ?? 0;
			parts.push(count === 0 ? 'No groups selected' : `${count} group${count === 1 ? '' : 's'}`);
		}
	}
	return parts;
}

export const scopeNeedsDirectory = (scope: ListeningScope | null | undefined): boolean =>
	scope?.dm?.mode === 'selected' &&
	((scope.dm.teams?.length ?? 0) > 0 || (scope.dm.members?.length ?? 0) > 0);
