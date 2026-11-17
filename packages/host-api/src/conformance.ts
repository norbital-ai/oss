// The conformance kit: what any host checks of a release before serving it, what every release must answer, and how a
// branch of it answers the host's operator (`WorkspaceBranch.integrations`) and the recovery storage contract.
// Framework-free: each check is a named Promise a host runs in its own test runner, in order, against a release on its
// own disk; the branch checks share one branch.
import { Effect, Result, Schema } from 'effect';
import type { Json } from '@norbital-ai/store';
import { ReleaseFacts } from './answers.ts';
import type { HostTenantDb, RawDb } from './db.ts';
import type { FilesPort, KeysPort } from './facilities.ts';
import { HostApiFailure } from './failure.ts';
import type { HostApi, WorkspaceBranch } from './host.ts';
import { InstanceAdmin } from './integrations.ts';
import type { Release } from './ports.ts';
import { branch_storage } from './storage.ts';
import { HOST_API_VERSION, supports } from './version.ts';

/** One conformance check: its name, and the Promise that rejects with why the release fails it. */
export type Check = { readonly name: string; readonly run: () => Promise<void> };

const expect = (ok: boolean, message: string) => {
	if (!ok) throw new Error(message);
};
const signal = () => ({ signal: AbortSignal.timeout(30_000) });
const shown = (value: unknown) => (value instanceof Error ? value.message : String(JSON.stringify(value)));
/** `promise` must reject with an encoded `HostFailure`, of `code` when one is named. */
const refused = async (what: string, promise: Promise<unknown>, code?: string) => {
	const failure = await promise.then(
		() => undefined,
		(error: unknown) => error
	);
	const decoded = Schema.decodeUnknownOption(HostApiFailure)(failure);
	expect(
		decoded._tag === 'Some' &&
			decoded.value._tag === 'HostFailure' &&
			(code === undefined || decoded.value.code === code),
		`${what} answered ${shown(failure)}, not a HostFailure${code === undefined ? '' : ` ${code}`}`
	);
};
/** The seeded integration instance the branch checks work on. */
const INSTANCE = 'conformance';
const nothing = () => Promise.reject(new Error('the conformance branch stores no files'));
const files: FilesPort = { put: nothing, get: nothing, url: nothing, remove: nothing, download: nothing };
/** A secrets key that refuses: a credential restore that reaches it fails after its pause. */
const refusing: KeysPort = {
	seal: () => Promise.reject(new Error('the conformance key refuses')),
	open: () => Promise.reject(new Error('the conformance key refuses'))
};

/**
 * The checks for one release: `release` as built, and `tampered`, the same release with one of its files changed after
 * the build (the release must refuse it with an encoded `HostFailure`). `branches.database` opens a fresh, empty
 * database on each call, as a release reaches it (`port`) and through the host's own adapter (`raw`); `keys` is a
 * working secrets key; `instance` names an integration the release defines and a configuration it accepts, for the
 * unowned instance the kit seeds.
 */
