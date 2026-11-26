// A host's branch reads and operations on PGlite: this release's schema keeps the Host API's recovery storage contract,
// and an operator's instance operations (`WorkspaceBranch.integrations`) answer status, configure fenced by its revision
// and the envoy rules, and restore credentials pausing the instance first, rotating its epoch, keeping it paused when
// interrupted or fenced, and naming no value. Each committed change is published on its branch's epoch, as a generation
// publishes its own commits.
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { randomBytes } from 'node:crypto';
import { Context, Deferred, Effect, Fiber, Layer, Option, Redacted, Schema } from 'effect';
import { branch_storage, Fenced } from '@norbital-ai/host-api';
import { credentials, type Credentials } from '../src/engine/integrations/credentials.ts';
import {
	type BranchPublication,
	configure_instance,
	instance_admin,
	restore_instance
} from '../src/engine/integrations/instances.ts';
import type { Captured } from '../src/engine/db/captured.ts';
import { Secrets } from '../src/engine/secrets.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { TestWorkspace, type Kit } from '../../bolt-cli/src/test/index.ts';
import { describe, expect, layer } from '../../bolt-cli/src/test/effect.ts';
import { seed_accounts } from './support/accounts.ts';
import { seed_envoys } from './support/envoys.ts';

const DESK = '0c000000-0000-4000-8000-000000000001',
	RETIRED = '0c000000-0000-4000-8000-000000000002';
const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {},
	relationships: {},
	exposures: {},
	integrations: {
		erp: {
			description: 'The ERP',
			driver: 'http',
			credential: { api_key: { kind: 'text' } },
			http: {
				base_url: 'https://erp.example/api',
				auth: { header: { name: 'x-api-key', value: 'api_key' } }
			}
		}
	},
	policies: {},
	automations: {},
	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} },
	needs: []
} satisfies EngineManifest;
const Row = Schema.Struct({
	active: Schema.Boolean,
	envoy: Schema.NullOr(Schema.String),
	revision: Schema.Number,
	epoch: Schema.NullOr(Schema.String),
	status: Schema.NullOr(Schema.Json)
});

class Fixture extends Context.Service<
	Fixture,
	{ readonly t: Kit; readonly store: Credentials }
>()('test/IntegrationOperator') {}
const fixture = Layer.effect(
	Fixture,
	Effect.gen(function* () {
		const t = yield* TestWorkspace;
		const store = yield* credentials(t.db, yield* Secrets);
		yield* seed_accounts(t.db, [
			{ id: 'wa', integration: 'whatsapp' },
			{ id: 'paused', integration: 'whatsapp' },
			{ id: 'fenced', integration: 'whatsapp' },
			{ id: 'erp1', integration: 'erp' }
		]);
		yield* seed_envoys(t.db, [
			{ id: DESK, name: 'Desk', policies: [] },
			{ id: RETIRED, name: 'Retired', policies: [], active: false }
		]);
		return { t, store };
	}).pipe(Effect.provide(NodeCrypto.layer))
).pipe(
	Layer.provideMerge(
		TestWorkspace.layer({ manifest, secrets_key: Redacted.make(randomBytes(32)) })
	)
);
/** Every publication a branch change makes: its epoch and captured images. */
const recorder = () => {
	const seen: { epoch: string; captured: readonly Captured[] }[] = [];
	const publish: BranchPublication = (epoch, captured) => {
		seen.push({ epoch, captured });
	};
	return { seen, publish };
};
const ignored: BranchPublication = () => {};
const row = (instance: string) =>
	Effect.flatMap(Fixture, ({ t }) =>
		t.db.one(Row, {
			text: 'SELECT active, envoy, revision, epoch, status FROM sys_integration WHERE id = $1',
			params: [instance]
		})
	).pipe(Effect.map(Option.getOrThrow));

