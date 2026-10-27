// The shell's host half over HTTP on PGlite (§5.10, §5.11, rules 38a, 38d, 39): sign-in and sign-out, the boot,
// settings as an administrator only, preview-as, the inbox, the PWA manifest, and a visitor applying through the
// public careers page with a Turnstile token, composed by the native workspace host.
import { describe, expect, layer } from '@effect/vitest';
import { Context, Effect, FiberSet, Layer, Result, Schema } from 'effect';
import { decodeManifest } from '../src/engine/manifest.ts';
import { shellApi } from '../src/shell/runtime.ts';
import { actReply, routeFixture } from './support/route-fixture.ts';
import { program } from './support/guest-fixture.ts';
import { founderBootstrap } from '../src/engine/identity/session.ts';
import { Chain, noticeInsert } from '../src/engine/write/sql.ts';
import { HostIdentity } from '../src/shell/host.ts';
import type { StudioOp, StudioPort, StudioState } from '../src/shell/studio/model.ts';
import { StudioInspection, type StudioInspectInput } from '../src/shell/studio/inspection.ts';
import type { AuditRuleSet, StudioAuditRules } from '../src/shell/studio/audit.ts';
import { BoltError } from '../src/protocol/errors.ts';
import type { LogRow } from '../src/engine/contracts.ts';
import type { NoticeInsert } from '../src/engine/notifications/notify.ts';
import { SW } from '../src/protocol/wire.ts';
import { KitInvalid, TestWorkspace, type WorkspaceServices } from '../src/test/index.ts';

const OPEN = '0199a000-0000-4000-8000-00000000000a';
const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en', apps: ['sales'] },
		models: {
			openings: {
				description: 'Roles',
				label: 'title',
				fields: { title: { kind: 'text' }, status: { kind: 'enum', values: ['open', 'closed'] } }
			},
			applications: {
				description: 'Applications',
				label: 'name',
				fields: { name: { kind: 'text' } }
			}
		},
		relationships: { 'applications.opening': { to: 'openings', inverse: 'applications' } },
		exposures: {
			openings: { read: { openings: { fields: 'all' } } },
			applications: {
				read: { applications: { fields: 'all' } },
				create: { columns: { applications: ['opening', 'name'] } }
			}
		},
		integrations: {},
		policies: {
			applicant: {
				description: 'Apply',
				grants: {
					openings: { read: { openings: { where: { status: { eq: 'open' } }, fields: ['title'] } } },
					applications: { create: { check: true } }
				}
			},
			lobby: {
				description: 'Lobby kiosk',
				grants: {
					openings: { read: { openings: { where: { status: { eq: 'open' } }, fields: ['title'] } } },
					applications: {
						create: { columns: { applications: ['opening', 'name'] }, check: true }
					}
				}
			},
			rep: {
				description: 'Rep',
				capabilities: { apps: ['sales'], kiosks: ['desk'] },
				grants: { openings: { read: true } }
			},
			proposer: {
				description: 'Propose an application',
				grants: {
					openings: { read: true },
					applications: { create: { check: true } }
				}
			}
		},
		apps: {
			sales: { title: 'Sales', description: 'd', icon: 'i', pages: { deals: { title: 'Deals' } } },
			careers: {
				title: 'Careers',
				description: 'Jobs',
				icon: 'i',
				audience: { public: ['applicant'], challenge: 'turnstile' },
				pages: { apply: { title: 'Apply' } }
			}
		},
		kiosks: {
			lobby: {
				title: 'Lobby',
				description: 'd',
				icon: 'i',
				auth: 'none',
				policies: ['lobby'],
				pages: { welcome: { title: 'Welcome' } }
			},
			desk: {
				title: 'Desk',
				description: 'd',
				icon: 'i',
				auth: 'members',
				policies: ['lobby'],
				pages: { home: { title: 'Home' } }
			},
			vault: {
				title: 'Vault',
				description: 'd',
				icon: 'i',
				auth: 'members',
				policies: ['lobby'],
				pages: { home: { title: 'Home' } }
			}
		},
		teams: { Sales: ['rep'], Finance: [], Proposer: ['proposer'] },
		automations: {},
		connections: { mail: { integration: 'email' } },
		envoys: {},
		mcp: {},
		customFields: {},
		agent: { internal: 'You help.', skills: {} }
	})
);

