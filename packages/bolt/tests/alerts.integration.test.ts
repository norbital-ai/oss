// Local workspace Command Center alerts: admin-only routes, settings persistence, test delivery,
// automation/integration failure alerts, AI monthly budget threshold alerts, and per-key repeat cooldowns.
import { expect, layer } from '@effect/vitest';
import { Context, Effect, FiberSet, Layer, Result, Schema } from 'effect';
import { decode_projected_manifest } from '../src/engine/manifest.ts';
import { shell_api } from '../src/shell/runtime.ts';
import { founder_bootstrap } from '../src/engine/identity/session.ts';
import { HostIdentity } from '../src/engine/services.ts';
import { Transport } from '../src/engine/ports.ts';
import { WorkspaceAlertsService } from '../src/engine/alerts.ts';
import { recordSpend, saveAgentSettings, SYSTEM_AGENTS } from '../src/engine/agent/settings.ts';
import { KitInvalid, TestWorkspace } from '../../bolt-cli/src/test/index.ts';

const manifest = Result.getOrThrow(
	decode_projected_manifest({
		workspace: { tz: 'UTC', locale: 'en', apps: ['ops'] },
		models: {
			tasks: {
				description: 'Tasks',
				record_label: 'record.title',
				fields: { title: { kind: 'text' } }
			}
		},
		relationships: {},
		exposures: { tasks: { outputs: { default: { tasks: { fields: 'all' } } } } },
		integrations: {},
		policies: {
			staff: {
				description: 'Staff',
				capabilities: { apps: ['ops'] },
				grants: { tasks: { outputs: { default: {} } } }
			}
		},
		apps: {
			ops: { title: 'Ops', description: 'Ops', icon: 'i', pages: { home: { title: 'Home' } } }
		},
		automations: {
			nightly_sync: {
				description: 'Nightly sync job',
				policies: ['staff']
			}
		},
		mcp: {},
		custom_fields: {},
		agent: { skills: {} }
	})
);

const ORIGIN = 'https://acme.example';
const sentMails: Array<{ to: string; subject: string; text: string }> = [];

type Jar = Map<string, string>;
const cookieOf = (j: Jar) => [...j].map(([k, v]) => `${k}=${v}`).join('; ');
const readText = (res: Response) =>
	Effect.tryPromise({
		try: () => res.text(),
		catch: (error) => new KitInvalid({ message: String(error) })
	});
const call = (j: Jar, method: string, path: string, body?: unknown) =>
	Effect.gen(function* () {
		const t = yield* TestWorkspace;
		const cookie = cookieOf(j);
		const res = yield* t.handle(
			new Request(`${ORIGIN}${path}`, {
				method,
				headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
				...(body === undefined ? {} : { body: JSON.stringify(body) })
			}),
			{ address: '203.0.113.10' }
		);
		for (const c of res.headers.getSetCookie()) {
			const pair = c.split(';')[0];
			if (pair === undefined) continue;
			const eq = pair.indexOf('=');
			if (eq < 1) continue;
			const k = pair.slice(0, eq),
				v = pair.slice(eq + 1);
			if (/Max-Age=0/.test(c)) j.delete(k);
			else j.set(k, v);
		}
		return { status: res.status, text: yield* readText(res) };
	});

const signIn = (email: string) =>
	Effect.gen(function* () {
		const j: Jar = new Map();
		yield* call(j, 'POST', '/__bolt/session/code', { address: email });
		const verified = yield* call(j, 'POST', '/__bolt/session/verify', {
			address: email,
			code: '123456'
		});
		expect(verified.status).toBe(200);
		return j;
	});

const apiFor = (j: Jar) =>
	Effect.gen(function* () {
		const t = yield* TestWorkspace,
			run = yield* FiberSet.makeRuntimePromise<never>();
		const fetch: typeof globalThis.fetch = (input, init) => {
			const request = new Request(
				input instanceof Request ? input : new URL(String(input), ORIGIN),
				init
			);
			request.headers.set('cookie', cookieOf(j));
			return run(t.handle(request, { address: '203.0.113.10' }), { signal: request.signal });
		};
		return shell_api(fetch, { base: ORIGIN });
	});

const workspace = Layer.effectContext(
	Effect.gen(function* () {
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest,
				now: '2026-11-28T12:00:00Z',
				ports: Layer.succeed(Transport, {
					send: (message) =>
						Effect.sync(() => {
							if (message._tag === 'Mail') {
								sentMails.push({
									to: message.to,
									subject: message.subject,
									text: message.text
								});
							}
							return { provider_id: `mail-${sentMails.length}` };
						})
				}),
				host: {
					public_url: ORIGIN,
					workspace: () => ({ name: 'Acme Workspace', handle: 'acme' })
				}
			})
		);
		yield* founder_bootstrap(Context.get(context, HostIdentity), 'boss@acme.com');
		return context;
	})
);