layer(fixture, { excludeTestServices: true })('operator instance operations', (it) => {
	it.effect("keeps the recovery storage contract: a host reads this schema's people without the release", () =>
		Effect.gen(function* () {
			const { t } = yield* Fixture;
			yield* t.db.write({
				text: `INSERT INTO sys_user (id, name, email, phone, active, admin)
					VALUES ('op-admin', 'Operator', 'Op@example.test', '+65 9000 0001', true, true)`,
				params: []
			});
			const storage = branch_storage(t.db);
			expect((yield* storage.member({ email: null, phone: '65-9000-0001' }))?.id).toBe('op-admin');
			expect((yield* storage.administered('op@example.test'))?.map((user) => user.id)).toContain(
				'op-admin'
			);
			expect(yield* storage.paired).toBe(false);
		})
	);
	describe('configure', () => {
		it.effect('deploys an envoy under the revision its status read, publishes the change, and refuses a stale one', () =>
			Effect.gen(function* () {
				const { t } = yield* Fixture;
				const { seen, publish } = recorder();
				const status = yield* instance_admin(t.db, 'wa');
				expect(status).toEqual({
					instance: 'wa',
					active: true,
					envoy: null,
					state: null,
					stored: false,
					revision: 1
				});
				expect(
					yield* configure_instance(
						t.db,
						manifest,
						'wa',
						{ active: false, envoy: DESK, revision: status.revision },
						publish
					)
				).toEqual({ ...status, active: false, envoy: DESK, revision: 2 });
				// the committed images, on the epoch the statement read: what a generation's open pages patch from
				expect(seen).toEqual([
					{
						epoch: expect.any(String),
						captured: [
							expect.objectContaining({
								model: 'sys_integration',
								id: 'wa',
								op: 'update',
								revision: 2,
								old: expect.objectContaining({ active: true, envoy: null }),
								new: expect.objectContaining({ active: false, envoy: DESK })
							})
						]
					}
				]);
				const stale = yield* Effect.flip(
					configure_instance(t.db, manifest, 'wa', { active: true, envoy: null, revision: 1 }, publish)
				);
				expect(stale).toMatchObject({ _tag: 'BoltError', code: 'conflict' });
				expect(seen.flatMap((publication) => publication.captured)).toHaveLength(1);
				expect(yield* row('wa')).toMatchObject({ active: false, envoy: DESK, revision: 2 });
			})
		);
		it.effect('refuses an envoy the definition, the envoy or the instance does not allow', () =>
			Effect.gen(function* () {
				const { t } = yield* Fixture;
				for (const [instance, envoy] of [
					['erp1', DESK],
					['paused', RETIRED],
					['paused', '0c000000-0000-4000-8000-00000000000f']
				] as const)
					expect(
						yield* Effect.flip(
							configure_instance(t.db, manifest, instance, { active: true, envoy, revision: 1 }, ignored)
						)
					).toMatchObject({ _tag: 'BoltError', code: 'invalid' });
				expect(
					yield* Effect.flip(
						configure_instance(t.db, manifest, 'none', { active: true, envoy: null, revision: 1 }, ignored)
					)
				).toMatchObject({ _tag: 'BoltError', code: 'not_found' });
				expect(yield* row('erp1')).toMatchObject({ envoy: null, revision: 1 });
				expect(yield* row('paused')).toMatchObject({ envoy: null, revision: 1 });
			})
		);
	});
	describe('restore', () => {
		it.effect('replaces every sealed value under a rotated epoch, reads unpaired and publishes the pause and the restore', () =>
			Effect.gen(function* () {
				const { t, store } = yield* Fixture;
				const { seen, publish } = recorder();
				yield* store.write('wa', null, new Map([['stale', { token: 'old' }]]));
				const before = yield* row('wa');
				const values = { provider: 'baileys', creds: { token: 'synthetic-private-pairing' } };
				yield* restore_instance(t.db, store, 'wa', values, true, publish);
				const sealed = yield* store.read('wa');
				expect(Object.fromEntries(sealed.values)).toEqual(values);
				expect(sealed.epoch).not.toBe(before.epoch);
				expect(yield* row('wa')).toMatchObject({
					active: true,
					revision: before.revision + 2,
					status: { state: 'unpaired', account: null }
				});
				expect(yield* instance_admin(t.db, 'wa')).toMatchObject({ state: 'unpaired', stored: true });
				expect(
					seen.map(({ captured }) => captured.map((image) => [image.id, image.new?.['active'], image.revision]))
				).toEqual([
					[['wa', false, before.revision + 1]],
					[['wa', true, before.revision + 2]]
				]);
				// the images carry what a page reads, never a sealed value
				expect(JSON.stringify(seen)).not.toContain('synthetic-private-pairing');
				expect(
					yield* Effect.flip(restore_instance(t.db, store, 'none', values, true, ignored))
				).toMatchObject({ _tag: 'BoltError', code: 'not_found' });
			})
		);
		it.effect('stays paused, its credentials untouched, when interrupted before they change', () =>
			Effect.gen(function* () {
				const { t, store } = yield* Fixture;
				const entered = yield* Deferred.make<void>();
				const stuck: Credentials = {
					...store,
					open: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
				};
				const restoring = yield* Effect.forkChild(
					restore_instance(t.db, stuck, 'paused', { creds: 'synthetic' }, true, ignored)
				);
				yield* Deferred.await(entered);
				yield* Fiber.interrupt(restoring);
				expect(yield* row('paused')).toMatchObject({ active: false, revision: 2, status: null });
				expect((yield* store.read('paused')).values.size).toBe(0);
			})
		);
		it.effect('answers a conflict naming no value when another link moved the epoch', () =>
			Effect.gen(function* () {
				const { t, store } = yield* Fixture;
				const moved: Credentials = {
					...store,
					write: (instance) => Effect.fail(new Fenced({ instance, message: 'another link took it' }))
				};
				const failure = yield* Effect.flip(
					restore_instance(t.db, moved, 'fenced', { creds: 'synthetic-private-pairing' }, true, ignored)
				);
				expect(failure).toMatchObject({ _tag: 'BoltError', code: 'conflict' });
				expect(failure.message).not.toContain('synthetic-private-pairing');
				expect(yield* row('fenced')).toMatchObject({ active: false, status: null });
			})
		);
	});
});