// a host's Studio: one workbench head; a save over a stale head is refused
const sources = [
	'src/data/model/openings/+model.ts',
	'src/data/model/applications/+model.ts',
	'src/access_control/policy/+proposer.policy.ts',
	'src/access_control/policy/+applicant.policy.ts',
	'src/access_control/policy/+lobby.policy.ts',
	'src/access_control/policy/+rep.policy.ts',
	'src/app/sales/+app.ts',
	'src/app/careers/+app.ts',
	'src/kiosk/lobby/+kiosk.ts',
	'src/kiosk/desk/+kiosk.ts',
	'src/kiosk/vault/+kiosk.ts'
];
const studioState: StudioState = {
	commit: 'c2',
	files: { 'src/a.ts': { bytes: 1 }, ...Object.fromEntries(sources.map((p) => [p, { bytes: 0 }])) },
	changes: [],
	manifest,
	log: [],
	preview: null,
	releases: [
		{ commit: 'c2', at: '2026-09-25T00:00:00Z', message: 'two', current: true },
		{ commit: 'c1', at: '2026-09-24T00:00:00Z', message: 'one', current: false }
	]
};
const studioOps: StudioOp[] = [];
const inspectionScopes: StudioInspectInput[] = [];
const auditRules: StudioAuditRules = {
	revision: 0,
	ruleSet: { states: {}, ignore: [], rules: [] },
	rules: [],
	errors: [],
	digest: 'd0',
	version: '0.0.1'
};
const auditSaves: { revision: number; ruleSet: AuditRuleSet }[] = [];
// the host's branding port (L-COL-199): what an administrator wrote
const branded: { name: string; logo: string | null }[] = [];
const studio: StudioPort = {
	state: async () => studioState,
	run: async (_auth, op) => {
		if (op.op === 'save' && op.expected !== studioState.commit)
			throw BoltError.make('conflict', 'decode', 'The workbench moved; reload it.');
		studioOps.push(op);
		return studioState;
	},
	file: async (_auth, commit, path) =>
		commit !== studioState.commit
			? null
			: path === 'src/a.ts'
				? { text: 'x' }
				: path in studioState.files
					? { text: '' }
					: null,
	watch: (_auth, send) => {
		send({ kind: 'log', line: { at: 't', level: 'info', message: 'build started' } });
		return () => {};
	},
	usage: async () => ({
		charts: [
			{
				title: 'Memory held',
				unit: 'MiB',
				points: [
					{ at: 0, value: null },
					{ at: 1, value: 512 }
				]
			}
		]
	}),
	inspect: async (_auth, input) => {
		inspectionScopes.push(input);
		return {
			canInspect: true,
			asOf: '2026-10-26T08:00:00.000Z',
			usage: [],
			members: [],
			studio: null,
			logs: [],
			bundles: null,
			cache: null,
			errors: null,
			filters: {
				level: input.level ?? null,
				text: input.text ?? '',
				run: input.run ?? '',
				build: input.build ?? null
			}
		};
	},
	// the host's audit: a save compiles the rule set first and refuses one that does not compile
	audit: {
		rules: async () => auditRules,
		save: async (_auth, revision, ruleSet) => {
			if (ruleSet.rules.some((rule) => rule['id'] === 'Broken'))
				throw BoltError.make('invalid', 'decode', 'Broken: "rule" is required');
			auditSaves.push({ revision, ruleSet });
			return { ...auditRules, revision: revision + 1, ruleSet };
		},
		run: async (_auth, ruleSet) => ({
			commit: 'c2',
			findings: [],
			errors: [],
			digest: ruleSet === undefined ? 'saved' : 'tried',
			version: '0.0.1'
		})
	}
};
const ORIGIN = 'https://acme.example';
type Jar = Map<string, string>;
const jar = (): Jar => new Map();
const cookieOf = (j: Jar) => [...j].map(([k, v]) => `${k}=${v}`).join('; ');
const remember = (j: Jar, res: Response) => {
	for (const c of res.headers.getSetCookie()) {
		if (c.startsWith('__Host-')) {
			expect(c).toContain('; Path=/;');
			expect(c).toContain('; Secure');
			expect(c).toContain('; HttpOnly');
			expect(c).not.toMatch(/;\s*Domain=/i);
		}
		const pair = c.split(';')[0];
		if (pair === undefined) throw new Error('Set-Cookie has no name');
		const eq = pair.indexOf('='),
			k = pair.slice(0, eq),
			v = pair.slice(eq + 1);
		if (eq < 1) throw new Error('Set-Cookie has no value');
		if (/Max-Age=0/.test(c)) j.delete(k);
		else j.set(k, v);
	}
};
const responseJson = (res: Response) =>
	Effect.tryPromise({
		try: () => res.json(),
		catch: (error) => new KitInvalid({ message: String(error) })
	});
const readText = (res: Response) =>
	Effect.tryPromise({
		try: () => res.text(),
		catch: (error) => new KitInvalid({ message: String(error) })
	});
const Reply = Schema.Struct({
	value: Schema.optionalKey(Schema.Unknown),
	outcome: Schema.optionalKey(Schema.Unknown),
	answers: Schema.optionalKey(Schema.Array(Schema.Unknown)),
	error: Schema.optionalKey(
		Schema.Struct({
			code: Schema.String,
			message: Schema.optionalKey(Schema.String),
			workspace: Schema.optionalKey(Schema.Unknown)
		})
	),
	openapi: Schema.optionalKey(Schema.String),
	paths: Schema.optionalKey(Schema.Unknown)
});
const handle = (r: Request) =>
	Effect.flatMap(TestWorkspace, (t) => t.handle(r, { address: '203.0.113.9' }));
const call = (
	j: Jar,
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {}
) =>
	Effect.gen(function* () {
		const cookie = cookieOf(j),
			res = yield* handle(
				new Request(`${ORIGIN}${path}`, {
					method,
					headers: {
						'content-type': 'application/json',
						...(cookie ? { cookie } : {}),
						...headers
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) })
				})
			);
		remember(j, res);
		const text = yield* readText(res);
		return {
			status: res.status,
			body:
				text === '' ? null : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Reply))(text),
			headers: res.headers
		};
	});
const signIn = (email: string) =>
	Effect.gen(function* () {
		const j = jar();
		expect((yield* call(j, 'POST', '/__bolt/session/code', { address: email })).status).toBe(200);
		const v = yield* call(j, 'POST', '/__bolt/session/verify', { address: email, code: '123456' });
		expect(v.status).toBe(200);
		expect(j.has('__Secure-bolt-session')).toBe(true);
		return j;
	});
const api = (j: Jar) =>
	Effect.gen(function* () {
		const t = yield* TestWorkspace,
			run = yield* FiberSet.makeRuntimePromise<never>();
		const fetch: typeof globalThis.fetch = (input, init) => {
			const headers = new Headers(init?.headers);
			headers.set('cookie', cookieOf(j));
			const request = new Request(new URL(String(input), ORIGIN), { ...init, headers });
			return run(t.handle(request, { address: '203.0.113.9' }), { signal: request.signal }).then(
				(res) => {
					remember(j, res);
					return res;
				}
			);
		};
		return shellApi(fetch, { base: ORIGIN });
	});
const boot = (j: Jar, app?: string, kiosk?: string) =>
	Effect.gen(function* () {
		const result = yield* (yield* api(j)).boot(app, kiosk).pipe(Effect.result);
		return result._tag === 'Success'
			? { status: 200, boot: result.success }
			: { status: result.failure.status, boot: null };
	});
const bootValue = (j: Jar, app?: string, kiosk?: string) =>
	boot(j, app, kiosk).pipe(
		Effect.map((reply) => {
			if (reply.boot === null) throw new Error(`boot refused ${reply.status}`);
			return reply.boot;
		})
	);
