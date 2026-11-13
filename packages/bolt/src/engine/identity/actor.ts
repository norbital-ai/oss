// Actor resolution: membership chooses an authored team handle; its policies and hierarchy come from source.
// Descendants scope teamTree without inheriting grants. Static actors hold their declared policies.
import { sql } from '../db/sql.ts';
import type { SourceTeam } from '../../decl/access/team.ts';
import { compile_authority, type Holder } from '../access/authority.ts';
import type { Authority, EngineActor } from '../contracts.ts';
import { teams, type EngineManifest } from '../manifest.ts';
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
	IdentityStatement
} from './session.ts';
import { envoySpec } from '../envoys/spec.ts';
const UserSchema = Schema.Struct({
	id: Schema.String,
	email: Schema.NullOr(Schema.String),
	phone: Schema.NullOr(Schema.String),
	kind: Schema.Literals(['staff', 'external', 'anonymous']),
	active: Schema.Boolean,
	admin: Schema.Boolean,
	team: Schema.NullOr(Schema.String),
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
type TeamGraph = {
	readonly [handle: string]: SourceTeam;
};
/** How long a caller's row or session is trusted unread; a statement on either ends it at once. */
export const MEMO_MS = 900_000;
export class Authorities {
	private readonly cache = new Map<string, Authority>();
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
				if (held !== undefined && held.stamp === stamp && now - held.at < MEMO_MS) return held.row;
				this.rows.delete(userId);
				const [users] = yield* db.read([
					sql(
						'SELECT id, email, phone, kind, active, admin, team, party, signup, revision FROM sys_user WHERE id = $1',
						userId
					)
				]);
				if (users === undefined)
					return yield* BoltError.make('corrupt', 'decode', 'The member query returned no result.');
				const value = users.rows[0];
				if (value === undefined) return null;
				const found = yield* Schema.decodeUnknownEffect(UserSchema)(value).pipe(
					Effect.mapError((error) => BoltError.make('corrupt', 'decode', error.message, error))
				);
				// an anonymous user is a visitor's identity (a cookie, never a session): it is no member
				if (!found.active || found.kind === 'anonymous') return null;
				const u = yield* this.bind(db, publication, found);
				if (this.remember && !this.matched(u)) {
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
				const graph = teams(this.m),
					team = u.team !== null && Object.hasOwn(graph, u.team) ? u.team : null;
				const actor: EngineActor = {
					kind: 'member',
					id: u.id,
					email: u.email,
					phone: u.phone,
					external: u.kind === 'external',
					teams: team === null ? [] : [team],
					team_path: team === null ? [] : path(graph, team),
					// an administrator has the workspace's full authority; a preview clears it
					admin: !preview && u.admin && u.kind === 'staff',
					party: u.party === null ? null : { model: u.party.model, id: u.party.id }
				};
				const policies = [
					...new Set([
						...(team === null ? [] : (graph[team]?.policies ?? [])),
						...(u.signup ? (signup_of(this.m)?.policies ?? []) : [])
					])
				];
				return yield* this.compile(
					{
						actor,
						admin: actor.admin,
						policies,
						teamTree: team === null ? [] : closure(graph, team)
					},
					`${preview ? 'preview' : 'member'}:${u.id}:${u.revision}`
				);
			}.bind(this)
		);
	}
	/** Preview a source team with its declared grants; administrator authority is cleared. */
	team(
		_db: TenantDb,
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
				const graph = teams(this.m);
				if (!Object.hasOwn(graph, team)) return null;
				const definition = graph[team];
				if (definition === undefined) return null;
				const actor: EngineActor = {
					...previewer,
					external: false,
					teams: [team],
					team_path: path(graph, team),
					admin: false,
					party: null
				};
				return yield* this.compile(
					{ actor, admin: false, policies: definition.policies, teamTree: closure(graph, team) },
					`preview:team:${team}:${previewer.id}`
				);
			}.bind(this)
		);
	}
	/** An API key selects a source team; the secret never supplies policies. */
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
				const graph = teams(this.m),
					policies =
						team === undefined || !Object.hasOwn(graph, team) ? [] : (graph[team]?.policies ?? []);
				return yield* this.compile(
					{ actor: { kind: 'api_key', key: k['id'] }, admin: false, policies },
					`api_key:${k['id']}:${k['revision']}`
				);
			}.bind(this)
		);
	}
	/**
	 * hook:envoys — an envoy's turn on `instance`: the envoy's declared `policies`, never admin by itself, no
	 * party; `{ var: 'requestor.instance' }` is the instance. On a DM from a linked sender, `dm: 'union'` (the default) joins the
	 * member's own authority (their policies, team tree, or the admin bypass): the least constraining grant admits;
	 * `dm: 'envoy'` holds the envoy's policies alone with every operand bound to the member — never admin, no member route,
	 * tool or automation. Limits stay the envoy's. Re-resolved from the instance and the spec as they are now: `null` when the
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
						'SELECT revision FROM sys_integration WHERE id = $1 AND envoy = $2 AND active AND owner IS NULL',
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
				if (spec.dm === 'envoy')
					return yield* this.compile(
						{
							actor: linked,
							admin: false,
							policies: spec.policies,
							teamTree: mine.teamTree,
							scopes: mine.scopes
						},
						`envoy-bound:${at}:${mine.key}`
					);
				const both = yield* this.compile(
					{
						actor: linked,
						admin: mine.admin,
						policies: [...new Set([...spec.policies, ...mine.policies])],
						teamTree: mine.teamTree,
						scopes: mine.scopes
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
	/**
	 * A system actor: an automation's declared policies, or a platform run or a remote sync (the workspace's own work).
	 * Syncs hold no authored policies or team and cannot approve.
	 */
	system(
		run: string,
		by: Extract<
			EngineActor,
			{
				kind: 'system';
			}
		>['by']
	): Effect.Effect<Authority, BoltError> {
		const actor: EngineActor = { kind: 'system', run, by };
		if ('platform' in by)
			return this.compile(
				{ actor, admin: false, platform: true, policies: [] },
				`platform:${by.platform}:${run}`
			);
		if ('sync' in by)
			return this.compile(
				{ actor, admin: false, platform: true, policies: [] },
				`sync:${by.sync}:${by.instance}:${run}`
			);
		const policies = this.m.automations[by.automation]?.policies;
		if (policies === undefined)
			return Effect.fail(BoltError.make('unknown_automation', 'admission', `no automation '${by.automation}'`));
		return this.compile({ actor, admin: false, policies }, `automation:${by.automation}:${run}`);
	}
}
/** Rule 39: admin-only; the Authority becomes the previewed member's (or team's, `{ team }`), administrator flag cleared. */
export const preview_as = Effect.fn('Bolt.preview_as')(function* (
	real: Authority,
	authorities: Authorities,
	db: TenantDb,
	publication: CommitPublication,
	target:
		| string
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
	const authority =
		typeof target === 'string'
			? yield* authorities.member(db, publication, target, true)
			: yield* authorities.team(db, real.actor, target.team);
	if (authority === null)
		return yield* Effect.fail(
			BoltError.make(
				'not_found',
				'admission',
				typeof target === 'string' ? 'No active member to preview.' : 'No such team to preview.'
			)
		);
	return {
		authority: {
			...authority,
			preview: { by: real.actor.id, team: typeof target === 'string' ? null : target.team }
		},
		impersonatedBy: real.actor.id
	};
});
/** A source team and every authored descendant (`requestor.team_tree`). */
function closure(graph: TeamGraph, root: string): string[] {
	const out = [root];
	for (let i = 0; i < out.length; i++)
		for (const [handle, team] of Object.entries(graph))
			if (team.parent === out[i] && !out.includes(handle)) out.push(handle);
	return out;
}
function path(graph: TeamGraph, root: string): string[] {
	const out: string[] = [],
		seen = new Set<string>();
	for (let handle: string | null = root; handle !== null && !seen.has(handle);) {
		seen.add(handle);
		const team: SourceTeam | undefined = graph[handle];
		if (team === undefined) break;
		out.push(team.name);
		handle = team.parent;
	}
	return out;
}
