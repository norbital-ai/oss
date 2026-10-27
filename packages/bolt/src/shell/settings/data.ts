// Administrator settings reads and decoded identity/secret operations.
import { Effect, Schema } from 'effect';
import type { EngineError } from '../../engine/errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import type { SecretsShape } from '../../engine/secrets.ts';
import type { EngineManifest } from '../../engine/manifest.ts';
import type { Authority } from '../../engine/contracts.ts';
import type { Json } from '../../decl/values.ts';
import { DRIVERS, type DriverName } from '../../decl/runtime/integration.ts';
import type { InputFields } from '../../decl/fields.ts';
import { SYSTEM } from '../../system/index.ts';
import { conversational } from '../../engine/integrations/instances.ts';
import * as members from '../../engine/identity/members.ts';
import { requireAdmin, SIGNUP_KEY, type IdentityHost } from '../../engine/identity/session.ts';
import { AgentSettings, saveAgentSettings } from '../../engine/agent/settings.ts';

const q = (text: string, ...params: Json[]) => ({ text, params });

const nullableText = Schema.NullOr(Schema.String);
export const Member = Schema.Struct({
	id: Schema.String,
	email: nullableText,
	phone: nullableText,
	telegram: nullableText,
	name: nullableText,
	kind: Schema.Literals(['staff', 'external']),
	active: Schema.Boolean,
	admin: Schema.Boolean,
	team: nullableText,
	last_seen: nullableText
});
export type Member = typeof Member.Type;
const InvitationRow = Schema.Struct({
	id: Schema.String,
	email: nullableText,
	phone: nullableText,
	team: nullableText,
	external: Schema.Boolean,
	status: Schema.Literals(['accepted', 'revoked', 'expired', 'open']),
	expires_at: Schema.String
});
type InvitationRow = typeof InvitationRow.Type;
export const KeyRow = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	prefix: Schema.String,
	team: nullableText,
	created_by: nullableText,
	created_at: Schema.String,
	revoked_at: nullableText,
	last_used_at: nullableText
});
export type KeyRow = typeof KeyRow.Type;
const AuditRow = Schema.Struct({
	model: Schema.String,
	record: Schema.String,
	revision: Schema.Number,
	at: Schema.String,
	actor: nullableText,
	op: Schema.String,
	changes: Schema.Json
});
type AuditRow = typeof AuditRow.Type;
const DeliveryRow = Schema.Struct({
	integration: Schema.String,
	sent: Schema.Number,
	pending: Schema.Number,
	retrying: Schema.Number,
	failed: Schema.Number,
	skipped: Schema.Number,
	next_retry: nullableText,
	last_error: nullableText
});
const InstanceRow = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	integration: Schema.String,
	owner: nullableText,
	named: Schema.Boolean,
	envoy: nullableText,
	active: Schema.Boolean,
	status: Schema.Json,
	configuration: Schema.Json
});
const EnvoyRow = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	audience: Schema.String,
	task: Schema.String,
	policies: Schema.Array(Schema.String),
	group_messages: Schema.String,
	delegation: Schema.String,
	triage: Schema.Boolean,
	dm: Schema.String,
	active: Schema.Boolean
});
const decode = <A>(schema: Schema.Decoder<A>, rows: unknown) =>
	Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(
		Effect.mapError((e) => BoltError.make('internal', 'decode', String(e)))
	);
export type Settings = {
	members: readonly Member[];
	teams: { id: string; name: string }[];
	invitations: readonly InvitationRow[];
	keys: readonly KeyRow[];
	policies: string[];
	secrets: { name: string; label: string; set: boolean | null }[];
	/** The envoys: source-declared roles and tenant-created rows, each deployable on conversation instances. */
	envoys: {
		id: string;
		name: string;
		audience: 'public' | 'private';
		task: string;
		policies: readonly string[];
		groupMessages: 'disabled' | 'mention_or_reply' | 'all';
		delegation: 'enabled' | 'disabled';
		triage: boolean;
		dm: 'union' | 'envoy';
		active: boolean;
		created: boolean;
	}[];
	/**
	 * Every integration instance (`sys_integration`): `named` is a connection of `+workspace.ts`, `status` the host's last
	 * durable transition, `delivery` its last day of outbound deliveries.
	 */
	instances: {
		id: string;
		name: string;
		integration: string;
		owner: string | null;
		named: boolean;
		envoy: string | null;
		active: boolean;
		status: Json;
		configuration: Json;
		delivery: Delivery;
	}[];
	mcp: { name: string; url: Json }[];
	/** Identity changes (`bolt_history` of the identity tables), newest first (L-BOLT-518). */
	audit: readonly AuditRow[];
	/**
	 * The definitions an instance is created of, the workspace's and bolt's conversation ones: whether it carries a
	 * conversation (an envoy may answer it), may be a member's own account (`personal`), sends outbound, and the
	 * configuration fields each instance edits.
	 */
	integrations: {
		name: string;
		driver: DriverName;
		description: string;
		conversation: boolean;
		personal: boolean;
		sends: boolean;
		syncs: boolean;
		configuration: InputFields;
	}[];
	/** The workspace's self sign-up: the means it declares and whether an administrator left it open; `null` when it declares none. */
	signup: { via: readonly ('email' | 'phone')[]; open: boolean } | null;
};