export const conformance = (input: {
	readonly api: HostApi;
	readonly release: Release;
	readonly tampered: Release;
	readonly branches: {
		readonly database: () => Promise<{ readonly port: HostTenantDb; readonly raw: RawDb }>;
		readonly keys: KeysPort;
		readonly instance: { readonly integration: string; readonly configuration: Json };
	};
}): readonly Check[] => {
	const { api, release, tampered, branches } = input;
	let prepared:
		| Promise<{ readonly port: HostTenantDb; readonly raw: RawDb; readonly branch: WorkspaceBranch }>
		| undefined;
	/** One migrated branch of `release` holding the instance, active, seeded through the release's own restore. */
	const branched = () =>
		(prepared ??= (async () => {
			const { port, raw } = await branches.database();
			const branch = await api.branch({ release, database: port, keys: branches.keys }, signal());
			await branch.schema.migrate(signal());
			const load = await branch.packs.restore(
				{
					sys_integration: [
						{ id: INSTANCE, name: 'Conformance', owner: null, active: true, ...branches.instance }
					]
				},
				{ ...signal(), at: new Date().toISOString(), start: [], assets: [], asset: nothing, files }
			);
			let step = await load.step(signal());
			while (step === 'more') step = await load.step(signal());
			return { port, raw, branch };
		})());
	const status = async (branch: WorkspaceBranch) =>
		Schema.decodeUnknownSync(InstanceAdmin)(await branch.integrations.status(INSTANCE, signal()));
	return [
		{
			name: 'speaks the current HOST_API',
			run: async () =>
				expect(supports(api.version), `HOST_API ${api.version} does not match ${HOST_API_VERSION}`)
		},
		{
			name: 'evaluates tenant source',
			run: async () => expect(api.guest_execution === 'source', 'guest_execution is not source')
		},
		{
			name: 'names its contract and cookies',
			run: async () =>
				expect(
					api.contract !== '' &&
						api.cookies.session !== '' &&
						api.cookies.preview !== '' &&
						typeof api.cookie_site(true) === 'string' &&
						typeof api.cookie_site(false) === 'string',
					'contract, cookies or cookie_site is empty'
				)
		},
		{
			name: 'verifies its own release',
			run: () => api.verify(release, signal())
		},
		{
			name: 'refuses a tampered release with an encoded HostFailure',
			run: () => refused('a tampered release', api.verify(tampered, signal()))
		},
		{
			name: 'describes itself',
			run: async () => {
				Schema.decodeUnknownSync(ReleaseFacts)(await api.describe(release, signal()));
			}
		},
		{
			name: 'answers a frame policy',
			run: async () =>
				expect(
					(await api.frame_policy(release, '/', signal())).startsWith('frame-ancestors '),
					'the frame policy is not a frame-ancestors directive'
				)
		},
		{
			name: 'answers an unknown integration instance not_found',
			run: async () => {
				const { branch } = await branched();
				await refused('the status of an unknown instance', branch.integrations.status('unknown', signal()), 'not_found');
			}
		},
		{
			name: "reads an instance's status and fences configure by its revision: a stale one is a conflict",
			run: async () => {
				const { branch } = await branched();
				const before = await status(branch);
				expect(
					before.instance === INSTANCE && before.active && before.envoy === null && !before.stored,
					`the seeded instance reads ${shown(before)}`
				);
				const paused = Schema.decodeUnknownSync(InstanceAdmin)(
					await branch.integrations.configure(
						INSTANCE,
						{ active: false, envoy: null, revision: before.revision },
						signal()
					)
				);
				expect(!paused.active && paused.revision > before.revision, `configure answered ${shown(paused)}`);
				await refused(
					'a configure under a stale revision',
					branch.integrations.configure(INSTANCE, { active: true, envoy: null, revision: before.revision }, signal()),
					'conflict'
				);
				expect((await status(branch)).revision === paused.revision, 'a refused configure changed the instance');
			}
		},
		{
			name: 'refuses an envoy no active envoy names as invalid, and a malformed change as invalid_input',
			run: async () => {
				const { branch } = await branched();
				const { revision } = await status(branch);
				await refused(
					'an unknown envoy',
					branch.integrations.configure(INSTANCE, { active: true, envoy: 'unknown', revision }, signal()),
					'invalid'
				);
				await refused(
					'a fractional revision',
					branch.integrations.configure(INSTANCE, { active: true, envoy: null, revision: revision + 0.5 }, signal()),
					'invalid_input'
				);
				expect((await status(branch)).revision === revision, 'a refused configure changed the instance');
			}
		},
		{
			name: 'refuses a credential restore on a branch without the secrets key as unavailable',
			run: async () => {
				const { port } = await branched();
				const keyless = await api.branch({ release, database: port }, signal());
				await refused(
					'a restore without keys',
					keyless.integrations.restore(INSTANCE, { secret: 'conformance' }, { ...signal(), active: true }),
					'unavailable'
				);
			}
		},
		{
			name: 'pauses an instance before restoring its credentials: a failed restore leaves it paused',
			run: async () => {
				const { port, branch } = await branched();
				const { revision } = await status(branch);
				await branch.integrations.configure(INSTANCE, { active: true, envoy: null, revision }, signal());
				const failing = await api.branch({ release, database: port, keys: refusing }, signal());
				const failed = await failing.integrations
					.restore(INSTANCE, { secret: 'conformance' }, { ...signal(), active: true })
					.then(
						() => false,
						() => true
					);
				expect(failed, 'a restore whose secrets key refuses succeeded');
				const after = await status(branch);
				expect(!after.active, `after a failed restore the instance reads ${shown(after)}`);
			}
		},
		{
			name: 'restores credentials: the instance takes `active` and reads unpaired until its link opens',
			run: async () => {
				const { branch } = await branched();
				await branch.integrations.restore(INSTANCE, { secret: 'conformance' }, { ...signal(), active: true });
				const after = await status(branch);
				expect(
					after.active && after.stored && after.state === 'unpaired',
					`after a restore the instance reads ${shown(after)}`
				);
			}
		},
		{
			name: 'keeps the recovery storage contract: branch_storage reads a migrated branch',
			run: async () => {
				const { raw } = await branched();
				const storage = branch_storage(raw);
				const [members, paired] = await Effect.runPromise(Effect.all([storage.members, storage.paired]));
				expect(
					members.length === 0 && paired,
					`branch_storage read ${members.length} members and paired ${String(paired)}: no member, the restored instance paired`
				);
			}
		},
		{
			name: 'refuses another storage layout with UnknownStorage',
			run: async () => {
				const { raw } = await branches.database();
				const unknown = async (what: string) => {
					const read = await Effect.runPromise(Effect.result(branch_storage(raw).members));
					expect(
						Result.isFailure(read) && read.failure._tag === 'UnknownStorage',
						`branch_storage over ${what} answered ${shown(read)}`
					);
				};
				await unknown('an empty database');
				await Effect.runPromise(
					raw.transaction({
						statements: [
							{ text: 'CREATE TABLE bolt_schema (slice jsonb NOT NULL)', params: [] },
							{
								text: `INSERT INTO bolt_schema (slice) VALUES ('{"tables":{"sys_user":{"key":"uuid","fields":{}}}}')`,
								params: []
							},
							{
								text: 'CREATE TABLE sys_user (id uuid PRIMARY KEY, name text, email text, phone text, team text, active bool)',
								params: []
							}
						]
					})
				);
				await unknown('another layout');
			}
		}
	];
};
