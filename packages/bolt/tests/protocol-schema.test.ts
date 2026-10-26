/// <reference types="node" />
// The wire's Schemas (§5.7, A.4) and the C9 artifact a host reads: each body decodes and encodes back to itself, the
// status map runs both ways, the own callables keep their refusals, an instance status drops what it cannot read, the
// artifact's files are decoded once (`ManifestInvalid`) as native Effects, and a workspace's pages resolve alike
// on every host.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Effect, FileSystem, Schema } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { artifactHash, CONTRACT, readArtifact, treeHash } from '../src/engine/artifact/read.ts';
import { prepareMigrations } from '../src/compiler/migrations.ts';
import { Pristine } from '../src/node/db/pglite.ts';
import { sha256Hex } from '@norbital-ai/store';
import type { Outcome as EngineOutcome } from '../src/engine/contracts.ts';
import { ManifestInvalid } from '../src/engine/errors.ts';
import { BoltError } from '../src/protocol/errors.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { fingerprint, schemaSlice } from '../src/engine/schema/plan.ts';
import {
	ActBody,
	ActReply,
	AgentConversation,
	AgentRow,
	Frame,
	HostOperation,
	HostOperationResult,
	InstanceStatus,
	LiveBody,
	LiveReply,
	OwnCall,
	ownRefusal,
	PushBody,
	QBody,
	QReply,
	SessionRequest,
	SessionResponse,
	TemplateManifest,
	Usage,
	WireError,
	WireRead,
	type Outcome,
	type WriteOutcome
} from '../src/protocol/schema.ts';
import { clientPage } from '../src/protocol/static.ts';
import { refusalOfStatus, statusOf, wireError } from '../src/protocol/wire.ts';