/**
 * An instance's outbound deliveries over the last day (L-BOLT-521): automatic retries are progress (`retrying`, with the
 * next attempt), only a settled failure is terminal; `lastError` is the newest failure's text. A `skipped` message (its rule's
 * `build` answered `null`: nothing to send for that record) is its own neutral count, never a failure.
 */
export type Delivery = {
	sent: number;
	pending: number;
	retrying: number;
	failed: number;
	skipped: number;
	nextRetry: string | null;
	lastError: string | null;
};
const AUDIT_LIMIT = 200;

/** The settings pages' rows (§5.11.1): one row per member with sessions collapsed to a last-seen time; admins only. */
export const settings = Effect.fn('shell.settings')(function* (
	h: IdentityHost,
	m: EngineManifest,
	auth: Authority,
	secrets?: SecretsShape
) {
	const now = yield* h.now;
	const refusal = requireAdmin(auth);
	if (refusal !== null) return yield* Effect.fail(refusal);
	const [users, invitations, keys, audit, deliveries, signup, instances, envoys] = yield* h.db.read([
		// administrators first, then staff, then external members; by name, else address (L-BOLT-516)
		q(`SELECT u.id, u.email, u.phone, u.telegram, u.name, u.kind, u.active, u.admin, u.team, (SELECT max(s.refreshed_at)::text FROM sys_session s WHERE s."user" = u.id) AS last_seen
			FROM sys_user u ORDER BY u.admin DESC, u.kind = 'external', lower(coalesce(nullif(u.name, ''), u.email, u.phone, '')), u.id`),
		q(
			`SELECT id, email, phone, team, external, CASE WHEN accepted_at IS NOT NULL THEN 'accepted' WHEN revoked_at IS NOT NULL THEN 'revoked'
			WHEN expires_at <= $1::timestamptz THEN 'expired' ELSE 'open' END AS status, expires_at::text AS expires_at FROM sys_invitation ORDER BY expires_at DESC`,
			now.toISOString()
		),
		q(
			'SELECT id, name, prefix, team, created_by, created_at::text AS created_at, revoked_at::text AS revoked_at, last_used_at::text AS last_used_at FROM sys_api_key ORDER BY name, id'
		),
		q(`SELECT collection AS model, record::text AS record, revision, at::text AS at, actor, op, changes FROM bolt_history
			WHERE collection IN ('sys_user', 'sys_invitation') ORDER BY at DESC, revision DESC LIMIT ${AUDIT_LIMIT}`),
		q(
			`SELECT integration, count(*) FILTER (WHERE status IN ('sent', 'deferred', 'delivered', 'read', 'opened', 'replied'))::int AS sent, count(*) FILTER (WHERE status IN ('queued', 'sending') AND attempts = 0)::int AS pending,
			count(*) FILTER (WHERE status IN ('queued', 'sending') AND attempts > 0)::int AS retrying, count(*) FILTER (WHERE status IN ('failed', 'uncertain', 'bounced', 'complained'))::int AS failed, count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
			min(next_attempt_at) FILTER (WHERE status = 'queued' AND attempts > 0)::text AS next_retry,
			(array_agg(error ORDER BY created_at DESC) FILTER (WHERE status IN ('failed', 'uncertain', 'bounced', 'complained') AND error IS NOT NULL))[1] AS last_error
			FROM sys_message WHERE direction = 'outbound' AND created_at > $1::timestamptz - interval '1 day' GROUP BY integration`,
			now.toISOString()
		),
		q(`SELECT value FROM sys_config WHERE key = '${SIGNUP_KEY}'`),
		q(
			'SELECT id, name, integration, owner, named, envoy, active, status, configuration FROM sys_integration ORDER BY name, id'
		),
		q(
			'SELECT id, name, audience, task, policies, group_messages, delegation, triage, dm, active FROM sys_envoy ORDER BY name, id'
		)
	]);
	const idle: Delivery = {
		sent: 0,
		pending: 0,
		retrying: 0,
		failed: 0,
		skipped: 0,
		nextRetry: null,
		lastError: null
	};
	const delivery = new Map(
		(yield* decode(DeliveryRow, deliveries?.rows ?? [])).map((r): [string, Delivery] => [
			r.integration,
			{
				sent: r.sent,
				pending: r.pending,
				retrying: r.retrying,
				failed: r.failed,
				skipped: r.skipped,
				nextRetry: r.next_retry,
				lastError: r.last_error
			}
		])
	);
	const status = secrets === undefined ? null : yield* secrets.status('workspace');
	const runtimeEnvoys = yield* decode(EnvoyRow, envoys?.rows ?? []);
	return {
		members: yield* decode(Member, users?.rows ?? []),
		teams: Object.entries(m.teams)
			.map(([id, team]) => ({
				id,
				name: 'name' in team && typeof team.name === 'string' ? team.name : id
			}))
			.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
		invitations: yield* decode(InvitationRow, invitations?.rows ?? []),
		keys: yield* decode(KeyRow, keys?.rows ?? []),
		policies: Object.keys(m.policies),
		secrets: Object.entries(m.workspace.secrets ?? {}).map(([name, d]) => ({
			name,
			label: d.label,
			set: status === null ? null : status[name] === true
		})),
		envoys: [
			...Object.entries(m.envoys).map(([id, e]) => ({
				id,
				name: e.name,
				audience: e.audience ?? 'private',
				task: e.task,
				policies: e.policies,
				groupMessages: e.groupMessages ?? 'mention_or_reply',
				delegation: e.delegation ?? 'disabled',
				triage: e.triage !== false && e.triage !== undefined,
				dm: e.dm ?? 'union',
				active: true,
				created: false
			})),
			...runtimeEnvoys.map((e) => ({
				id: e.id,
				name: e.name,
				audience: e.audience === 'public' ? ('public' as const) : ('private' as const),
				task: e.task,
				policies: e.policies,
				groupMessages:
					e.group_messages === 'disabled' || e.group_messages === 'all'
						? e.group_messages
						: ('mention_or_reply' as const),
				delegation: e.delegation === 'enabled' ? ('enabled' as const) : ('disabled' as const),
				triage: e.triage,
				dm: e.dm === 'envoy' ? ('envoy' as const) : ('union' as const),
				active: e.active,
				created: true
			}))
		],
		instances: (yield* decode(InstanceRow, instances?.rows ?? [])).map((i) => ({
			...i,
			configuration: i.configuration ?? {},
			delivery: delivery.get(i.id) ?? idle
		})),
		audit: yield* decode(AuditRow, audit?.rows ?? []),
		mcp: Object.entries(m.mcp).map(([name, s]) => ({ name, url: s.url ?? null })),
		// a workspace definition never takes a built-in's name (discover/reserved-name), so the spread loses none
		integrations: Object.entries({ ...SYSTEM.integrations, ...m.integrations })
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, d]) => ({
				name,
				driver: d.driver,
				description: d.description,
				conversation: conversational(d),
				personal: 'personal' in DRIVERS[d.driver],
				sends:
					conversational(d) ||
					Object.values(m.exposures).some((model) =>
						Object.values(model.syncs ?? {}).some(
							(sync) => sync.with === name && sync.write === true
						)
					),
				syncs: Object.values(m.exposures).some((model) =>
					Object.values(model.syncs ?? {}).some((sync) => sync.with === name)
				),
				configuration: d.configuration ?? {}
			})),
		signup:
			h.signup === undefined
				? null
				: { via: h.signup.via, open: signup?.rows[0]?.value !== 'closed' }
	};
});