const workspace = Layer.effectContext(
	Effect.gen(function* () {
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest,
				// applicant and lobby apply to open roles only (one read over the batch); a proposer's application waits for review
				guest: yield* program(`function* toOpen(rows, ctx) {
					const { openings } = yield* ctx.db.query({ openings: { where: { id: { in: rows.map((r) => r.opening) } }, fields: ['status'] } });
					const open = new Set(openings.rows.filter((o) => o.status === 'open').map((o) => o.id));
					const row = rows.findIndex((r) => !open.has(r.opening));
					return row >= 0 ? ctx.deny('That role is closed.', { row, field: 'opening' }) : ctx.allow();
				}
				export default { policy: {
					applicant: { grants: { applications: { create: { check: toOpen } } } },
					lobby: { grants: { applications: { create: { check: toOpen } } } },
					proposer: { grants: { applications: {
						create: { check: function* (rows, ctx) {
							return ctx.approve((flow) => rows.some((r) => r.name === 'Sales proposal')
								? flow.step('Sales review', {teams:['Sales']})
								: flow.step('Finance review', {teams:['Finance']}));
						} }
					} } }
				} };`),
				seed: { openings: [{ id: OPEN, title: 'Engineer', status: 'open' }] },
				host: {
					publicUrl: ORIGIN,
					workspace: () => ({ name: 'Acme', handle: 'acme' }),
					studio,
					ai: false,
					apex: 'https://example.test/pick',
					workspaces: async () => [
						{ handle: 'globex', name: 'Globex', href: 'https://example.test/acme/switch?to=globex' }
					],
					organization: {
						write: async (_auth, b) => {
							branded.push(b);
						}
					}
				}
			})
		);
		yield* founderBootstrap(Context.get(context, HostIdentity), 'boss@acme.example');
		return context;
	})
);