/** `value` decodes, and its encoding decodes to the same value. */
const trip = <A, I>(schema: Schema.Codec<A, I>, value: unknown): A => {
	const decoded = Schema.decodeUnknownSync(schema)(value);
	expect(Schema.decodeUnknownSync(schema)(Schema.encodeSync(schema)(decoded))).toEqual(decoded);
	return decoded;
};
const refuses = <A, I>(schema: Schema.Codec<A, I>, value: unknown) =>
	expect(Schema.decodeUnknownOption(schema)(value)._tag).toBe('None');
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('the wire Schemas', () => {
	it('round-trips every body and frame', () => {
		const read = { m: 'query', a: ['orders', { where: { status: 'open' } }] };
		trip(WireRead, read);
		for (const m of ['read', 'get', 'similar']) refuses(WireRead, { m, a: ['orders', {}] });
		trip(QBody, { reads: [read, { m: 'transcript', a: ['c1', { tail: 20 }] }] });
		trip(QReply, { answers: [[{ id: 'o1' }], null] });
		trip(ActBody, {
			callable: 'orders.create',
			input: { total: { $dec: '1.20' } },
			issuedAt: '2026-10-14T00:00:00.000Z',
			observed: { o1: 3 },
			onConflict: 'keep'
		});
		for (const outcome of [
			{
				kind: 'committed',
				output: { id: 'o1' },
				records: [{ collection: 'orders', id: 'o1', revision: 1 }]
			},
			{ kind: 'pendingApproval', requestId: 'r1', records: [] },
			{
				kind: 'refused',
				code: 'unique',
				message: 'taken',
				field: 'code',
				row: 0,
				rows: [0, 2],
				rule: 'orders.transform',
				data: { requestId: 'r1' }
			},
			{ kind: 'conflict', records: [{ collection: 'orders', id: 'o1', fields: ['total'] }] },
			{ kind: 'unknown', invocation: 'i1' }
		])
			trip(ActReply, { outcome, v: 7 });
		trip(WireError, { error: { code: 'invalid', message: 'the body is { reads }' } });
		trip(LiveBody, {
			conn: 'c',
			add: [{ view: 'v', read }],
			drop: ['w']
		});
		trip(LiveReply, { errors: [{ view: 'v', code: 'tooManySubscriptions', message: 'too many' }] });
		for (const frame of [
			{ t: 'hello', conn: 'c', v: 0 },
			{ t: 'answer', view: 'v', v: 1, value: [], arrivals: [{ id: 'o1' }] },
			{
				t: 'patch',
				view: 'v',
				v: 2,
				ops: [
					{ op: 'upsert', index: 0, row: { id: 'o1' } },
					{ op: 'remove', id: 'o2' }
				]
			},
			{ t: 'error', view: 'v', code: 'cellBudget', message: 'over' },
			{ t: 'v', v: 3 },
			{ t: 'close', release: 'r2' }
		])
			trip(Frame, frame);
		trip(PushBody, { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } });
		trip(PushBody, { endpoint: 'https://push.example/x', remove: true });
		trip(PushBody, {
			kind: 'apns',
			endpoint: 'ab'.repeat(32),
			keys: { topic: 'ai.norbital.app', environment: 'production', teamId: 'TEAM123456' }
		});
		trip(Usage, {
			input: 10,
			output: 2,
			calls: 1,
			cost: 0.01,
			context: 900,
			window: 128000,
			model: 'strong'
		});
		trip(AgentRow, {
			id: 'm1',
			seq: 1,
			role: 'tool',
			text: null,
			state: 'running',
			tag: null,
			author: null,
			files: [{ id: 'f1', name: 'a.png', mime: 'image/png' }],
			tool: { name: 'read', failed: false, running: true, args: '{}', ms: 3 },
			compact: { cutoff: 4, keep: ['m0'], origin: 'manual' }
		});
		trip(AgentConversation, {
			id: 'c1',
			title: null,
			at: '2026-10-14T00:00:00.000Z',
			status: 'idle',
			model: 'default',
			plan: { revision: 1, body: '- a', status: 'draft' },
			goals: [{ id: 'g', text: 'x', status: 'doing' }],
			envoy: null,
			integration: null,
			kind: null,
			thread: null,
			peer: null
		});
		for (const request of [
			{ path: 'code', body: { address: '+6591234567', via: 'whatsapp' } },
			{ path: 'verify', body: { address: 'a@b.c', code: '123456' } },
			{ path: 'signout' },
			{ path: 'invitation', body: { id: 'i1' } }
		])
			trip(SessionRequest, request);
		trip(SessionResponse, { value: { user: 'u1' } });
		trip(SessionResponse, { value: null });
		trip(HostOperation, { op: 'session.mint', input: { user: 'u1' }, runId: 'r1' });
		trip(HostOperationResult, { value: { token: 't' } });
	});

	it('refuses what is not the protocol', () => {
		refuses(WireRead, { m: 'drop', a: [] });
		refuses(QBody, { reads: 'all' });
		refuses(ActBody, { callable: 'orders.create', input: {} });
		refuses(ActReply, { outcome: { kind: 'refused', code: 'nope', message: 'x' }, v: 1 });
		refuses(Frame, { t: 'hello', conn: 'c' });
		refuses(SessionRequest, { path: 'code', body: { address: 'a', via: 'pigeon' } });
	});

	it('types a write outcome as the engine does; the wire adds `running`', () => {
		const same: Same<WriteOutcome, EngineOutcome> = true;
		expect(same).toBe(true);
	});
});

describe('the status map (rule 32)', () => {
	it("answers each outcome's status, and the client reads a failure's status back as its refusal", () => {
		const refused = (code: Extract<Outcome, { kind: 'refused' }>['code']): Outcome => ({
			kind: 'refused',
			code,
			message: code
		});
		expect(statusOf({ kind: 'committed', output: null, records: [] })).toBe(200);
		expect(statusOf({ kind: 'pendingApproval', requestId: 'r', records: [] })).toBe(202);
		expect(statusOf({ kind: 'conflict', records: [] })).toBe(409);
		expect(statusOf({ kind: 'unknown', invocation: 'i' })).toBe(504);
		expect(
			(
				[
					'invalidInput',
					'forbidden',
					'locked',
					'notFound',
					'rateLimited',
					'unique',
					'internal',
					'tooLarge'
				] as const
			).map((c) => statusOf(refused(c)))
		).toEqual([400, 403, 403, 404, 429, 422, 422, 422]);
		for (const code of ['invalidInput', 'forbidden', 'notFound', 'rateLimited'] as const)
			expect(refusalOfStatus(statusOf(refused(code)))).toBe(code);
		expect(refusalOfStatus(401)).toBe('forbidden');
		expect([409, 422, 500, 504].map(refusalOfStatus)).toEqual([null, null, null, null]);
	});

	it("answers a transport failure at its code's status, and anything else as a 500 that names nothing", () => {
		expect(
			wireError(BoltError.make('unknownCallable', 'decode', "there is no callable 'x'"))
		).toEqual({
			status: 404,
			body: { error: { code: 'unknownCallable', message: "there is no callable 'x'" } }
		});
		expect(wireError(BoltError.make('invalid', 'decode', 'the body is not JSON')).status).toBe(400);
		expect(wireError(new Error('secret detail'))).toEqual({
			status: 500,
			body: { error: { code: 'internal', message: 'The request failed.' } }
		});
	});
});

