// The assistant's runtime settings (§5.9): an administrator's monthly spending limits (the workspace's, each member's by
// default, and each member's by a policy they hold) and the models members may pick,
// kept in `sys_config` under `agent` so they change without a source release. A turn refuses once a limit is reached;
// the model list narrows the picker (one model hides it) and the model a turn runs.
import { Effect, Option, Schema } from 'effect';
import type { TenantDbShape } from '../db/tenant-db.ts';

export const AGENT_KEY = 'agent';
const Usd = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
/**
 * Monthly caps in USD: `monthly` the workspace's spend this calendar month, `member` each member's by default, `policies`
 * each member's by a policy they hold (the most generous of theirs wins over the default); `models` the allowed ids
 * (empty: all).
 */
export const AgentSettings = Schema.Struct({
	monthly: Schema.NullOr(Usd),
	member: Schema.NullOr(Usd),
	policies: Schema.Record(Schema.String, Usd).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed({}))
	),
	models: Schema.Array(Schema.String)
});
export type AgentSettings = typeof AgentSettings.Type;
const NONE: AgentSettings = { monthly: null, member: null, policies: {}, models: [] };

export const agentSettings = (db: TenantDbShape) =>
	db
		.one(Schema.Struct({ value: Schema.fromJsonString(AgentSettings) }), {
			text: `SELECT value FROM sys_config WHERE key = '${AGENT_KEY}'`,
			params: []
		})
		.pipe(Effect.map((row) => Option.match(row, { onNone: () => NONE, onSome: (r) => r.value })));

export const saveAgentSettings = (db: TenantDbShape, s: AgentSettings) =>
	db.write({
		text: `INSERT INTO sys_config (key, value) VALUES ('${AGENT_KEY}', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
		params: [JSON.stringify(s)]
	});

/** What replies cost this calendar month (UTC): the workspace's, and `member`'s own conversations' (sub-agents included). */
export const spent = (db: TenantDbShape, member: string | null) =>
	db.value(Schema.Number, {
		text: `SELECT coalesce(sum((m.meta->'usage'->>'cost')::float8), 0)::float8 FROM sys_message m JOIN sys_conversation c ON c.id = m.conversation
			WHERE m.meta->>'tag' IN ('reply', 'failed') AND m.created_at >= date_trunc('month', now()) AND ($1::text IS NULL OR c.owner = $1)`,
		params: [member]
	});

/** A member's monthly cap: the most generous of their policies' caps, else the default. */
export const memberCap = (s: AgentSettings, policies: readonly string[]) => {
	const caps = policies.flatMap((p) => (s.policies[p] === undefined ? [] : [s.policies[p]]));
	return caps.length > 0 ? Math.max(...caps) : s.member;
};

/** The limit a new step would cross, or null: the workspace's first, then the member's (by their policies). */
export const overLimit = Effect.fn('Agents.overLimit')(function* (
	db: TenantDbShape,
	s: AgentSettings,
	member: string | null,
	policies: readonly string[]
) {
	if (s.monthly !== null && (yield* spent(db, null)) >= s.monthly) return 'workspace' as const;
	const cap = memberCap(s, policies);
	if (cap !== null && member !== null && (yield* spent(db, member)) >= cap)
		return 'member' as const;
	return null;
});

/** A model a turn may run: its own when allowed (or every model is), else the first allowed. */
export const allowedModel = (s: AgentSettings, model: string) =>
	s.models.length === 0 || s.models.includes(model) ? model : s.models[0]!;
