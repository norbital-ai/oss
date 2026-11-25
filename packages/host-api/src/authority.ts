// Who a release says is asking, as much as a host reads: the actor, whether they administer the workspace, the agent
// mark and the read outputs they hold per model. A release's compiled authority carries more; it stays the release's.
import { Schema } from 'effect';

/** What a system run is: an automation's, the platform's own work (`agent`: a system agent's task), or a sync's. */
export const RunBy = Schema.Union([
	Schema.Struct({ automation: Schema.String }),
	Schema.Struct({ platform: Schema.String }),
	Schema.Struct({ sync: Schema.String, instance: Schema.String })
]);
export type RunBy = typeof RunBy.Type;

/** The person or work a call is for: a member, an envoy's turn, a visitor, an API key or the system identity's run. */
export const Actor = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal('member'),
		id: Schema.String,
		email: Schema.NullOr(Schema.String),
		phone: Schema.NullOr(Schema.String),
		external: Schema.Boolean,
		admin: Schema.Boolean
	}),
	Schema.Struct({ kind: Schema.Literal('envoy'), envoy: Schema.String }),
	Schema.Struct({ kind: Schema.Literal('visitor'), app: Schema.String, visitor: Schema.String }),
	Schema.Struct({ kind: Schema.Literal('api_key'), key: Schema.String }),
	Schema.Struct({ kind: Schema.Literal('system'), run: Schema.String, by: RunBy })
]);
export type Actor = typeof Actor.Type;

/** The agent's mark: requests made with a session minted for the agent's browser act for the member in `conversation`. */
export const AgentMark = Schema.Struct({ conversation: Schema.String });
export type AgentMark = typeof AgentMark.Type;

/** A caller's authority as a host reads it. */
export const Authority = Schema.Struct({
	actor: Actor,
	/** Administers the workspace: Studio, the integrations admin and every host tool. */
	admin: Schema.Boolean,
	/** Attribution for an admin viewing or acting as another identity; it grants no host authority. */
	preview: Schema.optionalKey(Schema.Struct({
		by: Schema.String,
		team: Schema.NullOr(Schema.String),
		impersonate: Schema.optionalKey(Schema.Literal(true))
	})),
	/** Set when the caller is the agent acting for its member; a host holds live-changing work from it. */
	agent: Schema.optionalKey(AgentMark),
	/** Set on a render grant's requests (a record printed by the host's browser): the run's reads, no visit of its own. */
	render: Schema.optionalKey(Schema.Literal(true)),
	/** Per model, the read outputs the caller holds (`default`, a named one); each output's grant is the release's. */
	models: Schema.Record(Schema.String, Schema.Struct({ read: Schema.Record(Schema.String, Schema.Unknown) }))
});
export type Authority = typeof Authority.Type;
