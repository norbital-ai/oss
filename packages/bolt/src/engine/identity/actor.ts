// Actor resolution: a member holds their teams' policies, read from the team graph. Descendants scope teamTree
// without inheriting grants. Static actors hold their declared policies.
import { bindingsAt } from '../query/reader.ts';
import { memberTeams } from './teams.ts';
import { sql } from '../db/sql.ts';
import { compile_authority, withHeld, type Holder } from '../access/authority.ts';
import { open_sql } from '../approvals/sql.ts';
import type { Authority, EngineActor } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { BoltError } from '../../protocol/errors.ts';
import { Clock, Effect, Schema } from 'effect';
import { CapturedResult, nativeCommit, type CommitPublication } from '../db/captured.ts';
import { triggers_of } from '../runs/queue.ts';
import {
	identityHistory,
	identityPiece,
	jsonb,
	partyRow,
	signup_of,
	IdentityStatement,
	SESSION_MEMO_MS
} from './session.ts';
import { envoySpec } from '../envoys/spec.ts';
import { closure, path, teamGraph } from './graph.ts';
const UserSchema = Schema.Struct({
	id: Schema.String,
	email: Schema.NullOr(Schema.String),
	phone: Schema.NullOr(Schema.String),
	kind: Schema.Literals(['staff', 'external', 'anonymous']),
	active: Schema.Boolean,
	admin: Schema.Boolean,
	team: Schema.NullOr(Schema.String),
	granted_teams: Schema.optionalKey(Schema.Array(Schema.String)),
	granted_on: Schema.optionalKey(Schema.String),
	party: Schema.NullOr(
		Schema.Struct({
			model: Schema.String,
			id: Schema.String,
			/** It is theirs by holding their address, where a person's invitation did not name it. */
			matched: Schema.optionalKey(Schema.Boolean)
		})
	),
	signup: Schema.Boolean,
	revision: Schema.Number
});
type UserRow = typeof UserSchema.Type;
export class Authorities {
	private readonly cache = new Map<string, Authority>();
	private readonly holds = new Map<
		string,
		{ records: readonly { readonly collection: string; readonly id: string }[]; stamp: number; at: number }
	>();
	/** With `remember`: each active member's row, and the identity writes when it was read. */
	private readonly rows = new Map<
		string,
		{ readonly row: UserRow; readonly stamp: number; readonly at: number }
	>();
	private readonly m: EngineManifest;
	private readonly release: string;
	private readonly max: number;
	private readonly remember: boolean;
	constructor(
		m: EngineManifest,
		release: string,
		options: { readonly max?: number; readonly remember?: boolean } = {}
	) {
		this.m = m;
		this.release = release;
		this.max = options.max ?? 1000;
		this.remember = options.remember ?? false;
	}
	/** Compiled once per key; the key carries every revision it depends on, so a change is a miss, never a stale hit. */
	compile(holder: Holder, key: string): Effect.Effect<Authority, BoltError> {
		const full = `${key}@${this.release}`;
		const hit = this.cache.get(full);
		if (hit !== undefined) return Effect.succeed(hit);
		return compile_authority(this.m, holder, full).pipe(
			Effect.tap((a) =>
				Effect.sync(() => {
					this.cache.set(full, a);
					if (this.cache.size > this.max) {
						const oldest = this.cache.keys().next();
						if (!oldest.done) this.cache.delete(oldest.value);
					}
				})
			)
		);
	}
	/**
	 * A member whose record is decided by who holds their address, which any write to a record can change: never
	 * remembered. A party a person's invitation named stays what it is.
	 */
	private matched(u: UserRow) {
		return (
			u.kind === 'external' &&
			signup_of(this.m)?.party !== undefined &&
			(u.party === null || u.signup || u.party.matched === true)
		);
	}
	/**
	 * A matched member's record, as it stands now. They are bound as soon as exactly one record holds their number (or
	 * email), so the booking that files a newcomer's customer record shows them that booking at once, and unbound once
	 * theirs no longer does, so a number the desk corrected or a phone company reassigned opens nothing.
	 */
	private bind(db: TenantDb, publication: CommitPublication, u: UserRow) {
		return Effect.gen(
			function* (this: Authorities) {
				const signup = signup_of(this.m);
				if (!this.matched(u) || signup?.party === undefined) return u;
				// ponytail: one read per request for a matched member; a write-side unbind would save it, on every write path
				const address =
					u.phone !== null && signup.party.match.phone !== undefined
						? { kind: 'phone' as const, value: u.phone }
						: u.email !== null && signup.party.match.email !== undefined
							? { kind: 'email' as const, value: u.email }
							: null;
				if (address === null) return u;
				const [rows] = yield* db.read([partyRow(signup, address)]);
				if (rows === undefined)
					return yield* BoltError.make('corrupt', 'decode', 'The party query returned no result.');
				const found = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })))(rows.rows).pipe(
					Effect.mapError((error) => BoltError.make('corrupt', 'decode', error.message, error))
				);
				const holders = found.map((row) => row.id);
				if (u.party !== null && holders.includes(u.party.id)) return u;
				const [only, other] = holders;
				const party =
					only === undefined || other !== undefined
						? null
						: { model: signup.party.model, id: only, matched: true };
				if (party === null && u.party === null) return u;
				const s = new IdentityStatement();
				identityPiece(s, 'bound', 'sys_user', `UPDATE sys_user SET party = ${s.p(jsonb(party))}::jsonb, revision = revision + 1
	WHERE id = ${s.p(u.id)} AND party IS NOT DISTINCT FROM ${s.p(jsonb(u.party))}::jsonb`);
				identityHistory(s, 'sys_user', 'bound', new Date(yield* Clock.currentTimeMillis), `member:${u.id}`, triggers_of(this.m).writes, 0);
				const { revision } = yield* nativeCommit(db.write, publication, s,
					Schema.Struct({ ...CapturedResult.fields, revision: Schema.NullOr(Schema.Number) }),
					"(SELECT (n->>'revision')::int FROM bound) AS revision");
				// a concurrent request got there first with this answer: its revision, never the old record's
				return { ...u, party, revision: typeof revision === 'number' ? revision : u.revision + 1 };
			}.bind(this)
		);
	}
	/** An active member's row, from memory while no statement on people or sessions has finished since it was read. */
	private row(db: TenantDb, publication: CommitPublication, userId: string) {
		return Effect.gen(
			function* (this: Authorities) {
				const now = yield* Clock.currentTimeMillis,
					stamp = db.identityWrites(),
					held = this.rows.get(userId);
				if (this.m.workspace.memberships === undefined && held !== undefined && held.stamp === stamp && now - held.at < SESSION_MEMO_MS) return held.row;
				this.rows.delete(userId);
				const [users] = yield* db.read([
					sql(
						`SELECT u.id, u.email, u.phone, u.kind, u.active, u.admin, u.team, u.party, u.signup, u.revision
						 ${this.m.workspace.memberships === undefined ? '' : ', ' + memberTeams(this.m.workspace, '$2') + ' AS granted_teams'}
						 FROM sys_user u WHERE u.id = $1`,
						userId, ...(this.m.workspace.memberships === undefined ? [] : [new Date(now).toISOString()])
					)
				]);
				if (users === undefined)
					return yield* BoltError.make('corrupt', 'decode', 'The member query returned no result.');
				const value = users.rows[0];
				if (value === undefined) return null;
				const found = yield* Schema.decodeUnknownEffect(UserSchema)(value).pipe(
					Effect.mapError((error) => BoltError.make('corrupt', 'decode', error.message, error))
				);
				// a membership change seen here may be another activation's: every row read before it is read again
				if (held !== undefined && (held.row.revision !== found.revision || !found.active)) this.rows.clear();
				// an anonymous user is a visitor's identity (a cookie, never a session): it is no member
				if (!found.active || found.kind === 'anonymous') return null;
				const u = yield* this.bind(db, publication, found.granted_teams === undefined ? found : { ...found, granted_on: bindingsAt(now, this.m.workspace.tz).today });
				if (this.remember && this.m.workspace.memberships === undefined && !this.matched(u)) {
					this.rows.set(userId, { row: u, stamp, at: now });
					if (this.rows.size > this.max) {
						const oldest = this.rows.keys().next();
						if (!oldest.done) this.rows.delete(oldest.value);
					}
				}
				return u;
			}.bind(this)
		);
	}
	/**
	 * A member's authority, or `null` for an unknown or deactivated user. One pipelined read. `preview` clears
	 * the administrator flag, so the previewed member's grants and approval eligibility apply.
	 */
	member(db: TenantDb, publication: CommitPublication, userId: string, preview = false) {
		return Effect.gen(
			function* (this: Authorities) {
				const u = yield* this.row(db, publication, userId);
				if (u === null) return null;
				const graph = yield* teamGraph(db),
					direct = u.granted_teams ?? (u.team === null ? [] : [u.team]);
				const actor: EngineActor = {
					kind: 'member',
					id: u.id,
					email: u.email,
					phone: u.phone,
					external: u.kind === 'external',
					teams: direct,
					team_path: direct.flatMap(team => path(graph, team)),
					// an administrator has the workspace's full authority; a preview clears it
					admin: !preview && u.admin && u.kind === 'staff',
					party: u.party === null ? null : { model: u.party.model, id: u.party.id }
				};
				const policies = [
					...new Set([
						...direct.flatMap(team => graph.teams[team]?.policies ?? []),
						...(u.signup ? (signup_of(this.m)?.policies ?? []) : [])
					])
				];
				const compiled = yield* this.compile(
					{
						actor,
						admin: actor.admin,
						policies,
						teamTree: [...new Set(direct.flatMap(team => closure(graph, team)))]
					},
					`${preview ? 'preview' : 'member'}:${u.id}:${u.revision}:${graph.revision}${u.granted_teams === undefined ? '' : ':' + JSON.stringify(direct)}`
				);
				const member = u.granted_on === undefined ? compiled : { ...compiled, membershipDay: u.granted_on };
				return member.admin ? member : yield* withHeld(this.m, member, yield* this.held(db, u.id, direct));
			}.bind(this)
		);
	}
	/**
	 * The records of the open approval requests this member may decide: in a team or among the users of any step, or
	 * in a superseding team, and not the requester. Remembered while nothing this generation wrote could have changed it.
	 */
	private held(db: TenantDb, id: string, direct: readonly string[]) {
		return Effect.gen(
			function* (this: Authorities) {
				const now = yield* Clock.currentTimeMillis,
					stamp = db.writes(),
					key = `${id}:${direct.join(',')}`,
					hit = this.holds.get(key);
				if (hit !== undefined && hit.stamp === stamp && now - hit.at < SESSION_MEMO_MS) return hit.records;
				const records = yield* db.rows(
					Schema.Struct({ collection: Schema.String, id: Schema.String }),
					sql(
						`SELECT DISTINCT r ->> 'collection' AS collection, r ->> 'id' AS id
						 FROM bolt_approvals a CROSS JOIN LATERAL jsonb_array_elements(a.records) r
						 WHERE ${open_sql('a.state')} AND a.requestor <> $1 AND a.requestor_user IS DISTINCT FROM $2
						 AND (a.route -> 'superseded_by' ?| ARRAY(SELECT jsonb_array_elements_text($3::jsonb)) OR EXISTS (
							SELECT 1 FROM jsonb_array_elements(a.route -> 'steps') s
							WHERE s -> 'teams' ?| ARRAY(SELECT jsonb_array_elements_text($3::jsonb)) OR s -> 'users' ? $2))
						 ORDER BY 1, 2 LIMIT 2000`,
						`member:${id}`, id, JSON.stringify(direct)
					)
				);
				this.holds.set(key, { records, stamp, at: now });
				if (this.holds.size > this.max) {
					const oldest = this.holds.keys().next();
					if (!oldest.done) this.holds.delete(oldest.value);
				}
				return records;
			}.bind(this)
		);
	}
	/** Preview a team with its policies; administrator authority is cleared. */
	team(
		db: TenantDb,
		previewer: Extract<
			EngineActor,
			{
				kind: 'member';
			}
		>,
		team: string
	) {
		return Effect.gen(
			function* (this: Authorities) {
				const graph = yield* teamGraph(db),
					definition = Object.hasOwn(graph.teams, team) ? graph.teams[team] : undefined;
				if (definition === undefined) return null;
				const actor: EngineActor = {
					...previewer,
					external: false,
					teams: [team],
					team_path: path(graph, team),
					admin: false,
					party: null
				};
				const authority = yield* this.compile(
					{ actor, admin: false, policies: definition.policies, teamTree: closure(graph, team) },
					`preview:team:${team}:${previewer.id}:${graph.revision}`
				);
				return { ...authority, preview: { by: previewer.id, team } };
			}.bind(this)
		);
	}
	/** An API key holds its team's policies; the secret never supplies any. */
	api_key(db: TenantDb, keyId: string) {
		return Effect.gen(
			function* (this: Authorities) {
				const [keys] = yield* db.read([
					sql(
						'SELECT id, team, revision FROM sys_api_key WHERE id = $1 AND revoked_at IS NULL',
						keyId
					)
				]);
				if (keys === undefined)
					return yield* BoltError.make('corrupt', 'decode', 'The API key query returned no result.');
				const k = keys.rows[0];
				if (k === undefined || typeof k['id'] !== 'string' || typeof k['revision'] !== 'number')
					return null;
				const team = typeof k['team'] === 'string' ? k['team'] : undefined;
				const graph = yield* teamGraph(db),
					policies = team === undefined ? [] : (graph.teams[team]?.policies ?? []);
				return yield* this.compile(
					{ actor: { kind: 'api_key', key: k['id'] }, admin: false, policies },
					`api_key:${k['id']}:${k['revision']}:${graph.revision}`
				);
			}.bind(this)
		);
	}
	/**
	 * An envoy's turn on `instance`: the envoy's declared `policies`, never admin by itself, no
	 * party; `{ var: 'actor.instance' }` is the instance. On a DM from a linked sender, `dm: 'union'` (the default) joins the
	 * member's own policies and team tree: the least constraining grant admits; `dm: 'envoy'`, and every administrator's DM
	 * (an envoy never holds admin), holds the envoy's policies alone with every operand bound to the member — no member
	 * route, tool or automation. Limits stay the envoy's. Re-resolved from the instance and the spec as they are now: `null` when the
	 * instance no longer serves this envoy (paused, redeployed) or the linked member is no longer active.
	 */
	envoy(
		db: TenantDb,
		publication: CommitPublication,
		o: {
			envoy: string;
			instance: string;
			sender: string;
			member: string | null;
			dm: boolean;
		}
	) {
		return Effect.gen(
			function* (this: Authorities) {
				const spec = yield* envoySpec(db, o.envoy);
				if (spec === undefined)
					return yield* Effect.fail(
						BoltError.make('unknown_envoy', 'admission', `no envoy '${o.envoy}'`)
					);
				const [rows] = yield* db.read([
					sql(
						`SELECT (i.revision + ec.revision)::int AS revision
						 FROM sys_integration i
						 JOIN sys_envoy_channel ec ON ec.integration = i.id AND ec.envoy = $2::uuid
						 WHERE i.id = $1 AND i.active AND i.owner IS NULL AND ec.active`,
						o.instance,
						o.envoy
					)
				]);
				if (rows === undefined)
					return yield* BoltError.make('corrupt', 'decode', 'The envoy account query returned no result.');
				const row = rows.rows[0];
				if (row === undefined) return null;
				const { revision } = yield* Schema.decodeUnknownEffect(Schema.Struct({ revision: Schema.Number }))(row).pipe(
					Effect.mapError((error) => BoltError.make('corrupt', 'decode', error.message, error))
				);
				const actor: EngineActor = {
					kind: 'envoy',
					envoy: o.envoy,
					instance: o.instance,
					sender: o.sender,
					member: o.member
				};
				const at = `${o.envoy}:${o.instance}:${String(revision)}:${o.sender}`;
				const own = yield* this.compile(
					{ actor, admin: false, policies: spec.policies },
					`envoy:${at}:${o.member ?? ''}`
				);
				if (!o.dm || o.member === null) return own;
				const mine = yield* this.member(db, publication, o.member);
				if (mine === null || mine.actor.kind !== 'member') return null;
				// ponytail: every arm's `actor` operands resolve against the linked member, the envoy's too; the member directory arms do not join
				const linked = { ...actor, linked: mine.actor };
				// an envoy never holds admin: an administrator's DM gets the envoy's declared policies, never the bypass
				if (spec.dm === 'envoy' || mine.admin)
					return yield* this.compile(
						{
							actor: linked,
							admin: false,
							policies: spec.policies,
							teamTree: mine.teamTree
						},
						`envoy-bound:${at}:${mine.key}`
					);
				const both = yield* this.compile(
					{
						actor: linked,
						admin: false,
						policies: [...new Set([...spec.policies, ...mine.policies])],
						teamTree: mine.teamTree
					},
					`envoy-dm:${at}:${mine.key}`
				);
				return { ...both, limits: own.limits };
			}.bind(this)
		);
	}
	/**
	 * A visitor holds exactly the app's public policies. `visitor` is the visitor's anonymous user when
	 * `anonymous`, else a per-request id that owns nothing.
	 */
	visitor(app: string, visitor: string, anonymous = false): Effect.Effect<Authority, BoltError> {
		const audience = this.m.apps[app]?.audience;
		const policies =
			typeof audience === 'object' && audience !== null && 'public' in audience
				? audience.public
				: undefined;
		if (policies === undefined)
			return Effect.fail(BoltError.make('forbidden', 'admission', `app '${app}' has no public audience`));
		return this.compile(
			{
				actor: {
					kind: 'visitor',
					app,
					visitor,
					...(anonymous ? { anonymous: true as const } : {})
				},
				admin: false,
				policies
			},
			`visitor:${app}:${visitor}:${anonymous}`
		);
	}
}
/** Admin-only: a permissions preview clears admin; explicit impersonation retains the member's actual grants. */
export const preview_as = Effect.fn('Bolt.preview_as')(function* (
	real: Authority,
	authorities: Authorities,
	db: TenantDb,
	publication: CommitPublication,
	target:
		| string
		| { member: string }
		| {
				team: string;
		  }
) {
	if (!real.admin || real.actor.kind !== 'member')
		return yield* Effect.fail(
			BoltError.make(
				'forbidden',
				'admission',
				'Only an administrator can preview as a member or team.'
			)
		);
	const impersonate = typeof target !== 'string' && 'member' in target;
	const authority =
		typeof target === 'string'
			? yield* authorities.member(db, publication, target, true)
			: 'member' in target
				? yield* authorities.member(db, publication, target.member)
				: yield* authorities.team(db, real.actor, target.team);
	if (authority === null)
		return yield* Effect.fail(
			BoltError.make(
				'not_found',
				'admission',
				typeof target === 'string' || impersonate ? 'No active member to preview.' : 'No such team to preview.'
			)
		);
	return {
		authority: {
			...authority,
			key: `${authority.key}:preview:${real.actor.id}:${impersonate ? 'impersonate' : 'permissions'}`,
			preview: {
				by: real.actor.id,
				team: typeof target !== 'string' && 'team' in target ? target.team : null,
				...(impersonate ? { impersonate: true as const } : {})
			}
		},
		impersonatedBy: real.actor.id
	};
});
