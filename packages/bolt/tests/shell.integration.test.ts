// The shell's host half over HTTP on PGlite (§5.10, §5.11, rules 38a, 38d, 39): sign-in and sign-out, the boot,
// settings as an administrator only, preview-as, the PWA manifest, and a visitor applying through the
// public careers page with a Turnstile token, composed by the native workspace host.
import { describe, expect, it, layer } from '@effect/vitest';
import { Context, Effect, FiberSet, Layer, Result, Schema } from 'effect';
import { decodeProjectedManifest } from '../src/engine/manifest.ts';
import { shellApi } from '../src/shell/runtime.ts';
import { program } from '../src/test/guest.ts';
import { founderBootstrap } from '../src/engine/identity/session.ts';
import { HostIdentity } from '../src/shell/host.ts';
import type { StudioOp, StudioPort, StudioState } from '../src/shell/studio/model.ts';
import type { StudioInspectInput } from '../src/shell/studio/inspection.ts';
import type { AuditRuleSet, StudioAuditRules } from '../src/shell/studio/audit.ts';
import { BoltError } from '../src/protocol/errors.ts';
import { HEADERS, PATHS } from '../src/protocol/wire.ts';
import { SHELL } from '../src/shell/nav.ts';
import { KitInvalid, TestWorkspace } from '../src/test/index.ts';

const OPEN = '0199a000-0000-4000-8000-00000000000a';
const manifest = Result.getOrThrow(
	decodeProjectedManifest({
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
					openings: {
						read: { openings: { where: { status: { eq: 'open' } }, fields: ['title'] } }
					},
					applications: { create: { check: true } }
				}
			},
			lobby: {
				description: 'Lobby kiosk',
				grants: {
					openings: {
						read: { openings: { where: { status: { eq: 'open' } }, fields: ['title'] } }
					},
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
	// one founder and one member session for the file: every test below reuses them
	let admin: Jar = jar(),
		rep: Jar = jar(),
		repId = '';
	describe('shell host (§5.10)', () => {

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
					expect(b).toMatchObject({
						admin: false,
						surfaces: { settings: false, inbox: true, studio: true }
					});
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

		it.effect('the workspace log reads the host log through its query; admin-only; a malformed bound is refused', () =>
			Effect.gen(function* () {
				const t = yield* TestWorkspace;
				t.fakes.logs.splice(0);
				for (const [i, severity] of (['info', 'error'] as const).entries())
					t.fakes.logs.push({
						id: String(i + 1),
						at: `2026-09-25T00:00:0${i}.000Z`,
						severity,
						event: 'act.settled',
						invocation: `i${i}`,
						run: null,
						conversation: null,
						turn: null,
						attributes: { n: i }
					});
				const ns = (q: string) =>
					call(admin, 'GET', `/__bolt/shell/logs${q}`).pipe(
						Effect.flatMap((reply) =>
							Schema.decodeUnknownEffect(
								Schema.Array(Schema.Struct({ attributes: Schema.Struct({ n: Schema.Number }) }))
							)(reply.body?.value)
						),
						Effect.map((rows) => rows.map((r) => r.attributes.n))
					);
				expect(yield* ns('')).toEqual([1, 0]);
				expect(yield* ns('?level=error')).toEqual([1]);
				expect((yield* call(admin, 'GET', '/__bolt/shell/logs?since=soon')).status).toBe(400);
				expect((yield* call(rep, 'GET', '/__bolt/shell/logs')).status).toBe(403);
			})
		);

		it.effect('Studio runs over the host port for staff members; ops are checked at the boundary', () =>
			Effect.gen(function* () {
				expect(
					(yield* call(admin, 'POST', '/__bolt/shell/studio', { op: { op: 'rollback', commit: 'c1' } }))
						.status
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
				// a staff member opens Studio too; the host's metering is an administrator's
				expect((yield* call(rep, 'GET', '/__bolt/shell/studio')).status).toBe(200);
				expect((yield* call(rep, 'GET', '/__bolt/shell/studio/usage')).status).toBe(403);
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
								openings: Schema.Struct({
									rows: Schema.Array(Schema.Struct({ title: Schema.String }))
								})
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
			call(j, 'POST', '/__bolt/q', { reads: [{ m: 'query', a: [{ [model]: {} }] }] }, headers);
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
					expect((yield* boot(rep, undefined, 'vault')).status).toBe(403);
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

		it.effect('signs out: the session row goes and the cookie is cleared', () =>
			Effect.gen(function* () {
				expect((yield* call(rep, 'POST', '/__bolt/session/signout')).status).toBe(204);
				expect(rep.has('__Secure-bolt-session')).toBe(false);
				expect((yield* boot(rep)).status).toBe(401);
			})
		);
	});
});

it.effect(
	'shellApi.act states the contract the shell booted against in Bolt-Contract (L-BOLT-171)',
	() =>
		Effect.gen(function* () {
			const stated: (string | null)[] = [];
			const fetch: typeof globalThis.fetch = async (input, init) => {
				const request = new Request(
					input instanceof Request ? input : new URL(String(input), ORIGIN),
					init
				);
				const path = new URL(request.url).pathname;
				if (path === SHELL) return Response.json({ value: { contract: 'booted' } });
				if (path === PATHS.act) stated.push(request.headers.get(HEADERS.contract));
				return Response.json({ outcome: { kind: 'committed', output: null, records: [] }, v: 0 });
			};
			const api = shellApi(fetch, { base: ORIGIN });
			yield* api.boot();
			expect(yield* api.markAllNoticesRead()).toMatchObject({ kind: 'committed' });
			expect(stated).toEqual(['booted']);
		})
);
