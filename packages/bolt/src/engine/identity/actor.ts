// Actor resolution (§3.9) and the Authority cache (rule 37): a member holds the policies of their team (`+team.ts`,
// matched by name, case-insensitive) and of their assignments; the team hierarchy scopes data (`teamTree`) and never
// passes policies down. Static actors hold exactly their declared policies. Preview-as is rule 39.
import { createHash } from 'node:crypto';
import type { Json } from '../../decl/values.ts';
import { compileAuthority, type Holder } from '../access/authority.ts';
import { BoltError, type Authority, type EngineActor, type EngineManifest, type TenantDb } from '../contracts.ts';
import { historyOf, IMAGES, partyRow, signupOf, stmt } from './session.ts';

type UserRow = { id: string; email: string | null; phone: string | null; kind: string; active: boolean; admin: boolean; team: string | null; party: Json; revision: number };
type TeamRow = { id: string; name: string; parent: string | null; revision: number };
type AssignmentRow = { id: string; policy: string; scope: { collection: string; id: string } | null; revision: number };

const q = (text: string, ...params: Json[]) => ({ text, params });
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('base64url').slice(0, 22);

export class Authorities {
	private readonly cache = new Map<string, Authority>();
	private readonly m: EngineManifest;
	private readonly release: string;
	private readonly max: number;
	constructor(m: EngineManifest, release: string, max = 1_000) { this.m = m; this.release = release; this.max = max; }

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
	private async bind(db: TenantDb, u: UserRow): Promise<UserRow> {
		const signup = signupOf(this.m);
		if (u.kind !== 'external' || u.party !== null || signup?.party === undefined) return u;
		// ponytail: one read per request while a member stays unbound; bounded by how long they have no record
		const address = u.phone !== null && signup.party.match.phone !== undefined ? { kind: 'phone' as const, value: u.phone }
			: u.email !== null && signup.party.match.email !== undefined ? { kind: 'email' as const, value: u.email } : null;
		if (address === null) return u;
		const [rows] = await db.read([partyRow(signup, address)]);
		if (rows!.rows.length !== 1) return u;
		const party = { collection: signup.party.collection, id: String(rows!.rows[0]!['id']) };
		const s = stmt();
		const out = await db.write({ params: s.params, text: `WITH bound AS (UPDATE sys_user SET party = ${s.p(party)}::jsonb, revision = revision + 1
	WHERE id = ${s.p(u.id)} AND party IS NULL ${IMAGES}),
${historyOf(s, 'sys_user', 'bound', new Date(), `member:${u.id}`)}
SELECT (SELECT (n->>'revision')::int FROM bound) AS revision` });
		const revision = out.rows[0]?.['revision'];
		// a concurrent request bound them first: its revision is not this one's, so the next request re-reads it
		return typeof revision === 'number' ? { ...u, party, revision } : u;
	}

	/**
	 * A member's authority, or `null` for an unknown or deactivated user. One pipelined read. `preview` (rule 39) clears
	 * the administrator flag, so the previewed member's grants and approval eligibility apply.
	 */
	async member(db: TenantDb, userId: string, preview = false): Promise<Authority | null> {
		const [users, teams, assignments] = await db.read([
			q('SELECT id, email, phone, kind, active, admin, team, party, revision FROM sys_user WHERE id = $1', userId),
			q('SELECT id, name, parent, revision FROM sys_team ORDER BY id'),
			q(`SELECT id, policy, scope, revision FROM sys_assignment WHERE (principal_type = 'sys_user' AND principal = $1)
				OR (principal_type = 'sys_team' AND principal = (SELECT team FROM sys_user WHERE id = $1)) ORDER BY id`, userId),
		]);
		const found = users!.rows[0] as UserRow | undefined;
		if (found === undefined || !found.active) return null;
		const u = await this.bind(db, found);
		const graph = teams!.rows as unknown as TeamRow[];
		const byId = new Map(graph.map((t) => [t.id, t]));
		const teamPath: string[] = [];
		for (let t = u.team === null ? undefined : byId.get(u.team); t !== undefined && !teamPath.includes(t.name); t = t.parent === null ? undefined : byId.get(t.parent))
			teamPath.push(t.name);
		const teamTree = u.team === null ? [] : closure(graph, u.team);
		const own = teamPath[0]?.toLowerCase();
		const teamPolicies = Object.entries(this.m.teams).filter(([name]) => name.toLowerCase() === own).flatMap(([, ps]) => ps);
		const rows = assignments!.rows as unknown as AssignmentRow[];
		const scopes: { [policy: string]: string[] } = {};
		for (const r of rows) if (r.scope !== null) (scopes[r.policy] ??= []).push(r.scope.id);
		const actor: EngineActor = { kind: 'member', id: u.id, email: u.email, phone: u.phone, external: u.kind === 'external', teams: u.team === null ? [] : [u.team],
			teamPath, admin: u.admin && u.kind === 'staff' && !preview, party: u.party as { collection: string; id: string } | null };
		const key = `${preview ? 'preview' : 'member'}:${u.id}:${u.revision}:${digest(rows)}:${digest(graph)}`;
		return this.compile({ actor, admin: actor.admin, policies: [...new Set([...teamPolicies, ...rows.map((r) => r.policy)])], teamTree, scopes }, key);
	}