describe('the own callables', () => {
	it('decode by callable, with the refusal each one has always answered', () => {
		const decode = Schema.decodeUnknownOption(OwnCall);
		expect(decode({ callable: 'start', input: { automation: 'nightly', id: 'r1' } })._tag).toBe(
			'Some'
		);
		expect(
			decode({
				callable: 'start',
				input: { automation: 'nightly', runs: [{ id: 'r1' }, { id: 'r2' }] }
			})._tag
		).toBe('Some');
		expect(decode({ callable: 'start', input: { automation: 'nightly', runs: [] } })._tag).toBe(
			'None'
		);
		expect(decode({ callable: 'start', input: { automation: 'nightly' } })._tag).toBe('None');
		expect(ownRefusal('start', { automation: 'nightly' })).toBe(
			'start takes { automation, input, id } or { automation, runs: [{ input, id }] }'
		);
		expect(
			decode({
				callable: 'approvals.decide',
				input: { requestId: 'r', decision: 'approve', reason: 'Reviewed.' }
			})
		).toMatchObject({
			value: { input: { requestId: 'r', decision: 'approve', reason: 'Reviewed.' } }
		});
		expect(
			decode({ callable: 'approvals.decide', input: { requestId: 'r', decision: 'maybe' } })._tag
		).toBe('None');
		// a post needs text or an attachment
		expect(
			decode({ callable: 'sys_message.post', input: { conversation: 'c', text: '  ' } })._tag
		).toBe('None');
		expect(
			decode({
				callable: 'sys_message.post',
				input: { conversation: 'c', text: '', attachments: [{ id: 'f' }], mode: 'shout' }
			})
		).toMatchObject({
			value: { input: { conversation: 'c', text: '', attachments: [{ id: 'f' }] } }
		});
		expect(decode({ callable: 'sys_message.file', input: { message: 'm' } })).toMatchObject({
			value: { input: { message: 'm', about: null } }
		});
		expect(decode({ callable: 'sys_notification.markRead', input: { all: true } })._tag).toBe(
			'Some'
		);
		expect(decode({ callable: 'sys_notification.markRead', input: { ids: [1] } })._tag).toBe(
			'None'
		);
		// starting a conversation is never refused: what does not decode takes the defaults
		expect(decode({ callable: 'sys_conversation.start', input: null })).toMatchObject({
			value: { input: {} }
		});
		// the checks run in the order the sender has always met them
		expect(ownRefusal('sys_conversation.setModel', { model: 'strong' })).toBe(
			'this call takes { conversation }'
		);
		expect(ownRefusal('sys_conversation.setModel', { conversation: 'c' })).toBe(
			'sys_conversation.setModel takes { conversation, model }'
		);
		expect(ownRefusal('sys_message.revise', { message: 'm', text: ' ' })).toBe(
			'sys_message.revise takes { message, text }'
		);
		expect(ownRefusal('filter.describe', { collection: 'orders' })).toBe(
			'filter.describe takes { collection, text }'
		);
		expect(
			ownRefusal('filter.describe', { collection: 'orders', text: 'open', fields: [{ name: 'x' }] })
		).toBe('filter.describe fields are invalid');
		expect(ownRefusal('sys_message.dequeue', null)).toBe('this call takes { message }');
	});
});

