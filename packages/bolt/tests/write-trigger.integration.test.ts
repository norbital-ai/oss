// An automation listening to a system model's writes: an accepted invitation creates the `sys_user`, and the
// automation runs once after that commit, as the system identity with its policies, with the written ids.
import { expect, layer } from '@effect/vitest';
import { Context, Effect, Layer, Result, Schema } from 'effect';
import { decode_projected_manifest } from '../src/engine/manifest.ts';
import { founder_bootstrap } from '../src/engine/identity/session.ts';
import { HostIdentity } from '../src/engine/services.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';

const manifest = Result.getOrThrow(
	decode_projected_manifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			profiles: {
				description: 'A member profile',
				record_label: 'record.user',
				fields: { user: { kind: 'text' } }
			}
		},
		relationships: {},
		exposures: {
			profiles: {
				outputs: { default: { profiles: { fields: 'all' } } },
				create: { columns: { profiles: ['user'] } }
			}
		},
		integrations: {},
		policies: {
			staff: { description: 'Reads profiles', grants: { profiles: { outputs: { default: {} } } } },
			provisioner: {
				description: 'Creates profiles',
				grants: { profiles: { outputs: { default: {} }, create: {} } }
			}
		},
		apps: {},
		teams: { crew: { name: 'Crew', policies: ['staff'] } },
		automations: {
			provision: {
				description: 'A profile for each new or changed member',
				policies: ['provisioner'],
				on: [{ model: 'sys_user', verbs: ['create'] }]
			}
		},
		mcp: {},
		custom_fields: {},
		agent: { skills: {} }
	})
);

const ORIGIN = 'https://acme.example';
type Jar = Map<string, string>;
const call = (j: Jar, path: string, body: unknown, headers: Record<string, string> = {}) =>
	Effect.gen(function* () {
		const t = yield* TestWorkspace;
		const cookie = [...j].map(([k, v]) => `${k}=${v}`).join('; ');
		const res = yield* t.handle(
			new Request(`${ORIGIN}${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...headers, ...(cookie ? { cookie } : {}) },
				body: JSON.stringify(body)
			}),
			{ address: '203.0.113.9' }
		);
		for (const c of res.headers.getSetCookie()) {
			const pair = c.split(';')[0] ?? '';
			const eq = pair.indexOf('=');
			if (eq > 0) j.set(pair.slice(0, eq), pair.slice(eq + 1));
		}
		return res.status;
	});
const signIn = (email: string) =>
	Effect.gen(function* () {
		const j: Jar = new Map();
		yield* call(j, '/__bolt/session/code', { address: email });
		expect(yield* call(j, '/__bolt/session/verify', { address: email, code: '123456' })).toBe(200);
		return j;
	});

const guest = program(`export default { automation: { provision: { body: function* (_, ctx) {
	const t = ctx.run.trigger;
	yield* ctx.act({ 'profiles.create': t.records.map((user) => ({ user: t.cause + ':' + t.model + ':' + t.verb + ':' + user })) });
} } } };`);

const workspace = Layer.effectContext(
	Effect.gen(function* () {
		const context = yield* Layer.build(
			TestWorkspace.layer({ manifest, guest: yield* guest, host: { public_url: ORIGIN } })
		);
		yield* founder_bootstrap(Context.get(context, HostIdentity), 'boss@acme.example');
		return context;
	})
);

layer(workspace)('write triggers', (it) => {
	it.effect('an accepted invitation runs the sys_user listener once, under its own policies', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const ids = (sql: string) =>
				t.db.value(Schema.Array(Schema.String), { text: sql, params: [] });
			const admin = yield* signIn('boss@acme.example');
			const boss = yield* t.db.value(Schema.String, {
				text: `SELECT id FROM sys_user WHERE email = 'boss@acme.example'`,
				params: []
			});
			yield* t.run_due();
			expect(yield* call(admin, '/__bolt/shell/settings', { op: 'invite', input: { email: 'rep@acme.example', team: 'crew' } })).toBe(200);
			const repJar = yield* signIn('rep@acme.example');
			const rep = yield* t.db.value(Schema.String, {
				text: `SELECT id FROM sys_user WHERE email = 'rep@acme.example'`,
				params: []
			});
			yield* t.run_due();
			// no cron: the founder's and the invitee's creates each queued one run in their own statement
			expect(
				yield* ids(`SELECT coalesce(array_agg(trigger->>'cause' || ':' || state ORDER BY due_at, id), '{}') FROM sys_run WHERE automation = 'provision'`)
			).toEqual(['event:succeeded', 'event:succeeded']);
			expect(yield* ids('SELECT coalesce(array_agg("user" ORDER BY "user"), \'{}\') FROM profiles')).toEqual(
				[`event:sys_user:create:${boss}`, `event:sys_user:create:${rep}`].sort()
			);
			// the accepting member could not have written it
			expect(
				yield* call(repJar, '/__bolt/act', { acts: { 'profiles.create': [{ user: 'self' }] }, issued_at: t.clock.now() }, {
					'Idempotency-Key': crypto.randomUUID()
				})
			).toBe(403);
		})
	);
});