layer(workspace)('shell routes', (it) => {
	describe('shell host (§5.10)', () => {
		let admin: Jar = jar(),
			rep: Jar = jar(),
			repId = '';

		it.effect(
			'signs the founder in with an emailed code; the boot shows every app and the settings',
			() =>
				Effect.gen(function* () {
					const t = yield* TestWorkspace;
					admin = yield* signIn('boss@acme.example');
					expect(t.fakes.sent.at(-1)).toMatchObject({ to: 'boss@acme.example' });
					const { status, boot: b } = yield* boot(admin);
					if (b === null) throw new Error('admin boot refused');
					expect(status).toBe(200);
					expect(b).toMatchObject({
						admin: true,
						name: 'Boss',
						surfaces: { inbox: true, runs: true, settings: true, agent: true, studio: true },
						visitor: null
					});
					expect(b.nav.map((n) => n.name)).toEqual(['sales', 'careers']);
					expect(b.aiUnconfigured).toBe(true); // the host binds no AI: the agent panel says so
					// ui's forms read the caller's exposure from the boot
					expect(b.catalog['applications']).toEqual({
						label: ['name'],
						description: 'Applications',
						fields: { name: { kind: 'text' } },
						relations: { opening: { targets: ['openings'], inverse: 'applications' } },
						create: { columns: ['opening', 'name'] }
					});
					expect((yield* boot(jar())).status).toBe(401);
					expect(b.workspace).toMatchObject({
						name: 'Acme',
						handle: 'acme',
						apex: 'https://example.test/pick',
						organization: true
					});
					expect(b.workspaces).toEqual([
						{ handle: 'globex', name: 'Globex', href: 'https://example.test/acme/switch?to=globex' }
					]);
				})
		);

		it.effect(
			'a signed-out boot names the workspace, its handle and where to change workspace',
			() =>
				Effect.gen(function* () {
					const r = yield* call(jar(), 'GET', '/__bolt/shell');
					expect(r.status).toBe(401);
					expect(r.body?.error?.workspace).toMatchObject({
						name: 'Acme',
						handle: 'acme',
						apex: 'https://example.test/pick'
					});
				})
		);

		it.effect(
			'an act stating a retired schema in Bolt-Contract is refused releaseChanged; the booted one passes (L-BOLT-171)',
			() =>
				Effect.gen(function* () {
					const t = yield* TestWorkspace;
					const b = yield* bootValue(admin);
					expect(b.contract).toMatch(/^[0-9a-f]{64}$/);
					if (b.contract === undefined) throw new Error('boot has no contract');
					const act = (contract: string) =>
						call(
							admin,
							'POST',
							'/__bolt/act',
							{
								callable: 'applications.create',
								input: [{ opening: OPEN, name: 'Ada' }],
								issuedAt: t.clock.now()
							},
							{ 'Idempotency-Key': crypto.randomUUID(), 'Bolt-Contract': contract }
						);
					const stale = yield* act('0'.repeat(64));
					expect(stale.status).toBe(409);
					expect(stale.body?.['outcome']).toMatchObject({
						kind: 'refused',
						code: 'releaseChanged'
					});
					expect((yield* act(b.contract)).body?.['outcome']).toMatchObject({ kind: 'committed' });
				})
		);

		it.effect(
			'serves GET /__bolt/openapi.json: OpenAPI 3.1 of the callables the caller may invoke (L-BOLT-294)',
			() =>
				Effect.gen(function* () {
					const r = yield* call(admin, 'GET', '/__bolt/openapi.json');
					expect(r.status).toBe(200);
					const alternative = Schema.Struct({
						properties: Schema.Struct({ callable: Schema.Struct({ const: Schema.String }) })
					});
					const post = Schema.Struct({
						requestBody: Schema.Struct({
							content: Schema.Struct({
								'application/json': Schema.Struct({
									schema: Schema.Struct({ oneOf: Schema.Array(alternative) })
								})
							})
						})
					});
					const doc = yield* Schema.decodeUnknownEffect(
						Schema.Struct({
							openapi: Schema.String,
							paths: Schema.Struct({ '/__bolt/act': Schema.Struct({ post }) })
						})
					)(r.body);
					expect(doc.openapi).toBe('3.1.0');
					const actPath = doc.paths['/__bolt/act'];
					if (actPath === undefined) throw new Error('OpenAPI has no act path');
					const callables = actPath.post.requestBody.content['application/json'].schema.oneOf.map(
						(o) => o.properties.callable.const
					);
					expect(callables).toContain('applications.create');
					expect(callables).not.toContain('openings.create'); // openings declares no create
					expect((yield* call(jar(), 'GET', '/__bolt/openapi.json')).status).toBe(401);
				})
		);

		it.effect(
			'an administrator invites a member into a team; the invitee signs in and sees only their apps, no settings',
			() =>
				Effect.gen(function* () {
					const teamId = 'Sales';
					expect(
						(yield* call(admin, 'POST', '/__bolt/shell/settings', {
							op: 'invite',
							input: { email: 'rep@acme.example', team: teamId }
						})).status
					).toBe(200);
					expect(
						(yield* call(admin, 'POST', '/__bolt/shell/settings', {
							op: 'invite',
							input: { email: 42 }
						})).body?.error?.code
					).toBe('invalid');
					const s = yield* (yield* api(admin)).settings();
					expect(s.invitations).toMatchObject([{ email: 'rep@acme.example', status: 'open' }]);
					rep = yield* signIn('rep@acme.example');
					const b = yield* bootValue(rep);
					if (b.actor === null || b.actor.kind !== 'member')
						throw new Error('representative boot has no member');
					repId = b.actor.id;
					expect(b).toMatchObject({ admin: false, surfaces: { settings: false, inbox: true } });
					expect(b.nav.map((n) => n.name)).toEqual(['sales']);
					expect(Object.keys(b.catalog).sort()).toEqual(['openings', 'sys_user']); // the kernel directory: member pickers; teams are source
					expect((yield* call(rep, 'GET', '/__bolt/shell/settings')).status).toBe(403);
					expect(
						(yield* call(rep, 'POST', '/__bolt/shell/settings', {
							op: 'setAdmin',
							input: { id: repId, admin: true }
						})).status
					).toBe(403);
				})
		);

		it.effect('preview-as is admin-only and clears the administrator flag (rule 39)', () =>
			Effect.gen(function* () {
				expect((yield* call(rep, 'POST', '/__bolt/shell/preview', { user: repId })).status).toBe(
					403
				);
				expect((yield* call(admin, 'POST', '/__bolt/shell/preview', { user: repId })).status).toBe(
					204
				);
				const b = yield* bootValue(admin);
				expect(b).toMatchObject({
					admin: false,
					preview: { user: repId },
					surfaces: { settings: false }
				});
				expect(b.workspaces).toBeUndefined(); // the switcher never lists the previewed member's workspaces
				expect((yield* call(admin, 'GET', '/__bolt/shell/settings')).status).toBe(403);
				expect((yield* call(admin, 'POST', '/__bolt/shell/preview', { user: null })).status).toBe(
					204
				);
				expect(yield* bootValue(admin)).toMatchObject({ admin: true, preview: null });
			})
		);

		it.effect(
			'the inbox lists requests the viewer may decide and notices addressed to them or their team',
			() =>
				Effect.gen(function* () {
					const t = yield* TestWorkspace;
					const proposer = t.member(['proposer'], { teams: ['Proposer'] }),
						route = yield* routeFixture(yield* Effect.context<TestWorkspace | WorkspaceServices>());
					const salesProposal = (yield* actReply(route, t.as(proposer).authority, {
						callable: 'applications.create',
						input: [{ opening: OPEN, name: 'Sales proposal' }],
						issuedAt: t.clock.now()
					})).outcome;
					const financeProposal = (yield* actReply(route, t.as(proposer).authority, {
						callable: 'applications.create',
						input: [{ opening: OPEN, name: 'Finance proposal' }],
						issuedAt: t.clock.now()
					})).outcome;
					if (
						salesProposal.kind !== 'pendingApproval' ||
						financeProposal.kind !== 'pendingApproval'
					)
						throw new Error('Expected native application proposals.');
					// L-BOLT-354: through the one writer, an inbox notice fans out to one row per member it names (user, team, policy)
					const [memberTeam] = yield* t.db.read([
						{ text: 'SELECT team FROM sys_user WHERE id = $1', params: [repId] }
					]);
					const ownTeam = memberTeam?.rows[0]?.['team'];
					if (typeof ownTeam !== 'string') throw new Error('member team missing');
					const c = new Chain();
					noticeInsert(
						c,
						'n',
						[
							{
								id: 'n1',
								to: [{ user: repId }],
								via: [],
								title: 'To you'
							},
							{
								id: 'n2',
								to: [{ team: ownTeam }],
								via: [],
								title: 'To the team'
							},
							{
								id: 'n3',
								to: [{ team: 'Finance' }],
								via: [],
								title: 'Not you'
							},
							{
								id: 'n4',
								to: [{ user: repId }],
								via: ['mail'],
								title: 'By email'
							},
							{ id: 'n5', to: [{ policy: 'rep' }], via: [], title: 'To the policy' }
						].map((notice): NoticeInsert => ({
							...notice,
							body: null,
							link: null,
							once: notice.id,
							attachments: []
						})),
						t.clock.now(),
						'true',
						t.manifest.teams
					);
					yield* t.db.write(c.sql('1 AS done'));
					expect(
						yield* t.db.rows(
							Schema.Struct({ id: Schema.String, member: Schema.NullOr(Schema.String) }),
							{ text: `SELECT id, member FROM sys_notification ORDER BY id`, params: [] }
						)
					).toEqual([
						{ id: `n1:${repId}`, member: repId },
						{ id: `n2:${repId}`, member: repId },
						{ id: `n4:${repId}`, member: repId },
						{ id: 'n4:mail', member: null },
						{ id: `n5:${repId}`, member: repId }
					]);
					const notices = () =>
						api(rep).pipe(
							Effect.flatMap((host) => host.inbox()),
							Effect.map((inbox) => inbox.notices)
						);
					const box = yield* (yield* api(rep)).inbox();
					expect(box.requests).toEqual([
						expect.objectContaining({ id: salesProposal.requestId, canDecide: true, mine: false })
					]);
					expect(box.notices.map((n) => n.title).sort()).toEqual([
						'By email',
						'To the policy',
						'To the team',
						'To you'
					]);
					expect((yield* bootValue(rep)).inbox).toBe(5);
					// the member marks their own rows read; another member's id is ignored
					const read = (ids: string[], j = rep) =>
						call(
							j,
							'POST',
							'/__bolt/act',
							{ callable: 'sys_notification.markRead', input: { ids }, issuedAt: t.clock.now() },
							{ 'Idempotency-Key': crypto.randomUUID() }
						);
					expect((yield* read([`n1:${repId}`, 'n4:mail'])).body?.['outcome']).toMatchObject({
						kind: 'committed'
					});
					expect((yield* notices()).filter((n) => n.read).map((n) => n.title)).toEqual(['To you']);
					expect((yield* bootValue(rep)).inbox).toBe(4);
					yield* read([`n2:${repId}`], admin);
					expect((yield* notices()).find((n) => n.title === 'To the team')?.read).toBe(false);
					// an administrator may supersede every open request
					expect((yield* (yield* api(admin)).inbox()).requests).toHaveLength(2);
				})
		);

		it.effect('shell boot and inbox report every unread notice beyond the displayed page', () =>
			Effect.gen(function* () {
				const t = yield* TestWorkspace;
				const previous = (yield* call(rep, 'GET', '/__bolt/shell/inbox')).body?.['value'];
				if (
					typeof previous !== 'object' ||
					previous === null ||
					!('unread' in previous) ||
					typeof previous.unread !== 'number'
				)
					throw new Error('no unread count');
				const bootCount = (yield* bootValue(rep)).inbox;
				yield* t.db.write({
					text: `INSERT INTO sys_notification (id, member, recipient, title, at)
			SELECT 'past-' || n, $1, '{}'::jsonb, 'Historical', $2::timestamptz FROM generate_series(1, 250) n`,
					params: [repId, t.clock.now()]
				});
				const response = yield* call(rep, 'GET', '/__bolt/shell/inbox');
				const box = response.body?.['value'];
				expect(box).toMatchObject({ unread: previous.unread + 250, notices: expect.any(Array) });
				if (
					typeof box !== 'object' ||
					box === null ||
					!('notices' in box) ||
					!Array.isArray(box.notices)
				)
					throw new Error('no inbox notices');
				expect(box.notices).toHaveLength(200);
				expect((yield* bootValue(rep)).inbox).toBe(bootCount + 250);
			})
		);

		it.effect(
			'the workspace log pages the host log newest first by cursor, filters, follows the tail, and is admin-only',
			() =>
				Effect.gen(function* () {
					const t = yield* TestWorkspace;
					const at = (i: number) =>
						new Date(Date.parse('2026-09-25T00:00:00Z') + i * 1000).toISOString();
					// the kit host's runtime log, as a host's store holds it
					const log = t.fakes.logs;
					const push = (
						event: Pick<LogRow, 'at' | 'severity' | 'event' | 'invocation' | 'attributes'> &
							Partial<Pick<LogRow, 'run' | 'conversation'>>
					) =>
						log.push({
							run: null,
							conversation: null,
							turn: null,
							...event,
							id: String(log.length + 1)
						});
					log.splice(0);
					for (let i = 0; i < 250; i++)
						push({
							at: at(i),
							severity: i % 50 === 0 ? 'error' : 'info',
							event: i % 50 === 0 ? 'act.failed' : 'act.settled',
							invocation: `i${i}`,
							attributes: { n: i }
						});
					const Log = Schema.Array(
						Schema.Struct({
							id: Schema.String,
							event: Schema.String,
							severity: Schema.String,
							conversation: Schema.optionalKey(Schema.NullOr(Schema.String)),
							attributes: Schema.Struct({
								n: Schema.optionalKey(Schema.Number),
								state: Schema.optionalKey(Schema.Struct({ directive: Schema.String }))
							})
						})
					);
					const logs = (q: string) =>
						call(admin, 'GET', `/__bolt/shell/logs${q}`).pipe(
							Effect.flatMap((reply) => Schema.decodeUnknownEffect(Log)(reply.body?.value))
						);
					const newest = yield* logs('');
					expect(newest).toHaveLength(200);
					expect(newest[0]?.attributes.n).toBe(249);
					const first = newest[0],
						last = newest.at(-1);
					if (first === undefined || last === undefined)
						throw new Error('workspace log page is empty');
					const older = yield* logs(`?before=${last.id}`);
					expect(older.map((r) => r.attributes.n)).toEqual(
						Array.from({ length: 50 }, (_, i) => 49 - i)
					);
					expect((yield* logs('?level=error')).map((r) => r.attributes.n)).toEqual([
						200, 150, 100, 50, 0
					]);
					expect((yield* logs('?q=FAILED&level=error')).length).toBe(5);
					expect(yield* logs(`?after=${first.id}`)).toEqual([]);
					const now = new Date().toISOString();
					push({
						at: now,
						severity: 'warn',
						event: 'act.refused',
						invocation: 'late',
						attributes: { n: 250 }
					});
					expect((yield* logs(`?after=${first.id}`)).map((r) => r.event)).toEqual(['act.refused']);
					// one conversation's events alone (the panel's raw-context tab)
					for (const [invocation, conversation, directive] of [
						['d1', 'c1', 'go'],
						['d2', 'c2', 'stop']
					] as const)
						push({
							at: now,
							severity: 'info',
							event: 'decision.made',
							invocation,
							conversation,
							attributes: { state: { directive } }
						});
					const scoped = yield* logs('?conversation=c1');
					expect(scoped.map((r) => r.conversation)).toEqual(['c1']);
					expect(scoped[0]?.attributes).toMatchObject({ state: { directive: 'go' } });
					// one run's events, an automation's (each event names it) and an at window
					push({
						at: '2026-09-20T10:00:00.000Z',
						severity: 'info',
						event: 'console',
						invocation: 'r-log:1',
						run: 'r-log',
						attributes: { n: 1001, line: 'hello', automation: 'nightly' }
					});
					push({
						at: '2026-09-20T11:00:00.000Z',
						severity: 'warn',
						event: 'facility.failed',
						invocation: 'r-log:1',
						run: 'r-log',
						attributes: { n: 1002, automation: 'nightly' }
					});
					push({
						at: '2026-09-20T12:00:00.000Z',
						severity: 'info',
						event: 'console',
						invocation: 'x:1',
						attributes: { n: 1003, automation: 'nightly' }
					});
					const ns = (q: string) => Effect.map(logs(q), (rows) => rows.map((r) => r.attributes.n));
					expect(yield* ns('?run=r-log')).toEqual([1002, 1001]);
					expect(yield* ns('?automation=nightly')).toEqual([1003, 1002, 1001]);
					expect(yield* ns('?since=2026-09-20T10:30:00Z&until=2026-09-20T12:00:00Z')).toEqual([
						1002
					]);
					expect(yield* ns('?automation=nightly&since=2026-09-20T11:00:00Z')).toEqual([1003, 1002]);
					expect((yield* call(admin, 'GET', '/__bolt/shell/logs?since=soon')).status).toBe(400);
					expect((yield* call(rep, 'GET', '/__bolt/shell/logs')).status).toBe(403);
				})
		);

		it.effect(
			'Studio runs over the host port for staff members; ops are checked at the boundary',
			() =>
				Effect.gen(function* () {
					const rawView = (yield* call(admin, 'GET', '/__bolt/shell/studio')).body?.value;
					const view = yield* Schema.decodeUnknownEffect(
						Schema.Struct({
							sections: Schema.Struct({ apps: Schema.Array(Schema.Unknown) }),
							releases: Schema.Array(Schema.Unknown)
						})
					)(rawView);
					expect(view.sections.apps).toEqual([
						{ name: 'careers', path: 'src/app/careers/+app.ts', href: '/app/careers' },
						{ name: 'sales', path: 'src/app/sales/+app.ts', href: '/app/sales' }
					]);
					expect(rawView).not.toHaveProperty('manifest');
					expect(
						(yield* call(admin, 'POST', '/__bolt/shell/studio', {
							op: { op: 'rollback', commit: 'c1' }
						})).status
					).toBe(200);
					expect(studioOps).toEqual([{ op: 'rollback', commit: 'c1' }]);
					expect(
						(yield* call(admin, 'POST', '/__bolt/shell/studio', {
							op: { op: 'save', expected: 'c2', files: { '../../etc': 'x' } }
						})).status
					).toBe(422);
					const stale = yield* call(admin, 'POST', '/__bolt/shell/studio', {
						op: { op: 'save', expected: 'c1', files: { 'src/a.ts': 'y' } }
					});
					expect([stale.status, stale.body?.error?.code]).toEqual([409, 'conflict']);
					// one file's text at a commit, read on its own: the state carries only the tree's sizes
					expect(
						(yield* call(admin, 'GET', '/__bolt/shell/studio/file?commit=c2&path=src%2Fa.ts')).body
							?.value
					).toEqual({ text: 'x' });
					expect(
						(yield* call(admin, 'GET', '/__bolt/shell/studio/file?commit=c1&path=src%2Fa.ts')).body
							?.value
					).toBeNull();
					expect((yield* call(admin, 'GET', '/__bolt/shell/studio/file?commit=c2')).status).toBe(
						422
					);
					// a staff member who is not an administrator opens Studio too; the host port decides what they may do
					expect((yield* call(rep, 'GET', '/__bolt/shell/studio')).status).toBe(200);
					// the host's metering of this workspace is an administrator's
					expect((yield* call(admin, 'GET', '/__bolt/shell/studio/usage')).body?.value).toEqual({
						charts: [
							{
								title: 'Memory held',
								unit: 'MiB',
								points: [
									{ at: 0, value: null },
									{ at: 1, value: 512 }
								]
							}
						]
					});
					expect((yield* call(rep, 'GET', '/__bolt/shell/studio/usage')).status).toBe(403);
					const inspected = yield* call(
						admin,
						'GET',
						'/__bolt/shell/studio/inspect?range=24h&view=logs&run=run-1&level=warn'
					);
					expect(inspected.status).toBe(200);
					expect(
						(yield* Schema.decodeUnknownEffect(StudioInspection)(inspected.body?.value)).filters
					).toMatchObject({ run: 'run-1', level: 'warn' });
					expect(inspectionScopes.at(-1)).toMatchObject({
						range: '24h',
						view: 'logs',
						run: 'run-1',
						level: 'warn'
					});
					expect(
						(yield* call(rep, 'GET', '/__bolt/shell/studio/inspect?range=7d&view=resources')).status
					).toBe(403);
					expect(
						(yield* call(admin, 'GET', '/__bolt/shell/studio/inspect?range=forever&view=source'))
							.status
					).toBe(422);
					expect(
						(yield* call(
							admin,
							'GET',
							`/__bolt/shell/studio/inspect?range=7d&view=logs&run=${'x'.repeat(201)}`
						)).status
					).toBe(422);
					// the organization's audit rules: read, saved over a revision, tried unsaved; an administrator's
					expect((yield* call(admin, 'GET', '/__bolt/shell/studio/audit')).body?.value).toEqual(
						auditRules
					);
					const relaxed = { states: { UI12: 'hint' }, ignore: [], rules: [] };
					expect(
						(yield* call(admin, 'POST', '/__bolt/shell/studio/audit', {
							revision: 0,
							ruleSet: relaxed
						})).body?.value
					).toMatchObject({ revision: 1, ruleSet: relaxed });
					expect(auditSaves).toEqual([{ revision: 0, ruleSet: relaxed }]);
					const broken = yield* call(admin, 'POST', '/__bolt/shell/studio/audit', {
						revision: 1,
						ruleSet: { ...relaxed, rules: [{ id: 'Broken' }] }
					});
					expect(broken.status).toBe(400);
					expect(broken.body?.error?.message).toBe('Broken: "rule" is required');
					expect(
						(yield* call(admin, 'POST', '/__bolt/shell/studio/audit', {
							revision: 1,
							ruleSet: { states: { UI12: 'loud' }, ignore: [], rules: [] }
						})).status
					).toBe(400);
					expect(
						(yield* call(admin, 'POST', '/__bolt/shell/studio/audit/run', { ruleSet: relaxed }))
							.body?.value
					).toMatchObject({ digest: 'tried' });
					expect(
						(yield* call(admin, 'POST', '/__bolt/shell/studio/audit/run', {})).body?.value
					).toMatchObject({ digest: 'saved' });
					expect((yield* call(rep, 'GET', '/__bolt/shell/studio/audit')).status).toBe(403);
					// an administrator's authoring stream: the host's pushed frames as server-sent events
					const events = yield* handle(
						new Request(`${ORIGIN}/__bolt/shell/studio/events`, {
							headers: { cookie: [...admin].map(([k, v]) => `${k}=${v}`).join('; ') }
						})
					);
					expect(events.headers.get('content-type')).toBe('text/event-stream');
					if (events.body === null) throw new Error('Studio events has no body');
					const reader = events.body.getReader();
					expect(
						new TextDecoder().decode(
							(yield* Effect.tryPromise({
								try: () => reader.read(),
								catch: (error) => new KitInvalid({ message: String(error) })
							})).value
						)
					).toContain('"message":"build started"');
					yield* Effect.tryPromise({
						try: () => reader.cancel(),
						catch: (error) => new KitInvalid({ message: String(error) })
					});
					expect((yield* bootValue(rep)).surfaces.studio).toBe(true);
				})
		);

		it.effect(
			'an administrator edits the branding through the host port; a member cannot, and a malformed body is refused (L-COL-199)',
			() =>
				Effect.gen(function* () {
					const logo = 'data:image/png;base64,iVBORw0KGgo=';
					expect(
						(yield* call(admin, 'POST', '/__bolt/shell/organization', { name: ' Acme Ltd ', logo }))
							.status
					).toBe(200);
					expect(
						(yield* call(admin, 'POST', '/__bolt/shell/organization', { name: 'Acme', logo: null }))
							.status
					).toBe(200);
					expect(branded).toEqual([
						{ name: 'Acme Ltd', logo },
						{ name: 'Acme', logo: null }
					]);
					expect(
						(yield* call(admin, 'POST', '/__bolt/shell/organization', { name: '', logo: null }))
							.status
					).toBe(400);
					expect(
						(yield* call(admin, 'POST', '/__bolt/shell/organization', { name: 'Acme', logo: 7 }))
							.status
					).toBe(400);
					expect(
						(yield* call(rep, 'POST', '/__bolt/shell/organization', { name: 'Rep Co', logo: null }))
							.status
					).toBe(403);
					expect(branded).toHaveLength(2);
				})
		);

		it.effect('serves the PWA manifest from the configured origin, never the Host header', () =>
			Effect.gen(function* () {
				const res = yield* handle(
					new Request('https://evil.example/manifest.webmanifest', {
						headers: { host: 'evil.example' }
					})
				);
				expect(yield* responseJson(res)).toMatchObject({
					id: 'acme',
					name: 'Acme',
					scope: `${ORIGIN}/`,
					start_url: `${ORIGIN}/`
				});
			})
		);

		it.effect('scopes the manifest, cookies and service worker to the workspace path', () =>
			Effect.gen(function* () {
				const under = Context.get(
					yield* Layer.build(
						TestWorkspace.layer({
							manifest,
							host: {
								publicUrl: `${ORIGIN}/acme`,
								workspace: () => ({ name: 'Acme', handle: 'acme' }),
								ai: false
							}
						})
					),
					TestWorkspace
				);
				expect(
					yield* responseJson(yield* under.handle(new Request(`${ORIGIN}/manifest.webmanifest`)))
				).toMatchObject({ scope: `${ORIGIN}/acme/`, start_url: `${ORIGIN}/acme/` });
				expect(
					(yield* under.handle(
						new Request(`${ORIGIN}/__bolt/session/signout`, { method: 'POST' })
					)).headers.get('set-cookie')
				).toContain('; Path=/acme;');
				expect(
					(yield* under.handle(new Request(`${ORIGIN}${SW}`))).headers.get('service-worker-allowed')
				).toBe('/acme/');
			})
		);

		it.effect('signs out: the session row goes and the cookie is cleared', () =>
			Effect.gen(function* () {
				const j = yield* signIn('rep@acme.example');
				expect((yield* call(j, 'POST', '/__bolt/session/signout')).status).toBe(204);
				expect(j.has('__Secure-bolt-session')).toBe(false);
				expect((yield* boot(j)).status).toBe(401);
			})
		);
	});

	describe('visitor pages (§5.10, rule 38d)', () => {
		const V = { 'Bolt-App': 'careers' };

		it.effect(
			'mints the visitor cookie, boots only the public app, and runs every request as its visitor',
			() =>
				Effect.gen(function* () {
					const j = jar();
					const b = yield* bootValue(j, 'careers');
					expect(j.has('__Secure-bolt-visitor')).toBe(true);
					expect(b).toMatchObject({
						actor: { kind: 'visitor', app: 'careers' },
						visitor: { app: 'careers', siteKey: 'dev' },
						surfaces: { inbox: false, agent: false }
					});
					expect(b.catalog['openings']?.fields).toEqual({ title: { kind: 'text' } }); // the grant's fields narrow the exposure
					expect(b.catalog['applications']?.create).toEqual({ columns: ['opening', 'name'] });
					expect(b.nav.map((n) => n.name)).toEqual(['careers']);
					// the root's grant scopes the rows and narrows the fields
					const request = yield* call(
						j,
						'POST',
						'/__bolt/q',
						{ reads: [{ m: 'query', a: [{ openings: { fields: ['title'] } }] }] },
						V
					);
					expect(request.status).toBe(200);
					expect(
						(yield* Schema.decodeUnknownEffect(
							Schema.Struct({
								openings: Schema.Struct({ rows: Schema.Array(Schema.Struct({ title: Schema.String })) })
							})
						)(request.body?.answers?.[0])).openings.rows.map((r) => r.title)
					).toEqual(['Engineer']);
					expect(
						(yield* call(
							j,
							'POST',
							'/__bolt/q',
							{ reads: [{ m: 'query', a: [{ openings: {}, applications: {} }] }] },
							V
						)).status
					).toBe(403);
					expect(
						(yield* call(
							j,
							'POST',
							'/__bolt/q',
							{ reads: [{ m: 'aggregate', a: ['openings', { count: true }] }] },
							V
						)).status
					).toBe(403);
					expect(
						(yield* call(
							j,
							'POST',
							'/__bolt/q',
							{ reads: [{ m: 'query', a: [{ applications: {} }] }] },
							V
						)).status
					).toBe(403);
					expect((yield* call(j, 'GET', '/__bolt/live', undefined, V)).status).toBe(403);
					expect((yield* call(j, 'GET', '/__bolt/shell/inbox', undefined, V)).status).toBe(403);
				})
		);

		it.effect('a signed-in admin on a public page is still the visitor', () =>
			Effect.gen(function* () {
				const admin = yield* signIn('boss@acme.example');
				expect(
					(yield* call(
						admin,
						'POST',
						'/__bolt/q',
						{ reads: [{ m: 'query', a: [{ applications: {} }] }] },
						V
					)).status
				).toBe(403);
			})
		);

		it.effect(
			'applies with a fresh Turnstile token; without one, or with a bad one, the act is refused before decode',
			() =>
				Effect.gen(function* () {
					const t = yield* TestWorkspace;
					const j = jar();
					yield* boot(j, 'careers');
					const apply = (token?: string) =>
						call(
							j,
							'POST',
							'/__bolt/act',
							{
								callable: 'applications.create',
								input: [{ opening: OPEN, name: 'Ada' }],
								issuedAt: t.clock.now()
							},
							{
								...V,
								'Idempotency-Key': crypto.randomUUID(),
								...(token === undefined ? {} : { 'Bolt-Challenge': token })
							}
						);
					expect((yield* apply()).status).toBe(403);
					expect((yield* apply('forged')).status).toBe(403);
					const ok = yield* apply('dev-pass');
					expect(ok.status).toBe(200);
					expect(ok.body?.['outcome']).toMatchObject({ kind: 'committed' });
					expect(
						(yield* call(
							j,
							'POST',
							'/__bolt/act',
							{
								callable: 'openings.update',
								input: [{ target: OPEN, set: {} }],
								issuedAt: t.clock.now()
							},
							{ ...V, 'Idempotency-Key': crypto.randomUUID(), 'Bolt-Challenge': 'dev-pass' }
						)).status
					).toBe(403);
				})
		);
	});

	describe('kiosks (standalone surfaces running as their assigned policies)', () => {
		const K = (kiosk: string) => ({ 'Bolt-Kiosk': kiosk });
		const read = (j: Jar, model: string, headers: Record<string, string> = {}) =>
			call(
				j,
				'POST',
				'/__bolt/q',
				{ reads: [{ m: 'query', a: [{ [model]: {} }] }] },
				headers
			);
		const act = (j: Jar, callable: string, input: unknown, headers: Record<string, string> = {}) =>
			Effect.gen(function* () {
				const t = yield* TestWorkspace;
				return yield* call(
					j,
					'POST',
					'/__bolt/act',
					{ callable, input, issuedAt: t.clock.now() },
					{ 'Idempotency-Key': crypto.randomUUID(), ...headers }
				);
			});

		it.effect(
			'boots a public kiosk without sign-in; members kiosks need sign-in, unknown ones 404',
			() =>
				Effect.gen(function* () {
					const j = jar();
					const { status, boot: b } = yield* boot(j, undefined, 'lobby');
					if (b === null) throw new Error('lobby boot refused');
					expect(status).toBe(200);
					expect(j.has('__Secure-bolt-visitor')).toBe(true);
					expect(b).toMatchObject({
						actor: { kind: 'visitor', app: 'lobby' },
						admin: false,
						visitor: { app: 'lobby' }
					});
					expect(b.catalog['openings']?.fields).toEqual({ title: { kind: 'text' } });
					expect(b.kiosks.map((k) => k.name)).toContain('lobby');
					expect((yield* boot(jar(), undefined, 'desk')).status).toBe(401);
					expect((yield* boot(jar(), undefined, 'nope')).status).toBe(404);
					const rep = yield* signIn('rep@acme.example');
					expect((yield* boot(rep, undefined, 'desk')).status).toBe(200);
					expect((yield* boot(rep, undefined, 'vault')).status).toBe(403);
					expect((yield* boot(rep, undefined, 'nope')).status).toBe(404);
					// the member boot catalog is cut to what the kiosk may read (plus the member directory)
					expect(Object.keys((yield* bootValue(rep, undefined, 'desk')).catalog).sort()).toEqual([
						'applications',
						'openings',
						'sys_user'
					]);
				})
		);

		it.effect(
			'runs every kiosk request as the assigned policies, never the caller — public or admin alike',
			() =>
				Effect.gen(function* () {
					const j = jar();
					yield* boot(j, undefined, 'lobby');
					// no sign-in, no requestor policy: the kiosk policy answers
					const rows = (jj: Jar, headers: Record<string, string>) =>
						read(jj, 'openings', headers).pipe(
							Effect.flatMap((reply) =>
								Schema.decodeUnknownEffect(
									Schema.Struct({
										openings: Schema.Struct({
											rows: Schema.Array(Schema.Record(Schema.String, Schema.Json))
										})
									})
								)(reply.body?.answers?.[0])
							),
							Effect.map((answer) => answer.openings.rows)
						);
					expect((yield* read(jar(), 'openings')).status).toBe(401);
					expect((yield* read(j, 'openings', K('nope'))).status).toBe(403);
					expect(yield* rows(j, K('lobby'))).toEqual([
						expect.objectContaining({ title: 'Engineer' })
					]);
					expect((yield* rows(j, K('lobby')))[0]).toEqual(
						expect.objectContaining({ title: 'Engineer', status: { $masked: true } })
					);
					// the kiosk creates through its own grant, and nothing beyond it
					expect(
						(yield* act(j, 'applications.create', [{ opening: OPEN, name: 'Kay' }], K('lobby')))
							.body?.['outcome']
					).toMatchObject({ kind: 'committed' });
					expect((yield* act(j, 'openings.create', [{ title: 'Nope' }], K('lobby'))).status).toBe(
						403
					);
					// a member's broader grants are replaced inside, not joined — and no admin bypass applies
					const rep = yield* signIn('rep@acme.example');
					const admin = yield* signIn('boss@acme.example');
					expect((yield* rows(rep, {})).map((r) => r['status'])).toEqual(['open']);
					expect((yield* rows(rep, K('desk')))[0]).toEqual(
						expect.objectContaining({ title: 'Engineer', status: { $masked: true } })
					);
					expect((yield* rows(admin, K('desk')))[0]).toEqual(
						expect.objectContaining({ title: 'Engineer', status: { $masked: true } })
					);
					expect((yield* read(rep, 'openings', K('vault'))).status).toBe(403);
				})
		);

		it.effect('a kiosk visitor streams live reads but registers nothing beyond them', () =>
			Effect.gen(function* () {
				const j = jar();
				yield* boot(j, undefined, 'lobby');
				const cookie = [...j].map(([k, v]) => `${k}=${v}`).join('; ');
				const stream = yield* handle(
					new Request(`${ORIGIN}/__bolt/live?kiosk=lobby`, { headers: { cookie } })
				);
				expect(stream.headers.get('content-type')).toBe('text/event-stream');
				if (stream.body === null) throw new Error('live stream has no body');
				const reader = stream.body.getReader();
				expect(
					new TextDecoder().decode(
						(yield* Effect.tryPromise({
							try: () => reader.read(),
							catch: (error) => new KitInvalid({ message: String(error) })
						})).value
					)
				).toContain('"hello"');
				yield* Effect.tryPromise({
					try: () => reader.cancel(),
					catch: (error) => new KitInvalid({ message: String(error) })
				});
				// an app visitor's stream stays shut
				const v = jar();
				yield* boot(v, 'careers');
				expect(
					(yield* call(v, 'GET', '/__bolt/live', undefined, { 'Bolt-App': 'careers' })).status
				).toBe(403);
			})
		);
	});
});