describe('an instance status', () => {
	it('drops a malformed member, keeps the rest, and refuses a malformed state or driver', () => {
		const decode = Schema.decodeUnknownOption(InstanceStatus);
		const s = decode({
			instance: 'i',
			driver: 'email',
			state: 'connected',
			account: 5,
			lastDisconnect: { code: 401 },
			providers: [{ id: 'p', label: 'P', setup: { kind: 'none' } }, { id: 'q' }],
			test: { to: 'nobody' }
		});
		expect(s).toMatchObject({
			value: {
				instance: 'i',
				integration: '',
				stored: false,
				lastDisconnect: { code: 401 },
				providers: [{ id: 'p', setup: { kind: 'none', steps: [] } }]
			}
		});
		expect(s._tag === 'Some' && ('account' in s.value || 'test' in s.value)).toBe(false);
		expect(
			decode({ instance: 'i', driver: 'email', state: 'pairing', pairing: { kind: 'qr' } })
		).toMatchObject({ value: { pairing: { kind: 'qr', value: null } } });
		expect(decode({ instance: 'i', driver: 'fax', state: 'connected' })._tag).toBe('None');
	});
});

describe('norbital.template.json', () => {
	const manifest = {
		schemaVersion: 1,
		key: 'norbital_construction',
		name: 'Construction Operations',
		industry: 'Construction',
		description: 'Projects.',
		visibility: 'public',
		counts: { models: 16, apps: 3, automations: 4 },
		tags: ['Operations'],
		name_zh: '施工',
		seed: {
			bankTree: 'construction',
			layout: 'snapshots',
			stages: [['team'], ['user']],
			producers: [{ collection: 'photo_evidence', kind: 'photos' }]
		}
	};
	it('decodes the catalogue entry the gate checks', () => {
		trip(TemplateManifest, manifest);
		refuses(TemplateManifest, { ...manifest, schemaVersion: 2 });
		refuses(TemplateManifest, { ...manifest, key: 'Not A Handle' });
		refuses(TemplateManifest, { ...manifest, name: '  ' });
		refuses(TemplateManifest, {
			...manifest,
			counts: { models: -1, apps: 0, automations: 0 }
		});
		refuses(TemplateManifest, { ...manifest, visibility: 'private' });
	});
});

// ── the artifact (C9) ──
const workspace: EngineManifest = {
	workspace: { tz: 'Asia/Singapore', locale: 'en' },
	models: {},
	relationships: {},
	collections: {},
	integrations: {},
	policies: {},
	teams: {},
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
};
/** A minimal built artifact: the manifest, a guest, one client document and one asset, digests recorded. */
const built = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-artifact-' });
	const manifestText = `${JSON.stringify(workspace)}\n`,
		guest = 'export {};\n';
	writeFileSync(join(dir, 'manifest.json'), manifestText);
	writeFileSync(join(dir, 'guest.mjs'), guest);
	mkdirSync(join(dir, 'client'));
	writeFileSync(join(dir, 'client', 'index.html'), '<html><head></head></html>');
	writeFileSync(join(dir, 'client', 'app.js'), 'export {};');
	mkdirSync(join(dir, 'assets'));
	writeFileSync(join(dir, 'assets', 'logo.png'), 'png');
	yield* prepareMigrations(dir, workspace, 'generate');
	const body = {
		format: 1 as const,
		contract: CONTRACT,
		handle: 'norbital_test',
		name: 'Test',
		schema: fingerprint(schemaSlice(workspace)),
		client: { entry: 'app.js', css: [] },
		pages: {},
		hashes: {
			manifest: sha256Hex(manifestText),
			guest: sha256Hex(guest),
			client: yield* treeHash(join(dir, 'client')),
			server: yield* treeHash(join(dir, 'server'))
		}
	};
	writeFileSync(
		join(dir, 'artifact.json'),
		JSON.stringify({ ...body, hash: yield* artifactHash(dir, body) })
	);
	return dir;
}).pipe(Effect.provide(Pristine.layer));

