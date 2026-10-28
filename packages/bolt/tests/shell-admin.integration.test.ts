// The shell host's administration surface over HTTP on PGlite: the environment badge and host notice in the boot,
// `access.explain`, member handles, invitation resend, API keys and team membership.
import { expect, layer } from '@effect/vitest';
import { Context, Effect, FiberSet, Layer, Result, Schema } from 'effect';
import { decodeProjectedManifest } from '../src/engine/manifest.ts';
import { shellApi } from '../src/shell/runtime.ts';
import { founderBootstrap } from '../src/engine/identity/session.ts';
import { HostIdentity } from '../src/shell/host.ts';
import { KitInvalid, TestWorkspace } from '../src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeProjectedManifest({
		workspace: { tz: 'UTC', locale: 'en', apps: ['sales'] },
		models: {
			openings: { description: 'Roles', label: 'title', fields: { title: { kind: 'text' } } }
		},
		relationships: {},
		exposures: { openings: { read: { openings: { fields: 'all' } } } },
		integrations: {},
		policies: {
			rep: {
				description: 'Rep',
				capabilities: { apps: ['sales'] },
				grants: { openings: { read: true } }
			}
		},
		apps: {
			sales: { title: 'Sales', description: 'd', icon: 'i', pages: { deals: { title: 'Deals' } } }
		},
		teams: { sales: { name: 'Sales', policies: ['rep'] } },
		automations: {},
		connections: {},
		envoys: {
			service: {
				name: 'Source desk',
				audience: 'private',
				policies: ['rep'],
				task: 'Answer about openings.'
			}
		},
		mcp: {},
		customFields: {},
		agent: { skills: {} }
	})
);

const ORIGIN = 'https://acme.example';
type Jar = Map<string, string>;
const cookieOf = (j: Jar) => [...j].map(([k, v]) => `${k}=${v}`).join('; ');
const readText = (res: Response) =>
	Effect.tryPromise({
		try: () => res.text(),
		catch: (error) => new KitInvalid({ message: String(error) })
	});
const Reply = Schema.Struct({
	value: Schema.optionalKey(Schema.Unknown),
	error: Schema.optionalKey(Schema.Struct({ code: Schema.String }))
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
			{ address: '203.0.113.9' }
		);
		for (const c of res.headers.getSetCookie()) {
			const pair = c.split(';')[0];
			if (pair === undefined) throw new Error('Set-Cookie has no name');
			const eq = pair.indexOf('='),
				k = pair.slice(0, eq),
				v = pair.slice(eq + 1);
			if (eq < 1) throw new Error('Set-Cookie has no value');
			if (/Max-Age=0/.test(c)) j.delete(k);
			else j.set(k, v);
		}
		const text = yield* readText(res);
		return {
			status: res.status,
			body:
				text === '' ? null : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Reply))(text)
		};
	});
const signIn = (email: string) =>
	Effect.gen(function* () {
		const j: Jar = new Map();
		yield* call(j, 'POST', '/__bolt/session/code', { address: email });
		expect(
			(yield* call(j, 'POST', '/__bolt/session/verify', { address: email, code: '123456' })).status
		).toBe(200);
		return j;
	});
const op = (j: Jar, name: string, input: unknown) =>
	call(j, 'POST', '/__bolt/shell/settings', { op: name, input });
const api = (j: Jar) =>
	Effect.gen(function* () {
		const t = yield* TestWorkspace,
			run = yield* FiberSet.makeRuntimePromise<never>();
		const fetch: typeof globalThis.fetch = (input, init) => {
			const request = new Request(
				input instanceof Request ? input : new URL(String(input), ORIGIN),
				init
			);
			request.headers.set('cookie', cookieOf(j));
			return run(t.handle(request, { address: '203.0.113.9' }), { signal: request.signal });
		};
		return shellApi(fetch, { base: ORIGIN });
	});
const settings = (j: Jar) => api(j).pipe(Effect.flatMap((host) => host.settings()));
const boot = (j: Jar) => api(j).pipe(Effect.flatMap((host) => host.boot()));
const workspace = Layer.effectContext(
	Effect.gen(function* () {
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest,
				host: {
					publicUrl: ORIGIN,
					workspace: () => ({ name: 'Acme', handle: 'acme' }),
					environment: 'staging',
					notice: async (a) =>
						a.admin
							? {
									text: 'Your trial ends in 3 days.',
									tone: 'warning',
									href: '/billing',
									action: 'Upgrade'
								}
							: null
				}
			})
		);
		yield* founderBootstrap(Context.get(context, HostIdentity), 'boss@acme.example');
		return context;
	})
);