	/**
	 * Rule 39, a previewed team: the previewer as a plain member of `team` (no own assignments, administrator flag
	 * cleared), holding the team's `+team.ts` policies and assignments, scoped by its tree. `null` for no such team.
	 */
	async team(db: TenantDb, previewer: Extract<EngineActor, { kind: 'member' }>, teamId: string): Promise<Authority | null> {
		const [teams, assignments] = await db.read([
			q('SELECT id, name, parent, revision FROM sys_team ORDER BY id'),
			q(`SELECT id, policy, scope, revision FROM sys_assignment WHERE principal_type = 'sys_team' AND principal = $1 ORDER BY id`, teamId),
		]);
		const graph = teams!.rows as unknown as TeamRow[];
		const byId = new Map(graph.map((t) => [t.id, t]));
		if (!byId.has(teamId)) return null;
		const teamPath: string[] = [];
		for (let t = byId.get(teamId); t !== undefined && !teamPath.includes(t.name); t = t.parent === null ? undefined : byId.get(t.parent)) teamPath.push(t.name);
		const own = teamPath[0]!.toLowerCase();
		const teamPolicies = Object.entries(this.m.teams).filter(([name]) => name.toLowerCase() === own).flatMap(([, ps]) => ps);
		const rows = assignments!.rows as unknown as AssignmentRow[];
		const scopes: { [policy: string]: string[] } = {};
		for (const r of rows) if (r.scope !== null) (scopes[r.policy] ??= []).push(r.scope.id);
		const actor: EngineActor = { ...previewer, external: false, teams: [teamId], teamPath, admin: false, party: null };
		return this.compile({ actor, admin: false, policies: [...new Set([...teamPolicies, ...rows.map((r) => r.policy)])], teamTree: closure(graph, teamId), scopes },
			`preview:team:${teamId}:${previewer.id}:${digest(rows)}:${digest(graph)}`);
	}

	/** An API key is a principal with assignments (§3.9); a payload never names its own policies. */
	async apiKey(db: TenantDb, keyId: string): Promise<Authority | null> {
		const [keys, assignments] = await db.read([
			q('SELECT id, revision FROM sys_api_key WHERE id = $1 AND revoked_at IS NULL', keyId),
			q(`SELECT id, policy, scope, revision FROM sys_assignment WHERE principal_type = 'sys_api_key' AND principal = $1 ORDER BY id`, keyId),
		]);
		const k = keys!.rows[0] as { id: string; revision: number } | undefined;
		if (k === undefined) return null;
		const rows = assignments!.rows as unknown as AssignmentRow[];
		const scopes: { [policy: string]: string[] } = {};
		for (const r of rows) if (r.scope !== null) (scopes[r.policy] ??= []).push(r.scope.id);
		return this.compile({ actor: { kind: 'apiKey', key: k.id }, admin: false, policies: rows.map((r) => r.policy), scopes },
			`apiKey:${k.id}:${k.revision}:${digest(rows)}`);
	}