describe('the artifact a host reads', () => {
	it.effect('reads the native artifact once with its manifest and descriptor', () =>
		Effect.gen(function* () {
			const dir = yield* built;
			expect((yield* readArtifact(dir)).manifest.workspace.tz).toBe('Asia/Singapore');
			expect((yield* readArtifact(dir)).artifact.handle).toBe('norbital_test');
			expect((yield* readArtifact(dir)).dir).toBe(dir);
		}).pipe(Effect.provide(NodeServices.layer))
	);

	it.effect(
		'refuses an artifact.json or manifest.json that does not decode as ManifestInvalid',
		() =>
			Effect.gen(function* () {
				const dir = yield* built;
				writeFileSync(join(dir, 'artifact.json'), JSON.stringify({ format: 2 }));
				expect(yield* Effect.flip(readArtifact(dir))).toBeInstanceOf(ManifestInvalid);
				const other = yield* built;
				writeFileSync(
					join(other, 'manifest.json'),
					JSON.stringify({ ...workspace, unknownPart: {} })
				);
				expect(yield* Effect.flip(readArtifact(other))).toBeInstanceOf(ManifestInvalid);
				expect(yield* Effect.flip(readArtifact(join(other, 'nowhere')))).toMatchObject({
					message: expect.stringMatching(/holds no artifact.json/)
				});
			}).pipe(Effect.provide(NodeServices.layer))
	);
});

describe("a workspace's pages", () => {
	it.effect(
		'confines encoded asset separators to public assets without exposing private artifact files',
		() =>
			Effect.gen(function* () {
				const dir = yield* built;
				const fs = yield* FileSystem.FileSystem;
				yield* fs.makeDirectory(join(dir, 'workspace', 'src'), { recursive: true });
				yield* fs.writeFileString(join(dir, 'workspace', 'src', 'private.ts'), 'private source');
				yield* fs.makeDirectory(join(dir, 'assets', 'nested'));
				yield* fs.writeFileString(join(dir, 'assets', 'nested', 'logo one.svg'), '<svg/>');
				for (const path of [
					'/assets/..%2fguest.mjs',
					'/assets/%2e%2e%2fmanifest.json',
					'/assets/%2E%2E%2Fartifact.json',
					'/assets/%2e%2e%2fworkspace%2fsrc%2fprivate.ts'
				]) {
					const pathname = new URL(path, 'https://workspace.invalid').pathname;
					expect(pathname).toBe(path);
					expect(yield* clientPage(dir, pathname, workspace)).toMatchObject({
						file: join(dir, 'client', 'index.html'),
						document: true
					});
				}
				expect(yield* clientPage(dir, '/assets/nested%2flogo%20one.svg', workspace)).toEqual({
					file: join(dir, 'assets', 'nested', 'logo one.svg'),
					document: false,
					headers: {
						'content-type': 'image/svg+xml',
						'cache-control': 'public, max-age=31536000, immutable'
					}
				});
			}).pipe(Effect.provide(NodeServices.layer))
	);
	it.effect(
		'serve the client build, then the workspace assets, then the document under the frame policy',
		() =>
			Effect.gen(function* () {
				const dir = yield* built;
				expect(yield* clientPage(dir, '/app.js', workspace)).toEqual({
					file: join(dir, 'client', 'app.js'),
					document: false,
					headers: { 'content-type': 'text/javascript', 'cache-control': 'no-cache' }
				});
				expect((yield* clientPage(dir, '/assets/logo.png', workspace))?.headers).toEqual({
					'content-type': 'image/png',
					'cache-control': 'public, max-age=31536000, immutable'
				});
				expect(yield* clientPage(dir, '/__bolt', workspace)).toBeUndefined();
				expect(yield* clientPage(dir, '/__bolt/nope', workspace)).toBeUndefined();
				expect(yield* clientPage(dir, '/orders/o1', workspace)).toEqual({
					file: join(dir, 'client', 'index.html'),
					document: true,
					headers: {
						'content-type': 'text/html; charset=utf-8',
						'cache-control': 'no-cache',
						'content-security-policy': "frame-ancestors 'self'"
					}
				});
				// never a file outside the build or the assets
				expect((yield* clientPage(dir, '/../manifest.json', workspace))?.document).toBe(true);
				expect((yield* clientPage(dir, '/manifest.json', workspace))?.document).toBe(true);
				const fs = yield* FileSystem.FileSystem;
				expect(
					yield* clientPage(
						yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-empty-' }),
						'/',
						workspace
					)
				).toBeUndefined();
			}).pipe(Effect.provide(NodeServices.layer))
	);
});
