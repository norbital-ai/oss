import { Option, Schema } from 'effect';
import { AgentRow } from '../../protocol/schema.ts';
import { readPreference, writePreference } from '../preferences.ts';

export type AgentDraft = {
	readonly text: string;
	readonly files: readonly File[];
	readonly stored_files: NonNullable<AgentRow['files']>;
	readonly revising: AgentRow | null;
	readonly mode: 'plan' | 'compact' | null;
};

/** What survives a reload: everything but local files not yet uploaded, which a browser cannot store. */
const Stored = Schema.fromJsonString(
	Schema.Struct({
		text: Schema.String,
		stored_files: AgentRow.fields.files.schema,
		revising: Schema.NullOr(AgentRow),
		mode: Schema.NullOr(Schema.Literals(['plan', 'compact']))
	})
);
const decode = Schema.decodeUnknownOption(Stored);
const encode = Schema.encodeUnknownOption(Stored);

export type AgentDrafts = {
	get(conversation: string | null): AgentDraft | undefined;
	set(conversation: string | null, draft: AgentDraft): void;
	delete(conversation: string | null): void;
};

// The workspace client outlives its panel. A different client (including sign-in) owns different drafts. With a
// member's storage key, each conversation's draft is also kept in `localStorage`, so a reload restores it.
const clients = new WeakMap<object, Map<string | undefined, Map<string | null, AgentDraft>>>();
export function agent_drafts(client: object, member_key?: string): AgentDrafts {
	let members = clients.get(client);
	if (members === undefined) {
		members = new Map();
		clients.set(client, members);
	}
	let drafts = members.get(member_key);
	if (drafts === undefined) {
		drafts = new Map();
		members.set(member_key, drafts);
	}
	const held = drafts;
	const key = (conversation: string | null) =>
		member_key === undefined ? undefined : `${member_key}:draft:${conversation ?? 'new'}`;
	return {
		get: (conversation) =>
			held.get(conversation) ??
			Option.getOrUndefined(
				Option.map(decode(readPreference(key(conversation))), (saved) => ({ ...saved, files: [] }))
			),
		set: (conversation, draft) => {
			held.set(conversation, draft);
			const { files: _files, ...stored } = draft;
			writePreference(key(conversation), Option.getOrNull(encode(stored)));
		},
		delete: (conversation) => {
			held.delete(conversation);
			writePreference(key(conversation), null);
		}
	};
}
