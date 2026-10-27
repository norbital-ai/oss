// Actor resolution: membership chooses an authored team handle; its policies and hierarchy come from source.
// Descendants scope teamTree without inheriting grants. Static actors hold their declared policies.
import type { Json } from '../../decl/values.ts';
import type { SourceTeam } from '../../decl/access/team.ts';
import { compileAuthority, type Holder } from '../access/authority.ts';
import type { Authority, EngineActor } from '../contracts.ts';
import { teams, type EngineManifest } from '../manifest.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { BoltError } from '../../protocol/errors.ts';
import { Clock, Effect, Schema } from 'effect';
import { identityHistory, IMAGES, partyRow, signupOf, IdentityStatement } from './session.ts';
import { envoySpec } from '../envoys/spec.ts';
const UserSchema = Schema.Struct({
	id: Schema.String,
	email: Schema.NullOr(Schema.String),
	phone: Schema.NullOr(Schema.String),
	kind: Schema.String,
	active: Schema.Boolean,
	admin: Schema.Boolean,
	team: Schema.NullOr(Schema.String),
	party: Schema.NullOr(Schema.Struct({ model: Schema.String, id: Schema.String })),
	signup: Schema.Boolean,
	revision: Schema.Number
});
type UserRow = typeof UserSchema.Type;
type TeamGraph = {
	readonly [handle: string]: SourceTeam;
};
const q = (text: string, ...params: Json[]) => ({ text, params });
export class Authorities {
	private readonly cache = new Map<string, Authority>();
	private readonly m: EngineManifest;
	private readonly release: string;
	private readonly max: number;
	constructor(m: EngineManifest, release: string, max = 1000) {
		this.m = m;
		this.release = release;
		this.max = max;
	}
	/** Compiled once per key; the key carries every revision it depends on, so a change is a miss, never a stale hit. */
	compile(holder: Holder, key: string): Authority {
		const full = `${key}@${this.release}`;
		let a = this.cache.get(full);
		if (a === undefined) {
			a = compileAuthority(this.m, holder, full);
			this.cache.set(full, a);
			if (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value!);
		}
		return a;
	}
	/**
	 * A member who signed up before the record that is them existed is bound to it as soon as exactly one record holds their
	 * number (or email) — the booking that files a newcomer's customer record shows them that booking at once.
	 */
	private bind(db: TenantDb, u: UserRow) {
		return Effect.gen(
			function* (this: Authorities) {
				const signup = signupOf(this.m);
				if (u.kind !== 'external' || u.party !== null || signup?.party === undefined) return u;
				// ponytail: one read per request while a member stays unbound; bounded by how long they have no record
				const address =
					u.phone !== null && signup.party.match.phone !== undefined
						? { kind: 'phone' as const, value: u.phone }
						: u.email !== null && signup.party.match.email !== undefined
							? { kind: 'email' as const, value: u.email }
							: null;
				if (address === null) return u;
				const [rows] = yield* db.read([partyRow(signup, address)]);
				if (rows!.rows.length !== 1) return u;
				const party = { model: signup.party.model, id: String(rows!.rows[0]!['id']) };
				const s = new IdentityStatement();
				const out = yield* db.write({
					params: s.params,
					text: `WITH bound AS (UPDATE sys_user SET party = ${s.p(party)}::jsonb, revision = revision + 1
	WHERE id = ${s.p(u.id)} AND party IS NULL ${IMAGES}),
${identityHistory(s, 'sys_user', 'bound', new Date(yield* Clock.currentTimeMillis), `member:${u.id}`)}
SELECT (SELECT (n->>'revision')::int FROM bound) AS revision`
				});
				const revision = out.rows[0]?.['revision'];
				// a concurrent request bound them first: its revision is not this one's, so the next request re-reads it
				return typeof revision === 'number' ? { ...u, party, revision } : u;
			}.bind(this)
		);
	}
	/**
	 * A member's authority, or `null` for an unknown or deactivated user. One pipelined read. `preview` (rule 39) clears
	 * the administrator flag, so the previewed member's grants and approval eligibility apply.
	 */
	member(db: TenantDb, userId: string, preview = false) {
		return Effect.gen(
			function* (this: Authorities) {
				const [users] = yield* db.read([
					q(
						'SELECT id, email, phone, kind, active, admin, team, party, signup, revision FROM sys_user WHERE id = $1',
						userId
					)
				]);
				const value = users?.rows[0];
				if (value === undefined) return null;
				const found = yield* Schema.decodeUnknownEffect(UserSchema)(value).pipe(
					Effect.mapError((error) => BoltError.make('corrupt', 'decode', error.message, error))
				);
				if (found === undefined || !found.active) return null;
				const u = yield* this.bind(db, found);
				const graph = teams(this.m),
					team = u.team !== null && Object.hasOwn(graph, u.team) ? u.team : null;
				const actor: EngineActor = {
					kind: 'member',
					id: u.id,
					email: u.email,
					phone: u.phone,
					external: u.kind === 'external',
					teams: team === null ? [] : [team],
					teamPath: team === null ? [] : path(graph, team),
					admin: u.admin && u.kind === 'staff' && !preview,
					party: u.party
				};
				const policies = [
					...new Set([
						...(team === null ? [] : (graph[team]?.policies ?? [])),
						...(u.signup ? (signupOf(this.m)?.policies ?? []) : [])
					])
				];
				return this.compile(
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
					teamPath: path(graph, team),
					admin: false,
					party: null
				};
				return this.compile(
					{ actor, admin: false, policies: definition.policies, teamTree: closure(graph, team) },
					`preview:team:${team}:${previewer.id}`
				);
			}.bind(this)
		);
	}
	/** An API key selects a source team; the secret never supplies policies. */
	apiKey(db: TenantDb, keyId: string) {
		return Effect.gen(
			function* (this: Authorities) {
				const [keys] = yield* db.read([
					q(
						'SELECT id, team, revision FROM sys_api_key WHERE id = $1 AND revoked_at IS NULL',
						keyId
					)
				]);
				const k = keys?.rows[0];
				if (k === undefined || typeof k['id'] !== 'string' || typeof k['revision'] !== 'number')
					return null;
				const team = typeof k['team'] === 'string' ? k['team'] : undefined;
				const graph = teams(this.m),
					policies =
						team === undefined || !Object.hasOwn(graph, team) ? [] : (graph[team]?.policies ?? []);
				return this.compile(
					{ actor: { kind: 'apiKey', key: k['id'] }, admin: false, policies },
					`apiKey:${k['id']}:${k['revision']}`
				);
			}.bind(this)
		);
	}
	/**
	 * hook:envoys — an envoy's turn on `instance` (P32, §4.4): the envoy's declared `policies`, never admin by itself, no
	 * party; `{ actor: 'instance' }` is the instance. On a DM from a linked sender, `dm: 'union'` (the default) joins the
	 * member's own authority (their policies, team tree, or the admin bypass): the least constraining grant admits;
	 * `dm: 'envoy'` holds the envoy's policies alone with every operand bound to the member — never admin, no member route,
	 * tool or automation. Limits stay the envoy's. Re-resolved from the instance and the spec as they are now: `null` when the
	 * instance no longer serves this envoy (paused, redeployed) or the linked member is no longer active.
	 */
	envoy(
		db: TenantDb,
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
				const spec = yield* envoySpec(this.m, db, o.envoy);
				if (spec === undefined)
					return yield* Effect.fail(
						BoltError.make('unknownEnvoy', 'admission', `no envoy '${o.envoy}'`)
					);
				const [rows] = yield* db.read([
					q(
						'SELECT revision FROM sys_integration WHERE id = $1 AND envoy = $2 AND active AND owner IS NULL',
						o.instance,
						o.envoy
					)
				]);
				const revision = rows!.rows[0]?.['revision'];
				if (revision === undefined) return null;
				const actor: EngineActor = {
					kind: 'envoy',
					envoy: o.envoy,
					instance: o.instance,
					sender: o.sender,
					member: o.member
				};
				const at = `${o.envoy}:${o.instance}:${String(revision)}:${o.sender}`;
				const own = this.compile(
					{ actor, admin: false, policies: spec.policies },
					`envoy:${at}:${o.member ?? ''}`
				);
				if (!o.dm || o.member === null) return own;
				const mine = yield* this.member(db, o.member);
				if (mine === null || mine.actor.kind !== 'member') return null;
				// ponytail: every arm's `actor` operands resolve against the linked member, the envoy's too; the member directory arms (rule 35a) do not join
				const linked = { ...actor, linked: mine.actor };
				if (spec.dm === 'envoy')
					return this.compile(
						{
							actor: linked,
							admin: false,
							policies: spec.policies,
							teamTree: mine.teamTree,
							scopes: mine.scopes
						},
						`envoy-bound:${at}:${mine.key}`
					);
				const both = this.compile(
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
	/** A visitor holds exactly the app's public policies (rule 38d). `visitor` is an idempotency id, never an identity. */
	visitor(app: string, visitor: string): Authority {
		const audience = this.m.apps[app]?.audience;
		const policies =
			typeof audience === 'object' && audience !== null && 'public' in audience
				? audience.public
				: undefined;
		if (policies === undefined)
			throw BoltError.make('forbidden', 'admission', `app '${app}' has no public audience`);
		return this.compile(
			{ actor: { kind: 'visitor', app, visitor }, admin: false, policies },
			`visitor:${app}:${visitor}`
		);
	}
	/**
	 * A system actor: an automation's `runAs` policies (or, for `'trigger'`, the trigger's own authority), or a platform run
	 * or a remote sync (the workspace's own work). Syncs hold no authored policies or team and cannot approve.
	 */
	system(
		run: string,
		by: Extract<
			EngineActor,
			{
				kind: 'system';
			}
		>['by'],
		trigger?: Authority
	): Authority {
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
		const runAs = this.m.automations[by.automation]?.runAs;
		if (runAs === undefined)
			throw BoltError.make('unknownAutomation', 'admission', `no automation '${by.automation}'`);
		if (runAs === 'trigger') {
			if (trigger === undefined)
				throw BoltError.make(
					'noTrigger',
					'admission',
					`'${by.automation}' runs as its trigger, and none was given`
				);
			return trigger;
		}
		return this.compile(
			{ actor, admin: false, policies: runAs },
			`automation:${by.automation}:${run}`
		);
	}
}
/** Rule 39: admin-only; the Authority becomes the previewed member's (or team's, `{ team }`), administrator flag cleared. */
export const previewAs = Effect.fn('Bolt.previewAs')(function* (
	real: Authority,
	authorities: Authorities,
	db: TenantDb,
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
			? yield* authorities.member(db, target, true)
			: yield* authorities.team(db, real.actor, target.team);
	if (authority === null)
		return yield* Effect.fail(
			BoltError.make(
				'notFound',
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
/** A source team and every authored descendant (`actor.teamTree`). */
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