	/**
	 * hook:envoys — an envoy turn (P32): the envoy's required `policies`, never admin by itself, no party. On a DM from a
	 * linked sender the member's own authority joins (their policies, scopes and team tree, or the admin bypass): the
	 * least constraining grant admits. Limits stay the envoy's. `null` when the linked member is no longer active.
	 */
	async envoy(db: TenantDb, o: { envoy: string; channel: string; sender: string; member: string | null; dm: boolean }): Promise<Authority | null> {
		const policies = (this.m.envoys[o.envoy] as { policies?: readonly string[] } | undefined)?.policies ?? [];
		if (policies.length === 0) throw new BoltError('unknownEnvoy', 'admission', `no envoy '${o.envoy}' with policies`);
		const actor: EngineActor = { kind: 'envoy', envoy: o.envoy, channel: o.channel, sender: o.sender, member: o.member };
		const own = this.compile({ actor, admin: false, policies }, `envoy:${o.envoy}:${o.channel}:${o.sender}:${o.member ?? ''}`);
		if (!o.dm || o.member === null) return own;
		const mine = await this.member(db, o.member);
		if (mine === null || mine.actor.kind !== 'member') return null;
		// ponytail: every arm's `actor` operands resolve against the linked member, the envoy's too; the member directory arms (rule 35a) do not join
		const both = this.compile({ actor: { ...actor, linked: mine.actor }, admin: mine.admin, policies: [...new Set([...policies, ...mine.policies])],
			teamTree: mine.teamTree, scopes: mine.scopes }, `envoy-dm:${o.envoy}:${o.channel}:${o.sender}:${mine.key}`);
		return { ...both, limits: own.limits };
	}

	/** A visitor holds exactly the app's public policies (rule 38d). `visitor` is an idempotency id, never an identity. */
	visitor(app: string, visitor: string): Authority {
		const audience = (this.m.apps[app] as { audience?: unknown } | undefined)?.audience;
		const policies = typeof audience === 'object' && audience !== null ? (audience as { public: readonly string[] }).public : undefined;
		if (policies === undefined) throw new BoltError('forbidden', 'admission', `app '${app}' has no public audience`);
		return this.compile({ actor: { kind: 'visitor', app, visitor }, admin: false, policies }, `visitor:${app}:${visitor}`);
	}

	/**
	 * A system actor: an automation's `runAs` policies (or, for `'trigger'`, the trigger's own authority), an
	 * integration's declared policies, or a platform run (the workspace's own work). No team; cannot approve.
	 */
	system(run: string, by: { automation: string } | { integration: string } | { platform: string }, trigger?: Authority): Authority {
		const actor: EngineActor = { kind: 'system', run, by };
		if ('platform' in by) return this.compile({ actor, admin: false, platform: true, policies: [] }, `platform:${by.platform}:${run}`);
		if ('integration' in by) {
			const ps = (this.m.integrations[by.integration] as { policies?: readonly string[] } | undefined)?.policies ?? [];
			return this.compile({ actor, admin: false, policies: ps }, `integration:${by.integration}:${run}`);
		}
		const runAs = this.m.automations[by.automation]?.runAs;
		if (runAs === undefined) throw new BoltError('unknownAutomation', 'admission', `no automation '${by.automation}'`);
		if (runAs === 'trigger') {
			if (trigger === undefined) throw new BoltError('noTrigger', 'admission', `'${by.automation}' runs as its trigger, and none was given`);
			return trigger;
		}
		return this.compile({ actor, admin: false, policies: runAs }, `automation:${by.automation}:${run}`);
	}
}

/** Rule 39: admin-only; the Authority becomes the previewed member's (or team's, `{ team }`), administrator flag cleared. */
export async function previewAs(real: Authority, authorities: Authorities, db: TenantDb, target: string | { team: string }): Promise<{ authority: Authority; impersonatedBy: string }> {
	if (!real.admin || real.actor.kind !== 'member') throw new BoltError('forbidden', 'admission', 'Only an administrator can preview as a member or team.');
	const authority = typeof target === 'string' ? await authorities.member(db, target, true) : await authorities.team(db, real.actor, target.team);
	if (authority === null) throw new BoltError('notFound', 'admission', typeof target === 'string' ? 'No active member to preview.' : 'No such team to preview.');
	return { authority, impersonatedBy: real.actor.id };
}

/** The team and every descendant (`actor.teamTree`). */
function closure(graph: readonly TeamRow[], root: string): string[] {
	const out = [root];
	for (let i = 0; i < out.length; i++) for (const t of graph) if (t.parent === out[i] && !out.includes(t.id)) out.push(t.id);
	return out;
}