layer(workspace, { excludeTestServices: true })('local workspace command center alerts', (it) => {
	let adminJar: Jar = new Map();
	let staffJar: Jar = new Map();

	it.effect('enforces admin-only access, validates settings, persists config, and delivers test alerts', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			adminJar = yield* signIn('boss@acme.com');
			const adminApi = yield* apiFor(adminJar);

			// Create a non-admin staff user and verify they cannot read or mutate alerts
			yield* t.db.write({
				text: `INSERT INTO sys_user (id, email, name, kind, active, admin)
					VALUES ('u-staff', 'staff@acme.com', 'Staff', 'staff', true, false)`,
				params: []
			});
			staffJar = yield* signIn('staff@acme.com');
			const denied = yield* call(staffJar, 'GET', '/__bolt/shell/alerts');
			expect(denied.status).toBe(403);

			// Initial default state
			const initial = yield* adminApi.alerts();
			expect(initial.settings).toEqual({
				enabled: false,
				emails: [],
				notify_admins: true,
				cooldown_minutes: 60,
				automation_failed: true,
				integration_failed: true,
				ai_spend_threshold_pct: 80
			});
			expect(initial.admin_emails).toEqual(['boss@acme.com']);

			// Invalid recipient email or enabling without triggers is refused
			const invalid = yield* adminApi
				.save_alerts({
					...initial.settings,
					enabled: true,
					emails: ['not-an-email']
				})
				.pipe(Effect.flip);
			expect(invalid.status).toBe(400);

			const noTriggers = yield* adminApi
				.save_alerts({
					...initial.settings,
					enabled: true,
					automation_failed: false,
					integration_failed: false,
					ai_spend_threshold_pct: null
				})
				.pipe(Effect.flip);
			expect(noTriggers.status).toBe(400);

			// Save enabled settings with explicit email recipient
			const saved = yield* adminApi.save_alerts({
				enabled: true,
				emails: ['ops@acme.com'],
				notify_admins: true,
				cooldown_minutes: 30,
				automation_failed: true,
				integration_failed: true,
				ai_spend_threshold_pct: 80
			});
			expect(saved.enabled).toBe(true);
			expect(saved.emails).toEqual(['ops@acme.com']);
			expect(saved.cooldown_minutes).toBe(30);

			// Send test alert -> emails ops@acme.com + inserts admin inbox notice + records history
			sentMails.length = 0;
			const tested = yield* adminApi.test_alert();
			expect(tested).toEqual({ sent: true, emailed: ['ops@acme.com'], inbox: 1 });
			expect(sentMails).toHaveLength(1);
			expect(sentMails[0]?.to).toBe('ops@acme.com');
			expect(sentMails[0]?.subject).toContain('Test workspace alert');

			const notices = yield* t.db.rows(Schema.Struct({ title: Schema.String }), {
				text: `SELECT title FROM sys_notification WHERE id LIKE 'alert:%'`,
				params: []
			});
			expect(notices).toHaveLength(1);
			expect(notices[0]?.title).toBe('Test workspace alert');

			const after = yield* adminApi.alerts();
			expect(after.history).toHaveLength(1);
			expect(after.history[0]?.kind).toBe('test');
		})
	);

	it.effect('triggers automation, integration, and AI spend threshold alerts with per-key cooldown', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const alerts = yield* WorkspaceAlertsService;
			const adminApi = yield* apiFor(adminJar);

			sentMails.length = 0;

			// 1. Automation failure alerts once, then respects 30m cooldown, then alerts again after 30m
			yield* alerts.automationFailed({
				automation: 'nightly_sync',
				runId: 'run-1',
				message: 'Upstream 500'
			});
			expect(sentMails).toHaveLength(1);
			expect(sentMails[0]?.subject).toContain('Automation failed: nightly_sync');
			expect(sentMails[0]?.text).toContain('Upstream 500');

			t.clock.advance('10min');
			yield* alerts.automationFailed({
				automation: 'nightly_sync',
				runId: 'run-2',
				message: 'Still failing'
			});
			expect(sentMails).toHaveLength(1);

			t.clock.advance('25min');
			yield* alerts.automationFailed({
				automation: 'nightly_sync',
				runId: 'run-3',
				message: 'Still failing after cooldown'
			});
			expect(sentMails).toHaveLength(2);

			// 2. Integration failure alert uses its own key independent of automation cooldown
			yield* alerts.integrationFailed({
				source: 'erp.sync',
				key: 'sync:read:erp:inst-1',
				detail: 'Connection refused'
			});
			expect(sentMails).toHaveLength(3);
			expect(sentMails[2]?.subject).toContain('Integration failure: erp.sync');

			// 3. Monthly AI spend threshold (80% of USD 10.00 = USD 8.00)
			yield* saveAgentSettings(t.db, {
				monthly: 10,
				member: null,
				policies: {},
				models: [],
				system1: null,
				system2: null,
				system: SYSTEM_AGENTS
			});
			yield* recordSpend(t.db, 5);
			yield* alerts.checkAiSpend;
			expect(sentMails).toHaveLength(3); // 50% < 80%

			yield* recordSpend(t.db, 3.5); // 85% >= 80%
			yield* alerts.checkAiSpend;
			expect(sentMails).toHaveLength(4);
			expect(sentMails[3]?.subject).toContain('Workspace AI spend crossed 80%');

			// Reaching 100% uses distinct ai_limit key and alerts immediately
			yield* recordSpend(t.db, 2); // 105% >= 100%
			yield* alerts.checkAiSpend;
			expect(sentMails).toHaveLength(5);
			expect(sentMails[4]?.subject).toContain('Workspace AI monthly budget reached');

			const state = yield* adminApi.alerts();
			expect(state.ai_monthly_cap).toBe(10);
			expect(state.ai_monthly_spent).toBeGreaterThanOrEqual(10);
			expect(state.history.length).toBeGreaterThanOrEqual(5);
		})
	);
});