layer(workspace)('shell administration', (it) => {
	let admin: Jar = new Map(),
		rep: Jar = new Map(),
		repId = '';
	const teamId = 'sales';

	it.effect('the boot carries the environment badge and the host notice for whom it applies', () =>
		Effect.gen(function* () {
			admin = yield* signIn('boss@acme.example');
			const b = yield* boot(admin);
			expect(b.workspace.environment).toBe('staging');
			expect(b.notice).toEqual({
				text: 'Your trial ends in 3 days.',
				tone: 'warning',
				href: '/billing',
				action: 'Upgrade'
			});
			yield* op(admin, 'invite', { email: 'rep@acme.example', team: teamId });
			rep = yield* signIn('rep@acme.example');
			expect((yield* boot(rep)).notice).toBeUndefined();
		})
	);

	it.effect(
		'explain answers the caller’s own grants; another member’s or team’s only for an administrator',
		() =>
			Effect.gen(function* () {
				const own = yield* Schema.decodeUnknownEffect(
					Schema.Struct({
						policies: Schema.Array(Schema.String),
						admin: Schema.Boolean,
						models: Schema.Record(Schema.String, Schema.Unknown),
						capabilities: Schema.Unknown,
						key: Schema.optionalKey(Schema.String)
					})
				)((yield* call(rep, 'GET', '/__bolt/shell/explain')).body?.value);
				expect(own).toMatchObject({
					policies: ['rep'],
					admin: false,
					capabilities: { apps: ['sales'] }
				});
				expect(own.models).toHaveProperty('openings');
				expect(own.key).toBeUndefined();
				expect((yield* call(rep, 'GET', `/__bolt/shell/explain?team=${teamId}`)).status).toBe(403);
				expect(
					(yield* call(admin, 'GET', `/__bolt/shell/explain?team=${teamId}`)).body?.value
				).toMatchObject({ policies: ['rep'], admin: false });
				expect((yield* call(admin, 'GET', '/__bolt/shell/explain?team=nope')).status).toBe(404);
			})
	);

	it.effect(
		"an administrator sets a member's mobile number (international form) and Telegram handle; audited; nobody else may",
		() =>
			Effect.gen(function* () {
				const id = (yield* settings(admin)).members.find(
					(u) => u['email'] === 'rep@acme.example'
				)?.['id'];
				if (typeof id !== 'string') throw new Error('representative member missing');
				repId = id;
				expect((yield* op(rep, 'setHandles', { id, phone: '+6581234567' })).status).toBe(403);
				expect((yield* op(admin, 'setHandles', { id, phone: '81234567' })).body?.error?.code).toBe(
					'check'
				);
				expect(
					(yield* op(admin, 'setHandles', { id, phone: '+65 8123 4567', telegram: '@Rep_Tg' }))
						.status
				).toBe(200);
				const s = yield* settings(admin);
				expect(s.members.find((u) => u['id'] === id)).toMatchObject({
					phone: '+6581234567',
					telegram: 'Rep_Tg'
				});
				expect(s.audit).toContainEqual(
					expect.objectContaining({ model: 'sys_user', record: id, op: 'update' })
				);
				const boss = s.members.find((u) => u['email'] === 'boss@acme.example')?.['id'];
				if (typeof boss !== 'string') throw new Error('founder member missing');
				expect(
					(yield* op(admin, 'setHandles', { id: boss, phone: '+6581234567' })).body?.error?.code
				).toBe('check'); // another member's number
				expect((yield* op(admin, 'setHandles', { id, telegram: null })).status).toBe(200); // a key left out keeps its value
				expect((yield* settings(admin)).members.find((u) => u['id'] === id)).toMatchObject({
					phone: '+6581234567',
					telegram: null
				});
			})
	);

	it.effect('an invitation resends to its address', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const inv = yield* op(admin, 'invite', { email: 'later@acme.example' });
			const invId = (yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
				inv.body?.value
			)).id;
			const sent = t.fakes.sent.length;
			expect((yield* op(admin, 'resendInvitation', { id: invId })).status).toBe(200);
			expect(t.fakes.sent.slice(sent)).toMatchObject([{ to: 'later@acme.example' }]);
		})
	);

	it.effect('an API key selects a source team and rejects undeclared choices', () =>
		Effect.gen(function* () {
			expect(
				(yield* op(admin, 'issueKey', { name: 'Bad', team: 'undeclared' })).body?.error?.code
			).toBe('notFound');
			expect(
				(yield* op(admin, 'issueKey', { name: 'Forged', policies: ['rep'] })).body?.error?.code
			).toBe('invalid');
			expect((yield* op(admin, 'issueKey', { name: 'CI', team: teamId })).status).toBe(200);
			expect((yield* settings(admin)).keys).toContainEqual(
				expect.objectContaining({ name: 'CI', team: teamId })
			);
		})
	);

	it.effect(
		'administrators change member membership only among authored teams; access follows the current source assignment',
		() =>
			Effect.gen(function* () {
				const id = repId;
				expect((yield* op(rep, 'assignTeam', { id, team: null })).status).toBe(403);
				expect((yield* op(admin, 'assignTeam', { id, team: 'undeclared' })).body?.error?.code).toBe(
					'notFound'
				);
				expect((yield* op(admin, 'assignTeam', { id, team: null })).status).toBe(200);
				expect((yield* boot(rep)).nav).toEqual([]);
				expect((yield* op(admin, 'assignTeam', { id, team: teamId })).status).toBe(200);
				expect((yield* boot(rep)).nav.map((node) => node.name)).toEqual(['sales']);
			})
	);
});