const ref = Schema.Struct({ model: Schema.NonEmptyString, id: Schema.NonEmptyString });
const inviteData = Schema.Struct({
	email: Schema.optionalKey(Schema.NonEmptyString),
	phone: Schema.optionalKey(Schema.NonEmptyString),
	team: Schema.optionalKey(Schema.NonEmptyString),
	external: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
	party: Schema.optionalKey(ref)
}).check(Schema.makeFilter((x) => x.email !== undefined || x.phone !== undefined));
const invite = Schema.Record(Schema.String, Schema.Json)
	.check(Schema.makeFilter((input) => !('assignments' in input) && !('policies' in input)))
	.pipe(Schema.decodeTo(inviteData));
const id = { id: Schema.NonEmptyString };
export const SettingsOp = Schema.Union([
	Schema.Struct({
		op: Schema.Literal('setSignup'),
		input: Schema.Struct({ open: Schema.Boolean })
	}),
	Schema.Struct({ op: Schema.Literal('invite'), input: invite }),
	Schema.Struct({
		op: Schema.Literal('inviteMany'),
		input: Schema.Struct({
			invitations: Schema.Array(invite).check(Schema.isMinLength(1), Schema.isMaxLength(1000))
		})
	}),
	Schema.Struct({
		op: Schema.Literals([
			'revokeInvitation',
			'resendInvitation',
			'deactivate',
			'reactivate',
			'rotateKey',
			'revokeKey'
		]),
		input: Schema.Struct(id)
	}),
	Schema.Struct({
		op: Schema.Literal('setAdmin'),
		input: Schema.Struct({ ...id, admin: Schema.Boolean })
	}),
	Schema.Struct({
		op: Schema.Literal('assignTeam'),
		input: Schema.Struct({ ...id, team: Schema.NullOr(Schema.NonEmptyString) })
	}),
	Schema.Struct({
		op: Schema.Literal('setHandles'),
		input: Schema.Struct({
			...id,
			phone: Schema.optionalKey(Schema.NullOr(Schema.String)),
			telegram: Schema.optionalKey(Schema.NullOr(Schema.String))
		})
	}),
	Schema.Struct({
		op: Schema.Literal('issueKey'),
		input: Schema.Struct({
			name: Schema.NonEmptyString,
			team: Schema.NullOr(Schema.NonEmptyString).pipe(
				Schema.withDecodingDefaultKey(Effect.succeed(null))
			)
		})
	}),
	Schema.Struct({
		op: Schema.Literal('setSecret'),
		input: Schema.Struct({ name: Schema.NonEmptyString, value: Schema.NonEmptyString })
	}),
	Schema.Struct({
		op: Schema.Literal('clearSecret'),
		input: Schema.Struct({ name: Schema.NonEmptyString })
	}),
	Schema.Struct({ op: Schema.Literal('setAgent'), input: AgentSettings })
]);
export type SettingsOp = typeof SettingsOp.Type;
/** Settings dispatch uses the decoded union; identity owns authorization and database errors. */
export const applySettings = Effect.fn('shell.settingsOp')(function* (
	h: IdentityHost,
	m: EngineManifest,
	auth: Authority,
	op: SettingsOp,
	secrets: SecretsShape
) {
	const refusal = requireAdmin(auth);
	if (refusal !== null) return yield* Effect.fail(refusal);
	const secret = (name: string, effect: Effect.Effect<void, EngineError>) =>
		Effect.gen(function* () {
			if (m.workspace.secrets?.[name] === undefined)
				return yield* Effect.fail(
					BoltError.make('notFound', 'decode', `'${name}' is no declared secret.`)
				);
			yield* effect;
			return null;
		});
	switch (op.op) {
		case 'setSignup':
			return yield* members.setSignup(h, auth, op.input.open);
		case 'invite':
			return yield* members.invite(h, m, auth, op.input);
		case 'inviteMany':
			return yield* members.inviteMany(h, m, auth, op.input.invitations);
		case 'revokeInvitation':
			return yield* members.revokeInvitation(h, auth, op.input.id);
		case 'resendInvitation':
			return yield* members.resendInvitation(h, auth, op.input.id);
		case 'setAdmin':
			return yield* members.setAdmin(h, auth, op.input.id, op.input.admin);
		case 'deactivate':
			return yield* members.deactivate(h, auth, op.input.id);
		case 'reactivate':
			return yield* members.reactivate(h, auth, op.input.id);
		case 'assignTeam':
			return yield* members.assignTeam(h, m, auth, op.input.id, op.input.team);
		case 'setHandles':
			return yield* members.setHandles(h, auth, op.input.id, op.input);
		case 'issueKey':
			return yield* members.issueKey(h, m, auth, op.input.name, op.input.team);
		case 'rotateKey':
			return yield* members.rotateKey(h, auth, op.input.id);
		case 'revokeKey':
			return yield* members.revokeKey(h, auth, op.input.id);
		case 'setSecret':
			return yield* secret(op.input.name, secrets.set('workspace', op.input.name, op.input.value));
		case 'clearSecret':
			return yield* secret(op.input.name, secrets.clear('workspace', op.input.name));
		case 'setAgent': {
			const unknown = Object.keys(op.input.policies).filter((p) => m.policies[p] === undefined);
			if (unknown.length > 0)
				return yield* Effect.fail(
					BoltError.make(
						'invalid',
						'decode',
						`No policy ${unknown.map((p) => `'${p}'`).join(', ')}.`
					)
				);
			return yield* saveAgentSettings(h.db, op.input).pipe(Effect.as(null));
		}
	}
});
