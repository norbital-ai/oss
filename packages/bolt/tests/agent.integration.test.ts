import { withEnvoys } from './support/envoys.ts';
// Native agent turns over scoped PGlite workspaces, provider streams and a local MCP ABI fixture.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { afterAll } from 'vitest';
import {
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberSet,
	Layer,
	Predicate,
	Queue,
	Result,
	Schema,
	Scope,
	Stream
} from 'effect';
import type { Json } from '../src/decl/values.ts';
import { mcpServers, mcpSessions } from '../src/engine/agent/mcp.ts';
import type { AiRequest, AiResponse, Ingested } from '../src/engine/contracts.ts';
import { callKey, FIXED, rest, type AgentHostConfig } from '../src/engine/agent/index.ts';
import { transcriptRow } from '../src/engine/agent/schema.ts';
import { BOUNDS, COMPACT_FORMAT, STATE_NOTE } from '../src/engine/agent/context.ts';
import { requestEvidence } from '../src/engine/agent/request.ts';
import type { MessageRow } from '../src/engine/agent/schema.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Port, type PortFailure } from '../src/engine/port.ts';
import { Ai, Convert, Files, Mcp, RunUnits, type AiEvent } from '../src/engine/ports.ts';
import { off } from '../src/facilities/off.ts';
import { openAiChat } from '../src/engine/agent/openai-chat.ts';
import { mcpPort } from '../src/node/mcp.ts';
import { Agents, Live } from '../src/engine/services.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { announce, type WorkspaceNote } from '../src/engine/notifications/notify.ts';
import { AgentConversation, AgentRow, type Frame } from '../src/protocol/schema.ts';
import {
	KitInvalid,
	TestWorkspace,
	respondSystem1,
	type Kit
} from '../../bolt-cli/src/test/effect.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';

const manifest: EngineManifest = {
	needs: [],
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } }, // hook:decisions — not a triage test (rule 60a opt-out)
	models: {
		quotes: {
			description: 'A quote',
			label: 'title',
			fields: {
				title: { kind: 'text' },
				region: { kind: 'enum', values: ['north', 'south'], default: 'north' }
			}
		}
	},
	relationships: {},
	exposures: {
		quotes: {
			outputs: {
				default: { quotes: { fields: 'all' } },
				titles: { quotes: { fields: ['title'] } }
			},
			create: { columns: { quotes: ['title', 'region'] } },
			update: { columns: { quotes: ['title', 'region'] } },
			delete: {}
		}
	},
	policies: {
		narrow: {
			description: 'Titles only',
			grants: { quotes: { outputs: { titles: true } } }
		},
		rep: {
			description: 'Rep',
			grants: { quotes: { outputs: { default: true }, create: true, update: true } },
			capabilities: { mcp: ['hq'], automations: ['quotes_mark'] }
		},
		reader: { description: 'Reads quotes', grants: { quotes: { outputs: { default: true } } } }
	},

	mcp: {
		hq: { description: 'HQ tools', url: 'HQ_URL', auth: { bearer: 'HQ_TOKEN' } },
		down: { description: 'Gone', url: 'DOWN_URL' }
	},
	agent: {
		internal: 'Staff brief.',
		external: 'Customer brief.',
		skills: {
			pricing: {
				text: '---\ndescription: How we price\n---\n## Discounts\nTen percent.\n## Rounding\nUp.',
				digest: '',
				files: ['SKILL.md']
			}
		}
	},
	integrations: {},
	teams: { rep: ['rep'], reader: ['reader'], narrow: ['narrow'] },
	automations: {
		quotes_mark: {
			description: 'Mark a quote',
			input: { title: { kind: 'text' } },
			output: { kind: 'text' },
			policies: ['rep'],
			agent: 'confirm'
		},
		quotes_tally: {
			description: 'Tally quotes by title',
			input: { title: { kind: 'text' }, fail: { kind: 'bool', optional: true } },
			output: { kind: 'text' },
			policies: ['rep']
		}
	},
	connections: {
		desk: { integration: 'whatsapp' },
		field: { integration: 'whatsapp' }
	},
	apps: {},
	customFields: {}
};
const salesDeskEnvoy = '0199a000-0000-7000-8000-0000000000e1';
const fieldEnvoy = '0199a000-0000-7000-8000-0000000000e2';
const runtimeEnvoys = [
	{
		id: salesDeskEnvoy,
		connections: ['desk'],
		audience: 'public',
		name: 'Norbius',
		policies: ['reader'],
		triage: false,
		group_messages: 'disabled',
		delegation: 'enabled',
		task: 'Answer questions about quotes.'
	},
	{
		id: fieldEnvoy,
		connections: ['field'],
		audience: 'private',
		name: 'Norbius',
		policies: ['reader'],
		triage: false,
		group_messages: 'mention_or_reply',
		delegation: 'disabled',
		task: 'Keep quotes up to date.'
	}
] as const;

const guest = program(`export default { automation: { quotes_mark: { body: function* (input, ctx) {
	return (yield* ctx.act('quotes.create', [{ title: input.title }])).records[0].id;
} }, quotes_tally: { body: function* (input) {
	if (input.fail) throw new Error('no tally for ' + input.title);
	return input.title;
} } } };`);

// Each cassette step is a native provider stream, pulled once by the real Ai service.
type Step = Ai['Service']['infer'];
const answer = (response: AiResponse): Stream.Stream<AiEvent, PortFailure> =>
	Stream.succeed({ _tag: 'Response', response });
const say =
	(text: string, input = 10): Step =>
	() =>
		answer({ content: text, toolCalls: [], finish: 'stop', usage: { input, output: 5 } });
const use =
	(name: string, input: Json, id: string = randomUUID(), used = 10): Step =>
	() =>
		answer({
			content: '',
			toolCalls: [{ id, name, input }],
			finish: 'tool',
			usage: { input: used, output: 5 }
		});
type Catalog = Effect.Success<Ai['Service']['catalog']>;
const CATALOG: Catalog = { models: [{ id: 'default', label: 'Default' }], default: 'default' };
/** The provider's script: `arm` replaces its steps and catalogue and clears its requests for the next test. */
const cassette = (steps: readonly Step[] = []) => {
	const requests: AiRequest[] = [];
	const script = { steps, catalog: CATALOG, index: 0 };
	const port: Ai['Service'] = {
		ask: respondSystem1,
		maxChoices: undefined,
		models: ['default'],
		catalog: Effect.sync(() => script.catalog),
		embed: () => Port.unavailable('ai.embed'),
		infer: (request) =>
			Stream.unwrap(
				Effect.sync(() => {
					requests.push(request);
					const step = script.steps[script.index++];
					return step === undefined
						? Stream.fail(Port.failure('ai')(new Error('cassette exhausted')))
						: step(request);
				})
			)
	};
	const arm = (steps: readonly Step[], catalog = CATALOG) => {
		Object.assign(script, { steps, catalog, index: 0 });
		requests.length = 0;
	};
	return { port, requests, arm, layer: Layer.succeed(Ai, port) };
};
const toolNames = (request: AiRequest | undefined) =>
	(request?.tools ?? []).map((tool) => tool.name);
const toolResults = (request: AiRequest) =>
	request.messages
		.filter((message) => message.role === 'tool')
		.map(
			(message) =>
				Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Json }))(message.content).result
		);

// The local Node HTTP server is an explicit ABI edge; its lifetime and callback fibers are scope-owned.
const mcpFixture = Effect.gen(function* () {
	const calls: Json[] = [];
	const started = yield* Deferred.make<void>(),
		release = yield* Deferred.make<void>(),
		closed = yield* Deferred.make<void>();
	const run = yield* FiberSet.makeRuntimePromise();
	const server = createServer(async (request, response) => {
		if (request.headers.authorization !== 'Bearer s3cret') {
			response.writeHead(401).end();
			return;
		}
		if (request.method !== 'POST') {
			response.writeHead(405).end();
			return;
		}
		let body = '';
		for await (const part of request) body += String(part);
		const message = Schema.decodeUnknownSync(
			Schema.fromJsonString(
				Schema.Struct({
					id: Schema.optionalKey(Schema.Number),
					method: Schema.String,
					params: Schema.optionalKey(
						Schema.Struct({
							protocolVersion: Schema.optionalKey(Schema.String),
							name: Schema.optionalKey(Schema.String),
							arguments: Schema.optionalKey(
								Schema.Struct({ text: Schema.optionalKey(Schema.String) })
							)
						})
					)
				})
			)
		)(body);
		if (message.id === undefined) {
			response.writeHead(202).end();
			return;
		}
		if (
			message.method === 'tools/call' &&
			message.params?.arguments?.text === 'hold-native-close'
		) {
			response.on('close', () => {
				void run(Deferred.succeed(closed, undefined));
			});
			await run(Deferred.succeed(started, undefined));
			await run(Deferred.await(release));
		}
		const result =
			message.method === 'initialize'
				? {
						protocolVersion: message.params?.protocolVersion,
						capabilities: { tools: {} },
						serverInfo: { name: 'hq', version: '1' }
					}
				: message.method === 'tools/list'
					? {
							tools: [
								{
									name: 'echo',
									description: 'Echo text',
									inputSchema: { type: 'object', properties: { text: { type: 'string' } } }
								}
							]
						}
					: message.method === 'tools/call'
						? (calls.push(Schema.decodeUnknownSync(Schema.Json)(message.params)),
							{ content: [{ type: 'text', text: `echo: ${message.params?.arguments?.text}` }] })
						: undefined;
		response
			.writeHead(200, { 'content-type': 'application/json' })
			.end(
				JSON.stringify(
					result === undefined
						? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no such method' } }
						: { jsonrpc: '2.0', id: message.id, result }
				)
			);
	});
	yield* Effect.acquireRelease(
		Effect.tryPromise({
			try: () => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)),
			catch: (error) => new KitInvalid({ message: String(error) })
		}),
		() =>
			Effect.gen(function* () {
				yield* Deferred.succeed(release, undefined);
				server.closeAllConnections();
				yield* Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())));
			})
	);
	const address = server.address();
	if (address === null || typeof address === 'string')
		return yield* Effect.fail(new KitInvalid({ message: 'the MCP fixture has no TCP address' }));
	return { url: `http://127.0.0.1:${address.port}/mcp`, calls, started, release, closed };
});

it.live('SDK close aborts an already-running MCP request without a second drain owner', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const { hq } = yield* shared;
			const scope = yield* Scope.make();
			yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
			const mcp = Mcp.fromAbi(yield* mcpPort);
			const sessions = yield* mcpSessions(manifest, {
				secret: (name) => Effect.succeed(name === 'HQ_URL' ? hq.url : 's3cret')
			}).pipe(Scope.provide(scope), Effect.provide(mcp));
			const call = yield* Effect.forkChild(
				sessions.call('hq', 'echo', { text: 'hold-native-close' }).pipe(Effect.result)
			);
			yield* Deferred.await(hq.started).pipe(Effect.timeout('5 seconds'));
			yield* Scope.close(scope, Exit.void);
			const result = yield* Fiber.join(call);
			expect(Result.isFailure(result)).toBe(true);
			if (Result.isFailure(result))
				expect(result.failure).toMatchObject({
					kind: 'upstream',
					message: expect.stringContaining('Connection closed')
				});
			yield* Deferred.await(hq.closed).pipe(Effect.timeout('5 seconds'));
			expect(yield* Effect.flip(sessions.call('hq', 'echo', {}))).toMatchObject({
				_tag: 'Unavailable'
			});
			yield* Deferred.succeed(hq.release, undefined);
		})
	)
);

/** What the fake ingest port answers for every document, once `ingestGate` opens. */
let ingestGate: Promise<void> = Promise.resolve();
const TENDER: Ingested = {
	kind: 'document',
	html: [
		'<h1>Cover</h1>',
		'<p>Tender for site works</p>',
		'<h2>Pricing</h2>',
		'<table>',
		'<tr><td>Lot</td><td>Rate</td></tr>',
		'<tr><td>7</td><td>12.50</td></tr>',
		'</table>',
		'<p><img src="image-1.png" alt="site plan"></p>',
		'<p>End</p>'
	].join('\n'),
	images: [{ name: 'image-1.png', mime: 'image/png', bytes: new Uint8Array([0x89, 0x50]) }],
	meta: { stats: { pages: 2, bytes: 100, cpuMs: 40, wallMs: 90 } }
};
const build = (
	ai: ReturnType<typeof cassette>,
	host: Pick<AgentHostConfig, 'hostTools' | 'hostInlineMs' | 'onTurnStart' | 'events'> = {},
	tools: EngineManifest['agent']['tools'] = {}
) =>
	Effect.gen(function* () {
		const hq = yield* mcpFixture;
		const values: Record<string, string> = {
			HQ_URL: hq.url,
			HQ_TOKEN: 's3cret',
			DOWN_URL: 'http://127.0.0.1:1/mcp'
		};
		const context = yield* Layer.build(
			withEnvoys(
				TestWorkspace.layer({
					manifest: { ...manifest, agent: { ...manifest.agent, tools } },
					guest: yield* guest,
					ports: Layer.merge(
						ai.layer,
						// the host's ingest port (Norbital Convert): every document here is the tender
						Convert.fromAbi(off, async () => {
							await ingestGate;
							return TENDER;
						})
					),
					// the host clock starts at the wall clock, as a turn drained from a live test reads it
					now: new Date().toISOString(),
					host: { agent: { ...host, mcp: { secret: (name) => Effect.succeed(values[name]) } } }
				}),
				runtimeEnvoys
			)
		);
		const t = Context.get(context, TestWorkspace),
			agent = Context.get(context, Agents),
			live = Context.get(context, Live);
		const user = (
			name: string,
			options: { admin?: boolean; team?: 'rep' | 'reader' | 'narrow'; external?: boolean } = {}
		) =>
			Effect.gen(function* () {
				const id = randomUUID();
				yield* t.db.write({
					text: 'INSERT INTO sys_user (id, email, name, admin, kind, team) VALUES ($1,$2,$3,$4,$5,$6)',
					params: [
						id,
						`${name}.${id}@x.test`,
						name,
						options.admin ?? false,
						options.external ? 'external' : 'staff',
						options.team ?? null
					]
				});
				return id;
			});
		const authority = (id: string) =>
			Effect.gen(function* () {
				const resolved = yield* new Authorities(manifest, 'test').member(t.db, id);
				if (resolved === null)
					return yield* Effect.fail(new KitInvalid({ message: `fixture member ${id} is absent` }));
				return resolved;
			});
		const observe = (member: string, conversation: string) =>
			Effect.gen(function* () {
				const frames: Frame[] = [],
					hello = yield* Deferred.make<string>();
				const received = yield* Effect.acquireRelease(Queue.unbounded<Frame>(), Queue.shutdown);
				yield* live.connect(yield* authority(member)).pipe(
					Stream.runForEach((frame) =>
						Effect.gen(function* () {
							frames.push(frame);
							yield* Queue.offer(received, frame);
							if (frame.t === 'hello') yield* Deferred.succeed(hello, frame.conn);
						})
					),
					Effect.forkScoped
				);
				const connection = yield* Deferred.await(hello);
				yield* live.register(connection, 'messages', {
					read: { kind: 'transcript', model: 'sys_message', conversation, thread: false }
				});
				yield* live.register(connection, 'conversations', {
					read: { kind: 'conversations', model: 'sys_conversation', member }
				});
				const rows = <A>(schema: Schema.Decoder<A>, view: string) =>
					frames.flatMap((frame) =>
						frame.t === 'patch' && frame.view === view
							? frame.ops.flatMap((op) =>
									op.op === 'upsert' ? [Schema.decodeUnknownSync(schema)(op.row)] : []
								)
							: []
					);
				const settled = Effect.gen(function* () {
					yield* live.settled;
					const version = yield* live.v;
					while (!frames.some((frame) => frame.t === 'v' && frame.v >= version))
						yield* Queue.take(received);
				});
				return {
					messages: () => rows(AgentRow, 'messages'),
					conversations: () => rows(AgentConversation, 'conversations'),
					settled
				};
			});
		return { t, ai, agent, user, authority, observe, hq, context };
	});
// One workspace for the file, its provider script armed per test: rows of other tests stay, so reads name their own.
const fileScope = Effect.runSync(Scope.make());
afterAll(() => Effect.runPromise(Scope.close(fileScope, Exit.void)));
const sharedAi = cassette();
const shared = Effect.runSync(Effect.cached(build(sharedAi).pipe(Scope.provide(fileScope))));
const setup = (steps: readonly Step[], catalog?: Catalog) =>
	Effect.map(shared, (fixture) => {
		sharedAi.arm(steps, catalog);
		return fixture;
	});
const quotes = (t: Kit, title: string) =>
	t.db.rows(Schema.Struct({ title: Schema.String, created_by: Schema.NullOr(Schema.String) }), {
		text: 'SELECT title, created_by FROM quotes WHERE title = $1',
		params: [title]
	});

describe('in-app turns', () => {
	it.live(
		'the atomic act tool holds native invitations for the administrator and confirms once',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { agent, user, authority, t } = yield* setup([
						use('act', {
							callable: 'sys_invitation.create',
							input: [{ email: 'invited-by-norbius@example.test', team: 'rep' }]
						}),
						say('Invitation created.')
					]);
					const ann = yield* user('invite-admin', { admin: true });
					const bob = yield* user('invite-other', { admin: true });
					const c = yield* agent.start({ owner: ann });
					yield* agent.post({
						conversation: c,
						as: { member: ann },
						text: 'Invite this member to the rep team'
					});
					yield* agent.drain(c);
					const held = (yield* agent.transcript(c)).find((row) => row.state === 'confirm');
					if (held === undefined) throw new Error('Expected invitation approval');
					const invitations = t.db.rows(
						Schema.Struct({ email: Schema.String, invited_by: Schema.String }),
						{
							text: 'SELECT email, invited_by FROM sys_invitation WHERE email = $1',
							params: ['invited-by-norbius@example.test']
						}
					);
					expect(yield* invitations).toEqual([]);
					expect(
						yield* agent
							.confirm(held.id, true, { ...(yield* authority(ann)), agent: { conversation: c } })
							.pipe(Effect.flip)
					).toMatchObject({ _tag: 'AgentRefusal' });
					expect(
						yield* agent.confirm(held.id, true, yield* authority(bob)).pipe(Effect.flip)
					).toMatchObject({ _tag: 'AgentRefusal' });
					yield* agent.confirm(held.id, true, yield* authority(ann));
					expect(yield* invitations).toEqual([
						{ email: 'invited-by-norbius@example.test', invited_by: ann }
					]);
					expect(
						yield* agent.confirm(held.id, true, yield* authority(ann)).pipe(Effect.flip)
					).toMatchObject({ _tag: 'AgentRefusal' });
					expect(yield* invitations).toHaveLength(1);
				})
			)
	);
	it.live(
		'host approvals expire once at the next turn and disappear from the live transcript',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const ai = cassette();
					ai.arm([
						use('request_publish', {}),
						say('Waiting for approval.'),
						say('Previous request rejected.')
					]);
					const pending = new Set<string>();
					let starts = 0;
					const { agent, user } = yield* build(ai, {
						onTurnStart: async () => {
							starts++;
							const ids = [...pending];
							pending.clear();
							return ids;
						},
						hostTools: [
							{
								name: 'request_publish',
								description: 'Fixture publish request',
								input: { type: 'object', properties: {}, additionalProperties: false },
								readOnly: true,
								call: async () => {
									pending.add('request');
									return { approval: { id: 'request' } };
								}
							}
						]
					});
					const ann = yield* user('host-approval', { admin: true });
					const c = yield* agent.start({ owner: ann });
					yield* agent.post({ conversation: c, as: { member: ann }, text: 'Publish' });
					yield* agent.drain(c);
					const held = (yield* agent.transcript(c)).find(
						(row) => transcriptRow(row, true, false)?.tool?.approval === 'request'
					);
					if (held === undefined) throw new Error('Expected a host approval');
					yield* agent.post({ conversation: c, as: { member: ann }, text: 'Start a new turn' });
					yield* agent.drain(c);
					expect(starts).toBe(2);
					expect(pending.size).toBe(0);
					const settled = (yield* agent.transcript(c)).find((row) => row.id === held.id);
					if (settled === undefined) throw new Error('Missing settled tool');
					expect(settled).toMatchObject({ content: { result: { declined: true } } });
					expect(transcriptRow(settled, true, false)?.tool?.approval).toBeUndefined();
				})
			)
	);
	it.live('a background tool answers at once and its result arrives as a system message', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const ai = cassette();
				ai.arm([use('workspace_test', {}), say('Tests are running.'), say('They failed: fixing.')]);
				const finish = yield* Deferred.make<void>();
				const { agent, user } = yield* build(ai, {
					hostTools: [
						{
							name: 'workspace_test',
							description: 'Fixture tests',
							input: { type: 'object', properties: {}, additionalProperties: false },
							readOnly: true,
							call: async () => {
								await Effect.runPromise(Deferred.await(finish));
								return { tests: { failed: 1 }, error: '1 failing: adds up' };
							}
						}
					]
				});
				const ann = yield* user('background', { admin: true });
				const c = yield* agent.start({ owner: ann });
				yield* agent.post({ conversation: c, as: { member: ann }, text: 'Run them' });
				const turn = yield* Effect.forkChild(agent.drain(c));
				while (!(yield* agent.transcript(c)).some((r) => r.role === 'tool' && r.state === null))
					yield* Effect.sleep('5 millis');
				const step = (yield* agent.transcript(c)).find((r) => r.role === 'tool');
				expect(JSON.stringify(step?.content)).toContain('Still running');
				yield* Deferred.succeed(finish, undefined);
				yield* Fiber.join(turn);
				const alert = (yield* agent.transcript(c)).find((r) =>
					r.text?.includes('finished] workspace_test')
				);
				expect(alert).toMatchObject({ role: 'system' });
				// the result itself, not a pointer to it; and red tests are the agent's to fix
				expect(alert?.text).toContain('1 failing: adds up');
				expect(alert?.text).not.toContain('tell the person');
			})
		)
	);
	it.live('a refused read names everything wrong with it at once', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const ai = cassette();
				ai.arm([
					use('read', { request: { quotes: { fields: ['title', 'nope', 'nada'] } } }),
					use('read', {
						request: {
							quotes: { search: 'a', aggregate: { count: true } },
							sys_user: { fields: ['nope'] }
						}
					}),
					say('Done.')
				]);
				const { agent, user } = yield* build(ai);
				const ann = yield* user('refused', { admin: true });
				const c = yield* agent.start({ owner: ann });
				yield* agent.post({ conversation: c, as: { member: ann }, text: 'Read them' });
				yield* agent.drain(c);
				const [fields, roots] = [toolResults(ai.requests[1]!)[0], toolResults(ai.requests[2]!)[1]];
				expect(JSON.stringify(fields)).toContain("no readable fields 'nope', 'nada'");
				expect(JSON.stringify(roots)).toContain('search cannot be combined with aggregate');
				expect(JSON.stringify(roots)).toContain("no readable field 'nope'");
			})
		)
	);
	it.live('each step has a CPU budget of its own, so a long turn is not one long run', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const ai = cassette();
				ai.arm([use('read', { path: 'a' }), use('read', { path: 'b' }), say('Done.')]);
				const { agent, user } = yield* build(ai, {
					hostTools: [
						{
							name: 'read',
							description: 'Fixture read',
							input: { type: 'object' as const, additionalProperties: true },
							readOnly: true,
							call: async () => ({ text: 'x' })
						}
					]
				});
				const ann = yield* user('steps', { admin: true });
				const c = yield* agent.start({ owner: ann });
				yield* agent.post({ conversation: c, as: { member: ann }, text: 'Read two files' });
				let units = 0;
				yield* agent
					.drain(c)
					.pipe(Effect.provideService(RunUnits, { next: () => Effect.sync(() => void units++) }));
				expect(units).toBeGreaterThanOrEqual(3);
			})
		)
	);
	it.live('edit and test rounds that stay red are told to stop, then stopped', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const ai = cassette();
				ai.arm(
					Array.from({ length: 8 }, (_, n) => [
						use('workspace_write', { path: 'tests/a.test.ts', content: `round ${n}` }),
						use('workspace_diagnose', { only: 'tests' })
					]).flat()
				);
				let validations = 0;
				const fixture = (name: string, call: () => Promise<Json>) => ({
					name,
					description: `Fixture ${name}`,
					input: { type: 'object' as const, additionalProperties: true },
					readOnly: true,
					call
				});
				const { agent, user } = yield* build(ai, {
					hostTools: [
						fixture('workspace_write', async () => ({ saved: ['tests/a.test.ts'] })),
						fixture('workspace_diagnose', async () => ({
							error: 'A test failed.',
							rounds: ++validations
						}))
					]
				});
				const ann = yield* user('red-rounds', { admin: true });
				const c = yield* agent.start({ owner: ann });
				yield* agent.post({ conversation: c, as: { member: ann }, text: 'Add the test' });
				yield* agent.drain(c);
				const rows = yield* agent.transcript(c);
				expect(validations).toBe(6);
				expect(rows.filter((r) => r.text?.startsWith('Your last checks'))).toHaveLength(1);
				expect(rows.at(-1)?.text).toContain('the checks kept failing');
			})
		)
	);
	it.live('asks the person and ends the turn instead of guessing', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const ai = cassette();
				ai.arm([
					use('ask', {
						question: 'Which pages should this workspace have?',
						options: ['Dashboard + Reports', 'Something else']
					})
				]);
				const { agent, user } = yield* build(ai);
				const ann = yield* user('asks', { admin: true });
				const c = yield* agent.start({ owner: ann });
				yield* agent.post({ conversation: c, as: { member: ann }, text: 'Build the portfolio' });
				yield* agent.drain(c);
				const rows = yield* agent.transcript(c);
				const last = rows.filter((row) => row.role === 'assistant').at(-1);
				expect(last?.meta).toMatchObject({ tag: 'reply', asked: true });
				expect(last?.text).toContain('Which pages should this workspace have?');
				expect(last?.text).toContain('1. Dashboard + Reports');
				expect(
					rows.some(
						(row) => row.role === 'tool' && JSON.stringify(row.content).includes('"name":"ask"')
					)
				).toBe(true);
			})
		)
	);
	it.live('red checks whose failures keep falling are never stopped', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const ai = cassette();
				ai.arm(
					Array.from({ length: 8 }, (_, n) => [
						use('workspace_write', { path: 'src/a.ts', content: `round ${n}` }),
						use('workspace_diagnose', {})
					]).flat()
				);
				let validations = 0;
				const fixture = (name: string, call: () => Promise<Json>) => ({
					name,
					description: `Fixture ${name}`,
					input: { type: 'object' as const, additionalProperties: true },
					readOnly: true,
					call
				});
				const { agent, user } = yield* build(ai, {
					hostTools: [
						fixture('workspace_write', async () => ({ saved: ['src/a.ts'] })),
						// 65, 60, 55 … still red each round, each a new low
						fixture('workspace_diagnose', async () => ({
							failing: 65 - 5 * validations++,
							types: { total: 65 - 5 * (validations - 1), diagnostics: [] }
						}))
					]
				});
				const ann = yield* user('falling-rounds', { admin: true });
				const c = yield* agent.start({ owner: ann });
				yield* agent.post({ conversation: c, as: { member: ann }, text: 'Fix the types' });
				yield* agent.drain(c);
				const rows = yield* agent.transcript(c);
				expect(validations).toBe(8);
				expect(rows.filter((r) => r.text?.startsWith('Your last checks'))).toHaveLength(0);
				expect(rows.some((r) => r.text?.includes('the checks kept failing'))).toBe(false);
			})
		)
	);
	it.live(
		'an in-app conversation hears each workspace event once at its next step, and the inbox once per member',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const ai = cassette();
					ai.arm([say('Noted.'), say('Still here.'), say('Noted again.')]);
					const published: WorkspaceNote[] = [];
					const { agent, user, t, context } = yield* build(ai, {
						events: async (since) => published.filter((e) => Date.parse(e.at) > Date.parse(since))
					});
					const ann = yield* user('events', { admin: true });
					const c = yield* agent.start({ owner: ann });
					yield* agent.post({ conversation: c, as: { member: ann }, text: 'Hello' });
					const merged = {
						id: 'merged-1',
						at: new Date(Date.now() + 1_000).toISOString(),
						title: 'Ann merged change !3 "Ping"'
					};
					published.push(merged);
					yield* agent.drain(c);
					yield* agent.post({ conversation: c, as: { member: ann }, text: 'Again' });
					yield* agent.drain(c);
					const heard = (yield* agent.transcript(c)).filter((row) => row.meta?.tag === 'event');
					expect(heard.map((row) => row.text)).toEqual([
						`Workspace event (${merged.at}): ${merged.title}`
					]);
					// the first step's request carries it; the next turn's step hears nothing new
					expect(JSON.stringify(ai.requests[0])).toContain('Workspace event (');
					const later = {
						id: 'maintenance-1',
						at: new Date(Date.now() + 2_000).toISOString(),
						title: 'Maintenance at 2026-11-05 03:00 UTC',
						body: 'The workspace may pause briefly.'
					};
					published.push(later);
					yield* agent.post({ conversation: c, as: { member: ann }, text: 'Once more' });
					yield* agent.drain(c);
					expect(
						(yield* agent.transcript(c))
							.filter((row) => row.meta?.tag === 'event')
							.map((row) => row.meta?.tag === 'event' && row.meta.at)
					).toEqual([merged.at, later.at]);
					const ben = yield* user('events-reader');
					yield* announce(published).pipe(Effect.provide(context));
					yield* announce(published).pipe(Effect.provide(context));
					const notices = yield* t.db.rows(
						Schema.Struct({ member: Schema.String, title: Schema.String }),
						{
							text: `SELECT member, title FROM sys_notification WHERE once LIKE 'event:%' AND member IN ($1, $2) ORDER BY at, member`,
							params: [ann, ben]
						}
					);
					expect(notices).toHaveLength(4);
					expect(new Set(notices.map((n) => n.member))).toEqual(new Set([ann, ben]));
				})
			)
	);
	it.live('a write of no rows answers the agent, never a confirmation card', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { agent, user } = yield* setup([
					use('act', { callable: 'sys_invitation.create', input: [] }),
					say('Nothing to do.')
				]);
				const ann = yield* user('empty-act', { admin: true });
				const c = yield* agent.start({ owner: ann });
				yield* agent.post({ conversation: c, as: { member: ann }, text: 'Invite nobody' });
				yield* agent.drain(c);
				const rows = yield* agent.transcript(c);
				expect(rows.some((row) => row.state === 'confirm')).toBe(false);
				expect(rows.at(-1)).toMatchObject({ role: 'assistant', text: 'Nothing to do.' });
			})
		)
	);
	it.live('a new turn rejects an unanswered tool confirmation and refuses a late approval', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { agent, user, authority, t } = yield* setup([
					use('act', { callable: 'automation.quotes_mark', input: { title: 'Never created' } }),
					say('Understood, cancelled.')
				]);
				const ann = yield* user('new-turn', { team: 'rep' });
				const c = yield* agent.start({ owner: ann });
				yield* agent.post({ conversation: c, as: { member: ann }, text: 'Mark this quote' });
				yield* agent.drain(c);
				const held = (yield* agent.transcript(c)).find((row) => row.state === 'confirm');
				if (held === undefined) throw new Error('Expected a confirmation');
				yield* agent.post({ conversation: c, as: { member: ann }, text: 'Start over' });
				yield* agent.drain(c);
				expect((yield* agent.transcript(c)).find((row) => row.id === held.id)).toMatchObject({
					state: null,
					content: { result: { declined: true, reason: 'A new turn started before approval.' } }
				});
				expect(
					yield* agent.confirm(held.id, true, yield* authority(ann)).pipe(Effect.flip)
				).toMatchObject({ _tag: 'AgentRefusal' });
				expect(yield* quotes(t, 'Never created')).toEqual([]);
			})
		)
	);
	it.live(
		'acts as the member, records tool rows, and ends on a reply carrying its receipts (rule 59)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup([
						use('act', { callable: 'quotes.create', input: [{ title: 'Desk' }] }),
						say('Created the Desk quote.')
					]);
					return yield* Effect.gen(function* () {
						const { t, ai, agent, user, observe } = fixture;
						const ann = yield* user('ann', { team: 'rep' });
						const c = yield* agent.start({ owner: ann });
						const published = yield* observe(ann, c);
						yield* agent.post({
							conversation: c,
							as: { member: ann },
							text: 'Make a quote for a desk',
							author: 'Ann'
						});
						const { reply } = yield* agent.drain(c);
						expect(yield* quotes(t, 'Desk')).toEqual([{ title: 'Desk', created_by: ann }]);
						expect(reply?.text).toBe('Created the Desk quote.');
						expect(reply?.meta).toMatchObject({
							tag: 'reply',
							receipts: [{ outcome: 'committed', callable: 'quotes.create' }]
						});
						expect(ai.requests[0]!.messages[0]).toEqual({
							role: 'user',
							content: '[Ann] Make a quote for a desk'
						});
						expect(ai.requests[0]!.system).toContain('Staff brief.');
						expect(ai.requests[0]!.system).not.toContain('Customer brief.');
						expect(toolResults(ai.requests[1]!)[0]).toMatchObject({ kind: 'committed' });
						// the conversation's status reaches the live lane as the turn runs and settles
						yield* published.settled;
						expect(
							published
								.conversations()
								.map((row) => row.status)
								.slice(-2)
						).toEqual(['running', 'idle']);
						// the tool call was a `running` row, then the same row finished (rule 65: each write published as written)
						const tool = published.messages().filter((row) => row.role === 'tool');
						expect(tool.map((row) => row.state)).toEqual(['running', null]);
						expect(new Set(tool.map((x) => x.id)).size).toBe(1);
						expect(tool.at(-1)!.tool).toMatchObject({
							name: 'act',
							args: expect.stringContaining('quotes.create'),
							ms: expect.any(Number)
						});
						expect((yield* agent.conversation(c)).status).toBe('idle');
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live(
		"lists only the MCP servers the actor's capabilities name, every skill to everyone, and calls the MCP tool (rules 58, 63b)",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup([
						use('mcp__hq__echo', { text: 'hi' }),
						say('HQ said hi.'),
						say('Nothing to add.')
					]);
					return yield* Effect.gen(function* () {
						const { ai, agent, user, authority, hq } = fixture;
						const ann = yield* user('ann', { team: 'rep' });
						const bob = yield* user('bob', { team: 'reader' });
						const c = yield* agent.start({ owner: ann });
						yield* agent.post({ conversation: c, as: { member: ann }, text: 'ask hq' });
						yield* agent.drain(c);
						expect(toolNames(ai.requests[0])).toEqual(
							expect.arrayContaining(['read', 'act', 'skill', 'mcp__hq__echo', 'subagent'])
						);
						// an unreachable server is unavailable, never a failed turn
						expect(toolNames(ai.requests[0]).some((n) => n.startsWith('mcp__down__'))).toBe(false);
						expect(toolResults(ai.requests[1]!)[0]).toMatchObject({
							content: [{ type: 'text', text: 'echo: hi' }]
						});
						expect(hq.calls).toContainEqual({ name: 'echo', arguments: { text: 'hi' } });
						const d = yield* agent.start({ owner: bob });
						yield* agent.post({ conversation: d, as: { member: bob }, text: 'anything?' });
						yield* agent.drain(d);
						const names = toolNames(ai.requests[2]);
						// a skill is procedure, not authority: every actor may load every workspace skill
						expect(names).toContain('skill');
						expect(ai.requests[2]?.system).toContain('- pricing: ');
						expect(names.some((n) => n.startsWith('mcp__'))).toBe(false);
						expect(names).not.toContain('act');
						expect({ mcp: mcpServers(manifest, yield* authority(ann)) }).toMatchObject({
							mcp: [{ name: 'hq' }]
						});
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live(
		"compacts past 90% of the catalogue's default model's window; the next call starts from the checkpoint (rule 62)",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup(
						[
							use('history', { query: 'x' }, 'd1', 95),
							say('| Section | Summary |\n|---|---|\n| Goal | g |'),
							say('Done.')
						],
						{
							models: [{ id: 'vendor/small', label: 'Small', context: 100 }],
							default: 'vendor/small'
						}
					);
					return yield* Effect.gen(function* () {
						const { ai, agent, user } = fixture;
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* agent.post({ conversation: c, as: { member: root }, text: 'go' });
						yield* agent.drain(c);
						expect(ai.requests[1]!.system).toBe(COMPACT_FORMAT);
						const after = ai.requests[2]!.messages.map((x) => JSON.stringify(x.content));
						expect(after.some((x) => x.includes('context checkpoint'))).toBe(true);
						expect(after.some((x) => x.includes('d1'))).toBe(false);
						expect(after.some((x) => x.includes('go'))).toBe(true);
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live(
		"every step opens with the step before it, whole: the provider's cached prefix holds",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup([
						use('history', { query: 'x' }, 'd1', 10),
						use('history', { query: 'y' }, 'd2', 20),
						use('history', { query: 'z' }, 'd3', 30),
						say('Done.')
					]);
					return yield* Effect.gen(function* () {
						const { ai, agent, user } = fixture;
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* agent.post({ conversation: c, as: { member: root }, text: 'go' });
						yield* agent.drain(c);
						expect(ai.requests).toHaveLength(4);
						// the state note closes each step's context; all before it never changes once sent
						const sent = ai.requests.map((request) =>
							request.messages
								.filter((m) => !(typeof m.content === 'string' && m.content.startsWith(STATE_NOTE)))
								.map((m) => JSON.stringify(m))
						);
						sent.slice(1).forEach((later, i) => {
							const before = sent[i]!;
							expect(later.length).toBeGreaterThan(before.length);
							expect(later.slice(0, before.length)).toEqual(before);
						});
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live('a large model window is used as the model provides it, without a smaller host cap', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fixture = yield* setup(
					[
						use('history', { query: 'x' }, 'd1', 200_000),
						say('| Section | Summary |\n|---|---|\n| Goal | g |'),
						say('Done.')
					],
					{
						models: [{ id: 'vendor/large', label: 'Large', context: 1_000_000 }],
						default: 'vendor/large'
					}
				);
				return yield* Effect.gen(function* () {
					const { ai, agent, user } = fixture;
					const root = yield* user('root', { admin: true });
					const c = yield* agent.start({ owner: root });
					yield* agent.post({ conversation: c, as: { member: root }, text: 'go' });
					yield* agent.drain(c);
					// 200k is 20% of a 1M window: no checkpoint is forced
					expect(ai.requests[1]!.system).not.toBe(COMPACT_FORMAT);
					const after = ai.requests[1]!.messages.map((x) => JSON.stringify(x.content));
					expect(after.some((x) => x.includes('context checkpoint'))).toBe(false);
				}).pipe(Effect.provide(fixture.context));
			})
		)
	);

	it.live(
		'an external member without an external brief has no agent; a staff brief never reaches them',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup([say('hi')]);
					return yield* Effect.gen(function* () {
						const { ai, agent, user } = fixture;
						const cus = yield* user('cus', { external: true, team: 'reader' });
						const c = yield* agent.start({ owner: cus });
						yield* agent.post({ conversation: c, as: { member: cus }, text: 'hello' });
						yield* agent.drain(c);
						expect(ai.requests[0]!.system).toContain('Customer brief.');
						expect(ai.requests[0]!.system).not.toContain('Staff brief.');
						expect(toolNames(ai.requests[0])).not.toContain('subagent');
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);
});

/** An envoy sender's `as` (P32): the envoy, the instance it arrived on, the linked member if any, and whether it is a DM. */
const envoyAs = (name: string, sender: string, member: string | null, dm: boolean) => ({
	envoy: { name, instance: name === fieldEnvoy ? 'field' : 'desk', sender, member, dm }
});

describe('envoy conversations', () => {
	it.live(
		'a failed turn sends a public sender the fixed reply, never the internal error, and writes an error event (§5.12)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup([
						() =>
							Stream.fail(
								Port.failure('ai')({
									kind: 'upstream',
									message: 'provider key sk-123 rejected',
									status: 401
								})
							)
					]);
					return yield* Effect.gen(function* () {
						const { t, agent } = fixture;
						const c = yield* agent.start({ envoy: salesDeskEnvoy, integration: 'desk' });
						yield* agent.post({
							conversation: c,
							as: envoyAs(salesDeskEnvoy, 'x', null, true),
							text: 'hi'
						});
						const { reply } = yield* agent.drain(c);
						expect(reply?.text).toBe(FIXED.failed);
						expect(JSON.stringify(reply)).not.toContain('sk-123');
						expect(
							t.fakes.logs
								.filter((r) => r.conversation === c && r.event === 'agent.failed')
								.map((r) => r.severity)
						).toEqual(['error']);
						const trace = t.fakes.logs.filter(
							(r) => r.conversation === c && r.event.startsWith('ai.request')
						);
						expect(trace.map((r) => r.event)).toEqual(['ai.request', 'ai.request.finished']);
						expect(trace[1]?.attributes).toMatchObject({ status: 'failed', finish: null });
						expect(JSON.stringify(trace)).not.toContain('sk-123');
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live('stop cancels queued input and ends the turn; resume runs again', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fixture = yield* setup([say('late')]);
				return yield* Effect.gen(function* () {
					const { agent, user, ai } = fixture;
					const root = yield* user('root', { admin: true });
					const c = yield* agent.start({ owner: root });
					yield* agent.post({ conversation: c, as: { member: root }, text: 'one' });
					yield* agent.stop(c);
					expect((yield* agent.drain(c)).ran).toBe(false);
					expect((yield* agent.transcript(c))[0]!.state).toBe('cancelled');
					yield* agent.post({ conversation: c, as: { member: root }, text: 'two' });
					expect((yield* agent.resume(c)).reply?.text).toBe('late');
					expect(ai.requests).toHaveLength(1);
				}).pipe(Effect.provide(fixture.context));
			})
		)
	);
	it.live('a stale Resume cannot reset a turn already restarted by a follow-up', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const fixture = yield* setup([
					(request) =>
						Stream.unwrap(
							Deferred.succeed(started, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
								Effect.as(say('Continued.')(request))
							)
						)
				]);
				return yield* Effect.gen(function* () {
					const { agent, user, ai } = fixture;
					const root = yield* user('root', { admin: true });
					const c = yield* agent.start({ owner: root });
					yield* agent.post({ conversation: c, as: { member: root }, text: 'Continue.' });
					const turn = yield* Effect.forkChild(agent.drain(c));
					yield* Deferred.await(started);
					expect((yield* agent.resume(c)).ran).toBe(false);
					expect((yield* agent.conversation(c)).status).toBe('running');
					yield* Deferred.succeed(release, undefined);
					expect((yield* Fiber.join(turn)).reply?.text).toBe('Continued.');
					expect(ai.requests).toHaveLength(1);
				}).pipe(Effect.provide(fixture.context));
			})
		)
	);
});

describe('durable turns (rule 48)', () => {
	it.live(
		'a dropped chat turn reruns from its saved turns: the next model call sees the whole history',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup([say('first answer'), say('second answer')]);
					return yield* Effect.gen(function* () {
						const { t, ai, agent, user } = fixture;
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* agent.post({ conversation: c, as: { member: root }, text: 'first question' });
						expect((yield* agent.drain(c)).reply?.text).toBe('first answer');
						yield* agent.post({ conversation: c, as: { member: root }, text: 'second question' });
						// the process that claimed the second turn died before its model call
						yield* t.db.write({
							text: `WITH c AS (UPDATE sys_conversation SET status = 'running', lease_until = $2::timestamptz - interval '1 second' WHERE id = $1 RETURNING id)
				INSERT INTO sys_run (id, automation, input, due_at, cause, depth) VALUES (gen_random_uuid()::text, 'agent.turn', jsonb_build_object('conversation', $1::text), $2::timestamptz, 'schedule', 0)`,
							params: [c, t.clock.now()]
						});
						yield* t.runDue();
						expect(ai.requests).toHaveLength(2);
						const history = JSON.stringify(ai.requests[1]!.messages);
						const at = ['first question', 'first answer', 'second question'].map((text) =>
							history.indexOf(text)
						);
						expect(at.every((i) => i >= 0)).toBe(true);
						expect(at).toEqual(at.toSorted((a, b) => a - b));
						expect((yield* agent.transcript(c)).at(-1)).toMatchObject({
							role: 'assistant',
							text: 'second answer'
						});
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);
	it.live(
		'a turn interrupted in a live process (a cutover) lapses its lease and makes its takeover due now',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const started = yield* Deferred.make<void>();
					const fixture = yield* setup([]);
					return yield* Effect.gen(function* () {
						const { t, user } = fixture;
						const root = yield* user('root', { admin: true });
						// a second engine over the same database, its scope closed mid-turn as a cutover closes the old one
						const engine = yield* Scope.make();
						const old = yield* Layer.build(
							TestWorkspace.layer({
								manifest,
								guest: yield* guest,
								ports: cassette([
									() =>
										Stream.unwrap(
											Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
										)
								]).layer,
								now: new Date().toISOString(),
								db: Layer.succeed(TenantDb, Context.get(fixture.context, TenantDb))
							})
						).pipe(Scope.provide(engine));
						const agent = Context.get(old, Agents);
						const c = yield* agent.start({ owner: root });
						yield* agent.post({ conversation: c, as: { member: root }, text: 'Slow question' });
						yield* Effect.forkChild(agent.drain(c));
						yield* Deferred.await(started);
						yield* Scope.close(engine, Exit.void);
						const [state] = yield* t.db.rows(
							Schema.Struct({ lease: Schema.Boolean, due: Schema.Boolean }),
							{
								// without the release both stand a lease (60 s) ahead
								text: `SELECT c.lease_until <= $2::timestamptz + interval '5 seconds' AS lease,
									(SELECT bool_and(due_at <= $2::timestamptz + interval '5 seconds') FROM sys_run WHERE automation = 'agent.turn' AND state = 'queued' AND input->>'conversation' = $1) AS due
									FROM sys_conversation c WHERE c.id = $1`,
								params: [c, new Date().toISOString()]
							}
						);
						expect(state).toEqual({ lease: true, due: true });
						yield* fixture.agent.stop(c);
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);
	it.live('a planned close lets the step finish, holds the turn, and the next engine answers', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>(),
					finish = yield* Deferred.make<void>(),
					parked = yield* Deferred.make<void>();
				const fixture = yield* setup([say('Two quotes.')]);
				return yield* Effect.gen(function* () {
					const { t, ai, user } = fixture;
					const root = yield* user('root', { admin: true });
					const engine = yield* Scope.make();
					const reading = use('read', { request: { quotes: {} } });
					const slow: Step = (request) =>
						Stream.unwrap(
							Deferred.succeed(started, undefined).pipe(
								Effect.andThen(Deferred.await(finish)),
								Effect.as(reading(request))
							)
						);
					const script = cassette([slow, say('Never reached.')]);
					const old = yield* Layer.build(
						TestWorkspace.layer({
							manifest,
							guest: yield* guest,
							ports: script.layer,
							now: new Date().toISOString(),
							db: Layer.succeed(TenantDb, Context.get(fixture.context, TenantDb))
						})
					).pipe(Scope.provide(engine));
					const agent = Context.get(old, Agents);
					const c = yield* agent.start({ owner: root });
					yield* agent.post({ conversation: c, as: { member: root }, text: 'How many quotes?' });
					yield* Effect.forkChild(agent.drain(c));
					yield* Deferred.await(started);
					yield* agent.park.pipe(
						Effect.andThen(Deferred.succeed(parked, undefined)),
						Effect.forkChild
					);
					yield* Effect.yieldNow;
					// the model call in flight is the step: the park waits for it
					expect(yield* Deferred.isDone(parked)).toBe(false);
					yield* Deferred.succeed(finish, undefined);
					yield* Deferred.await(parked);
					const held = yield* agent.transcript(c);
					expect(held.filter((row) => row.role === 'tool')).toHaveLength(1);
					expect(held.some((row) => row.meta?.tag === 'reply')).toBe(false);
					expect(script.requests).toHaveLength(1);
					yield* Scope.close(engine, Exit.void);
					t.clock.set(new Date().toISOString());
					yield* t.runDue();
					expect(ai.requests).toHaveLength(1);
					const rows = yield* fixture.agent.transcript(c);
					expect(rows.at(-1)).toMatchObject({ role: 'assistant', text: 'Two quotes.' });
					// nothing was cut: no step reads as interrupted
					expect(rows.filter((row) => row.meta?.tag === 'cut')).toEqual([]);
				}).pipe(Effect.provide(fixture.context));
			})
		)
	);
	it.live(
		'a turn cut mid-work is resumed with the open request named last, and ends with the answer',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup([
						use('read', { request: { quotes: {} } }),
						say('interim'),
						say('Two quotes.')
					]);
					return yield* Effect.gen(function* () {
						const { t, ai, agent, user } = fixture;
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* agent.post({ conversation: c, as: { member: root }, text: 'How many quotes?' });
						yield* agent.drain(c);
						// the process died while its step was still streaming: the reply row is left as a cut
						yield* t.db.write({
							text: `WITH m AS (UPDATE sys_message SET text = '', content = '{"text":"","toolCalls":[]}'::jsonb, meta = '{"tag":"cut"}'::jsonb
								WHERE id = (SELECT id FROM sys_message WHERE conversation = $1 ORDER BY seq DESC LIMIT 1) RETURNING id),
							c AS (UPDATE sys_conversation SET status = 'running', lease_until = $2::timestamptz - interval '1 second' WHERE id = $1 RETURNING id)
							INSERT INTO sys_run (id, automation, input, due_at, cause, depth) VALUES (gen_random_uuid()::text, 'agent.turn', jsonb_build_object('conversation', $1::text), $2::timestamptz, 'schedule', 0)`,
							params: [c, t.clock.now()]
						});
						yield* t.runDue();
						expect(ai.requests).toHaveLength(3);
						const closing = ai.requests[2]!.messages.filter(
							(message) => message.role === 'user'
						).map((message) => JSON.stringify(message.content));
						// the resumed step's last word before the state note is the open request, not the model's own cut row
						expect(closing.at(-2)).toContain('has resumed');
						expect(closing.at(-2)).toContain('How many quotes?');
						expect(ai.requests[2]!.messages.at(-1)?.role).toBe('user');
						expect((yield* agent.transcript(c)).at(-1)).toMatchObject({
							role: 'assistant',
							text: 'Two quotes.'
						});
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);
	it.live('a resumed step does not repeat a call the dead generation left running', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const input = { request: { quotes: {} } };
				const fixture = yield* setup([]);
				return yield* Effect.gen(function* () {
					const { t, ai, agent, user } = fixture;
					const root = yield* user('root', { admin: true });
					const c = yield* agent.start({ owner: root });
					// the dead generation consumed the request and ran the call, then died before its result was recorded
					yield* t.db.write({
						text: `INSERT INTO sys_message (id, conversation, role, content, text, seq, state, mode, "as")
							VALUES
								('dead-question', $1, 'user', '{"text":"How many quotes?"}'::jsonb, 'How many quotes?', 1, 'consumed', 'agent', $3::jsonb),
								('dead-call', $1, 'tool', jsonb_build_object('id', 'dead-call', 'name', 'read', 'args', $2::text), '', 2, 'running', NULL, NULL)`,
						params: [c, JSON.stringify(input), JSON.stringify({ member: root })]
					});
					yield* t.db.write({
						text: `UPDATE sys_conversation SET status = 'running', lease_until = $2::timestamptz - interval '1 second' WHERE id = $1`,
						params: [c, t.clock.now()]
					});
					yield* t.db.write({
						text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth)
							VALUES (gen_random_uuid()::text, 'agent.turn', jsonb_build_object('conversation', $1::text), $2::timestamptz, 'schedule', 0)`,
						params: [c, t.clock.now()]
					});
					// the resumed step repeats the same call, then answers
					const call = randomUUID();
					fixture.ai.arm([use('read', input, call), say('Two quotes.')]);
					yield* t.runDue();
					const rows = yield* agent.transcript(c);
					const tool = rows.filter((row) => row.role === 'tool');
					// the call is on the transcript twice: the one that may have landed, and the one not run again
					expect(tool).toHaveLength(2);
					expect(tool[1]?.content).toMatchObject({
						id: call,
						name: 'read',
						result: { error: expect.stringContaining('may have taken effect') }
					});
					// two steps: the resumed one (its call skipped) and the answer
					expect(ai.requests).toHaveLength(2);
				}).pipe(Effect.provide(fixture.context));
			})
		)
	);
});

// The colour-ingest probe (2026-10-29): an administrator in no team; the form names a person. Before, the agent described
// each model (one call each), could not read sys_user and spent 17 calls over three turns searching the source for a
// name, then copied another record's owner. Now the schema is in the prompt and the directory is one read away.
describe('a replayed ingest takes its fewest calls', () => {
	it.live(
		"an administrator's first step reads the people and records it needs in one call, from the schema in its prompt",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup([
						use('read', {
							request: {
								sys_user: { where: { name: { like: '%Poa%' } }, fields: ['id', 'name', 'team'] },
								quotes: { where: { title: { like: 'Dyson%' } }, fields: ['id', 'title', 'region'] }
							}
						}),
						use('act', { callable: 'quotes.create', input: [{ title: 'Dyson P8-321-NH' }] }),
						say('Opened the Dyson enquiry; Poa is the sales person on the form.')
					]);
					return yield* Effect.gen(function* () {
						const { ai, agent, user } = fixture;
						const root = yield* user('root', { admin: true }),
							poa = yield* user('Poa', { team: 'rep' });
						const c = yield* agent.start({ owner: root });
						yield* agent.post({
							conversation: c,
							as: { member: root },
							text: 'Set up the Dyson form; the sales person is Poa.'
						});
						yield* agent.drain(c);
						expect(ai.requests).toHaveLength(3);
						const prompt = ai.requests[0]!.system ?? '';
						expect(prompt).toContain('# Models you read\nsys_user, quotes');
						expect(toolResults(ai.requests[1]!)[0]).toMatchObject({
							sys_user: { rows: [{ id: poa, name: 'Poa', team: 'rep' }] },
							quotes: { rows: [] }
						});
						expect(toolResults(ai.requests[2]!).at(-1)).toMatchObject({ kind: 'committed' });
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);
});
// An automation the agent starts is a job, like an ingest: `act` answers at once with { job, run }; the run's end steers
// the next step once (`RunEnds`, never a poll), wakes the conversation after the turn, and `wait` collects it instead.
describe('an agent-started automation run is a job', () => {
	/** The conversation's turn replies, read between macrotasks until there are `n` (the kit's clock does not run). */
	const replies = (t: Kit, c: string, n: number) =>
		Effect.gen(function* () {
			const read = t.db.rows(Schema.Struct({ text: Schema.NullOr(Schema.String) }), {
				text: `SELECT text FROM sys_message WHERE conversation = $1 AND role = 'assistant' AND meta->>'tag' = 'reply' ORDER BY seq`,
				params: [c]
			});
			let got = yield* read;
			for (let i = 0; got.length < n && i < 20_000; i++) {
				yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
				got = yield* read;
			}
			return got;
		});
	const notes = (r: AiRequest | undefined) =>
		(r?.messages ?? []).flatMap((m) =>
			typeof m.content === 'string' && m.content.includes('[job ') ? [m.content] : []
		);
	const started = (fail: boolean) =>
		Effect.gen(function* () {
			const fixture = yield* setup([
				use('act', { callable: 'automation.quotes_tally', input: { title: 'Desk', fail } }),
				say('Started the tally.')
			]);
			const { agent, user, ai } = fixture;
			const root = yield* user('root', { admin: true });
			const c = yield* agent.start({ owner: root });
			yield* agent.post({ conversation: c, as: { member: root }, text: 'Tally the desk quotes.' });
			const { reply } = yield* agent.drain(c);
			expect(reply?.text).toBe('Started the tally.');
			const answer = toolResults(ai.requests[1]!)[0];
			expect(answer).toMatchObject({
				job: expect.any(String),
				run: expect.any(String),
				note: expect.stringContaining('Its end arrives by itself')
			});
			const { job, run } = Schema.decodeUnknownSync(
				Schema.Struct({ job: Schema.String, run: Schema.String })
			)(answer);
			return { fixture, c, job, run };
		});
	it.live(
		'returns a job at once; its end after the turn wakes the conversation with one line',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { fixture, c, job, run } = yield* started(false);
					return yield* Effect.gen(function* () {
						const { t, ai } = fixture;
						// the run has not run: the turn ended with it queued
						expect(notes(ai.requests[1])).toEqual([]);
						sharedAi.arm([say('The tally is in.')]);
						// the act stamped its run at the wall clock; the shared kit's clock started with the file
						t.clock.set(new Date().toISOString());
						yield* t.runDue();
						const got = yield* replies(t, c, 2);
						expect(got.at(-1)?.text).toBe('The tally is in.');
						expect(ai.requests).toHaveLength(1);
						expect(notes(ai.requests[0])).toEqual([
							`[note]\n[job ${job} done] automation quotes_tally run ${run} → succeeded: "Desk"`
						]);
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);
	it.live('a failed run reports failed', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { fixture, c, job } = yield* started(true);
				return yield* Effect.gen(function* () {
					const { t, ai } = fixture;
					sharedAi.arm([say('The tally failed.')]);
					// the act stamped its run at the wall clock; the shared kit's clock started with the file
					t.clock.set(new Date().toISOString());
					yield* t.runDue();
					yield* replies(t, c, 2);
					expect(notes(ai.requests[0])).toEqual([
						expect.stringMatching(
							new RegExp(
								`^\\[note\\]\\n\\[job ${job} failed\\] automation quotes_tally: .*no tally for Desk.*; tell the person$`
							)
						)
					]);
				}).pipe(Effect.provide(fixture.context));
			})
		)
	);
	it.live('its end during the turn steers the next step with one line', () =>
		Effect.scoped(
			Effect.gen(function* () {
				let open = () => {};
				const gate = new Promise<void>((resolve) => (open = resolve));
				// the second step answers once the run has ended, so the third step's input carries its line
				const held: Step = (request) =>
					Stream.unwrap(
						Effect.promise(() => gate).pipe(
							Effect.as(
								use('read', { request: { quotes: { where: { title: { eq: 'Lamp' } } } } })(request)
							)
						)
					);
				const fixture = yield* setup([
					use('act', { callable: 'automation.quotes_tally', input: { title: 'Lamp' } }),
					held,
					say('Lamp tallied.')
				]);
				return yield* Effect.gen(function* () {
					const { t, ai, agent, user } = fixture;
					const root = yield* user('root', { admin: true });
					const c = yield* agent.start({ owner: root });
					yield* agent.post({ conversation: c, as: { member: root }, text: 'Tally the lamps.' });
					const turn = yield* Effect.forkChild(agent.drain(c));
					const queued = t.db.rows(Schema.Struct({ id: Schema.String }), {
						text: `SELECT id FROM sys_run WHERE automation = 'quotes_tally' AND input->>'title' = 'Lamp'`,
						params: []
					});
					let rows = yield* queued;
					for (let i = 0; rows.length === 0 && i < 20_000; i++) {
						yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
						rows = yield* queued;
					}
					t.clock.set(new Date().toISOString());
					yield* t.runDue();
					open();
					expect((yield* Fiber.join(turn)).reply?.text).toBe('Lamp tallied.');
					const { job } = Schema.decodeUnknownSync(Schema.Struct({ job: Schema.String }))(
						toolResults(ai.requests[1]!)[0]
					);
					expect(ai.requests.map(notes)).toEqual([
						[],
						[],
						[
							`[note]\n[job ${job} done] automation quotes_tally run ${rows[0]!.id} → succeeded: "Lamp"`
						]
					]);
					// the line is the step's transcript note, never also queued to wake the conversation
					const [line] = (yield* t.db.read([
						{
							text: `SELECT count(*)::int AS n, count(*) FILTER (WHERE state = 'queued')::int AS queued FROM sys_message WHERE conversation = $1 AND text LIKE '[job %'`,
							params: [c]
						}
					]))[0]!.rows;
					expect(line).toEqual({ n: 1, queued: 0 });
				}).pipe(Effect.provide(fixture.context));
			})
		)
	);
	it.live('wait collects the job: no line follows', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const waitOnJob: Step = (request) =>
					answer({
						content: '',
						toolCalls: [
							{
								id: randomUUID(),
								name: 'wait',
								input: {
									jobs: [
										Schema.decodeUnknownSync(Schema.Struct({ job: Schema.String }))(
											toolResults(request).at(-1)
										).job
									]
								}
							}
						],
						finish: 'tool',
						usage: { input: 10, output: 5 }
					});
				const fixture = yield* setup([
					use('act', { callable: 'automation.quotes_tally', input: { title: 'Chair' } }),
					waitOnJob,
					say('Chair tallied.')
				]);
				return yield* Effect.gen(function* () {
					const { t, ai, agent, user } = fixture;
					const root = yield* user('root', { admin: true });
					const c = yield* agent.start({ owner: root });
					yield* agent.post({ conversation: c, as: { member: root }, text: 'Tally the chairs.' });
					const turn = yield* Effect.forkChild(agent.drain(c));
					// the run is queued once act answered: run it while the turn waits on its job
					const queued = t.db.rows(Schema.Struct({ id: Schema.String }), {
						text: `SELECT id FROM sys_run WHERE automation = 'quotes_tally' AND input->>'title' = 'Chair'`,
						params: []
					});
					let rows = yield* queued;
					for (let i = 0; rows.length === 0 && i < 20_000; i++) {
						yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
						rows = yield* queued;
					}
					// the act stamped its run at the wall clock; the shared kit's clock started with the file
					t.clock.set(new Date().toISOString());
					yield* t.runDue();
					expect((yield* Fiber.join(turn)).reply?.text).toBe('Chair tallied.');
					expect(toolResults(ai.requests[2]!).at(-1)).toMatchObject({
						settled: { result: { status: 'succeeded', result: 'Chair' } }
					});
					expect(ai.requests.flatMap(notes)).toEqual([]);
					const [queuedNotes] = (yield* t.db.read([
						{
							text: `SELECT count(*)::int AS n FROM sys_message WHERE conversation = $1 AND text LIKE '[job %'`,
							params: [c]
						}
					]))[0]!.rows;
					expect(queuedNotes).toEqual({ n: 0 });
				}).pipe(Effect.provide(fixture.context));
			})
		)
	);
});
// Plan 12's replay of the tender ingest: read_file parses past its inline wall as a job, the turn ends, the job's end wakes
// the conversation with its steering message once, and the agent reads a window, files the line and reads it back.
describe('a replayed ingest: job, steering message, windows, act, read-back', () => {
	it.live(
		'the finished job wakes the conversation once; the model reads windows, never a raw PDF',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const ai = cassette();
					const fixture = yield* build(ai, { hostInlineMs: 1 });
					return yield* Effect.gen(function* () {
						const { agent, user, t } = fixture;
						const root = yield* user('root', { admin: true });
						const files = yield* Files;
						const bytes = new TextEncoder().encode(`%PDF-1.7 tender ${randomUUID()}`);
						const blob = yield* files.put(bytes, { name: 'tender.pdf', mime: 'application/pdf' });
						const file = { id: randomUUID(), name: 'tender.pdf', mime: 'application/pdf' };
						yield* t.db.write({
							text: `INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,'sys_conversation.inputs',$7,now())`,
							params: [file.id, file.name, file.mime, bytes.byteLength, blob.key, blob.sha256, root]
						});
						let open = () => {};
						ingestGate = new Promise<void>((resolve) => (open = resolve));
						ai.arm([
							use('read_file', { id: file.id }),
							say('Reading the tender; I file its lines when it is read.'),
							// the wake-up turn, opened by the job's message
							use('read_file', { id: 'o1', from: 5, to: 6 }),
							use('act', { callable: 'quotes.create', input: [{ title: 'Lot 7 at 12.50' }] }),
							use('read', {
								request: { quotes: { where: { title: { eq: 'Lot 7 at 12.50' } } } }
							}),
							say('Filed Lot 7 at 12.50 and read it back against the table.')
						]);
						const c = yield* agent.start({ owner: root });
						yield* agent.post({
							conversation: c,
							as: { member: root },
							text: 'File the pricing lines of this tender.',
							files: [file]
						});
						const turn = yield* Effect.forkChild(agent.drain(c));
						// the parse holds at its gate: the kit's clock passes the inline wall
						for (let n = 0; ai.requests.length < 2 && n < 20_000; n++) {
							t.clock.advance('1s');
							yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
						}
						const { reply } = yield* Fiber.join(turn);
						expect(reply?.text).toBe('Reading the tender; I file its lines when it is read.');
						expect(toolResults(ai.requests[1]!)[0]).toEqual({
							reading: 'tender.pdf',
							job: expect.any(String),
							note: expect.stringContaining('wait { jobs:')
						});
						open();
						// the job's end queues its message and kicks the conversation: a turn runs on it
						// the kit's clock does not run: the woken turn's reply row is the event, read between macrotasks
						const replies = t.db.rows(Schema.Struct({ text: Schema.NullOr(Schema.String) }), {
							text: `SELECT text FROM sys_message WHERE conversation = $1 AND role = 'assistant' AND meta->>'tag' = 'reply' ORDER BY seq`,
							params: [c]
						});
						let got = yield* replies;
						for (let n = 0; got.length < 2 && n < 20_000; n++) {
							yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
							got = yield* replies;
						}
						expect(got.at(-1)?.text).toBe(
							'Filed Lot 7 at 12.50 and read it back against the table.'
						);
						expect(ai.requests).toHaveLength(6);
						const steering = (r: AiRequest) =>
							r.messages.filter(
								(m) => typeof m.content === 'string' && m.content.includes('] ingest of tender.pdf')
							);
						expect(steering(ai.requests[2]!)).toEqual([
							{
								role: 'user',
								content: expect.stringMatching(
									/^\[note\]\n\[job \w+ done\] ingest of tender\.pdf: read_file \{ id: o1 \} "tender\.pdf \(ingested\)"\n {2}9 lines · 1 images · 1 tables\n {2}Map: L1–9 Cover \(Pricing L3–9\)$/
								)
							}
						]);
						// sent exactly once: later steps carry it as history, never a second copy
						expect(steering(ai.requests[5]!)).toHaveLength(1);
						expect(toolResults(ai.requests[3]!).at(-1)).toMatchObject({
							lines: [
								'4: <table>',
								'5: <tr><td>Lot</td><td>Rate</td></tr>',
								'6: <tr><td>7</td><td>12.50</td></tr>',
								'7: </table>'
							]
						});
						expect(yield* quotes(t, 'Lot 7 at 12.50')).toEqual([
							{ title: 'Lot 7 at 12.50', created_by: root }
						]);
						expect(JSON.stringify(toolResults(ai.requests[5]!).at(-1))).toContain('Lot 7 at 12.50');
						for (const r of ai.requests)
							expect((r.files ?? []).every((f) => f.mime !== 'application/pdf')).toBe(true);
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);
});
describe('the tools a workspace declares', () => {
	it.live('are appended below the transcript, and the turn goes on to answer', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const ai = cassette();
				ai.arm([say('Done.')]);
				const { agent, user, context } = yield* build(
					ai,
					{},
					{ plans: { description: 'Reads a plan.' } }
				);
				return yield* Effect.gen(function* () {
					const root = yield* user('root', { admin: true });
					const c = yield* agent.start({ owner: root });
					yield* agent.post({ conversation: c, as: { member: root }, text: 'A plan?' });
					yield* agent.drain(c);
					const [request] = ai.requests;
					expect(request?.messages.at(-1)?.role).toBe('user');
					expect(JSON.stringify(request?.messages)).toContain('plans(): Reads a plan.');
					expect(JSON.stringify(request?.system)).not.toContain('Reads a plan.');
					expect(ai.requests).toHaveLength(1);
				}).pipe(Effect.provide(context));
			})
		)
	);
});

describe('a tool answer with binary text', () => {
	it.live('stays in the transcript: PostgreSQL holds no NUL, and the turn goes on', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fixture = yield* setup([
					use('run_js', { code: "return 'AC1021\\0\\0';" }),
					say('Read.')
				]);
				return yield* Effect.gen(function* () {
					const { agent, user } = fixture;
					const root = yield* user('root', { admin: true });
					const c = yield* agent.start({ owner: root });
					yield* agent.post({ conversation: c, as: { member: root }, text: 'Its header?' });
					yield* agent.drain(c);
					expect(JSON.stringify(fixture.ai.requests[1]?.messages)).toContain('AC1021\ufffd');
				}).pipe(Effect.provide(fixture.context));
			})
		)
	);
});

describe('a tool answer that stops short says where the rest is', () => {
	const notes = (request: AiRequest | undefined) =>
		JSON.stringify((request?.messages ?? []).filter((message) => message.role === 'user'));
	it.live("a read page with a next cursor: the step's note names read again with after", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const titles = ['Paged one', 'Paged two', 'Paged three'];
				const fixture = yield* setup([
					use('act', { callable: 'quotes.create', input: titles.map((title) => ({ title })) }),
					use('read', {
						request: { quotes: { where: { title: { like: 'Paged %' } }, limit: 2 } }
					}),
					say('Three.')
				]);
				return yield* Effect.gen(function* () {
					const { ai, agent, user } = fixture;
					const root = yield* user('root', { admin: true });
					const c = yield* agent.start({ owner: root });
					yield* agent.post({ conversation: c, as: { member: root }, text: 'Paged quotes?' });
					yield* agent.drain(c);
					expect(notes(ai.requests[1])).not.toContain('stopped short');
					expect(notes(ai.requests[2])).toContain(
						'more \\"quotes\\" rows follow the 2 shown of 3; the rest: call read again with the same \\"quotes\\" options and \\"after\\":'
					);
				}).pipe(Effect.provide(fixture.context));
			})
		)
	);
	it.live("a result past the bound: the step's note names read_file with its call id", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fixture = yield* setup([
					use('act', {
						callable: 'quotes.create',
						input: [{ title: `Long ${'x'.repeat(BOUNDS.cellBytes + 1_000)}` }]
					}),
					use(
						'read',
						{ request: { quotes: { where: { title: { like: 'Long %' } } } } },
						'long-read'
					),
					say('One.')
				]);
				return yield* Effect.gen(function* () {
					const { ai, agent, user } = fixture;
					const root = yield* user('root', { admin: true });
					const c = yield* agent.start({ owner: root });
					yield* agent.post({ conversation: c, as: { member: root }, text: 'Long quotes?' });
					yield* agent.drain(c);
					expect(notes(ai.requests[2])).toContain("read (call 'long-read')");
					expect(notes(ai.requests[2])).toContain('read_file { call, offset } reads the rest');
				}).pipe(Effect.provide(fixture.context));
			})
		)
	);
	it.live(
		'read_file with an unknown call falls back to the latest clipped result, with a note',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup([
						use('act', {
							callable: 'quotes.create',
							input: [{ title: `Long ${'x'.repeat(BOUNDS.cellBytes + 1_000)}` }]
						}),
						use(
							'read',
							{ request: { quotes: { where: { title: { like: 'Long %' } } } } },
							'long-read'
						),
						use('read_file', { call: 'not-a-call', offset: 0 }, 'read-more'),
						say('One.')
					]);
					return yield* Effect.gen(function* () {
						const { ai, agent, user } = fixture;
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* agent.post({ conversation: c, as: { member: root }, text: 'Long quotes?' });
						yield* agent.drain(c);
						expect(toolResults(ai.requests[3]!).at(-1)).toMatchObject({
							note: expect.stringContaining('this is the latest clipped result')
						});
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);
	it.live('a call that failed repeatedly runs again after another call worked', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const bad = { request: { nope: { limit: 1 } } };
				const fixture = yield* setup([
					use('read', bad, 'bad-1'),
					use('read', bad, 'bad-2'),
					use('read', bad, 'bad-3'),
					use('read', { request: { quotes: { limit: 1 } } }, 'good'),
					use('read', bad, 'bad-4'),
					say('One.')
				]);
				return yield* Effect.gen(function* () {
					const { ai, agent, user } = fixture;
					const root = yield* user('root', { admin: true });
					const c = yield* agent.start({ owner: root });
					yield* agent.post({ conversation: c, as: { member: root }, text: 'Quotes?' });
					yield* agent.drain(c);
					const last = toolResults(ai.requests[5]!).at(-1) as { error?: string };
					expect(last.error).toBeDefined();
					expect(last.error).not.toContain('Not run');
				}).pipe(Effect.provide(fixture.context));
			})
		)
	);
	it('paged tools and a tool that cut its own answer: one line each naming the call that reads on', () => {
		expect(rest('runs', 'r1', { runs: [], next: '["t","id"]' })).toEqual([
			`runs (call 'r1'): more follows; the rest: call runs again with the same arguments and cursor: "[\\"t\\",\\"id\\"]"`
		]);
		expect(rest('logs', 'l1', { entries: [], next: 'e9' })[0]).toContain('cursor: "e9"');
		expect(rest('read_file', 'o1', { text: '…', next: 1200 })[0]).toContain('offset: 1200');
		expect(rest('browser', 'b1', { text: '…', next: 300 })[0]).toContain('from: 300');
		expect(
			rest('read_file', 'f1', {
				text: '…',
				truncated: 'only the first 65536 of 70000 characters are shown'
			})
		).toEqual([`read_file (call 'f1'): only the first 65536 of 70000 characters are shown`]);
		expect(rest('runs', 'r2', { runs: [] })).toEqual([]);
		expect(rest('read', 'q1', { quotes: { rows: [] } })).toEqual([]);
		expect(
			rest('read', 'q2', { quotes: { rows: [{ id: 'a' }], next: 'c', total: 1284 } })[0]
		).toContain('more "quotes" rows follow the 1 shown of 1284');
	});
	it('the repeat guards compare the normalised call: invisible characters, compatibility forms and key order aside', () => {
		const call = callKey('read', { quotes: { fields: ['title'], limit: 5 } });
		expect(callKey('read', { quotes: { limit: 5, fields: ['ti\u200btle'] } })).toBe(call);
		expect(callKey('read', { 'quo\u2060tes': { fields: ['\ufeffti\u00adtle'], limit: 5 } })).toBe(
			call
		);
		expect(callKey('read', { quotes: { fields: ['ｔｉｔｌｅ'], limit: 5 } })).toBe(call);
		expect(callKey('read', { quotes: { fields: ['title'], limit: 6 } })).not.toBe(call);
		expect(callKey('act', { quotes: { fields: ['title'], limit: 5 } })).not.toBe(call);
	});
});

describe('a turn never settles silently', () => {
	const visible = (rows: readonly MessageRow[]) =>
		rows.filter(
			(r) =>
				r.role === 'assistant' &&
				(r.text ?? '').trim() !== '' &&
				r.content !== null &&
				(!Predicate.isObject(r.content) ||
					!Array.isArray(r.content.toolCalls) ||
					r.content.toolCalls.length === 0)
		);

	it.live(
		'a tool call whose arguments did not parse is answered with the parse error and the turn goes on',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const garbled: Step = () =>
						answer({
							content: '',
							toolCalls: [
								{
									id: 'g1',
									name: 'read',
									input: {},
									invalid: 'Expected double-quoted property name in JSON at position 12'
								}
							],
							finish: 'tool',
							usage: { input: 1, output: 1 }
						});
					const fixture = yield* setup([garbled, say('Fixed it.')]);
					return yield* Effect.gen(function* () {
						const { ai, agent, user } = fixture;
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* agent.post({ conversation: c, as: { member: root }, text: 'How many quotes?' });
						yield* agent.drain(c);
						expect(toolResults(ai.requests[1]!)[0]).toEqual({
							error: expect.stringContaining('not valid JSON (Expected double-quoted')
						});
						expect(visible(yield* agent.transcript(c))).toEqual([
							expect.objectContaining({ text: 'Fixed it.' })
						]);
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);
});

describe('metering (L-BOLT-432, L-BOLT-547)', () => {
	const events = (t: Kit, conversation: string) =>
		Effect.sync(() =>
			t.fakes.logs
				.filter((r) => r.event === 'ai.call' && r.conversation === conversation)
				.map(({ severity, attributes }) => ({ severity, attributes }))
		);
	it.live(
		'every provider call is one observation: a charge above the $5 gauge is flagged and the turn goes on; a missing charge is marked for attention; the reply names its model',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const pricey: Step = () => {
						expect(fixture.t.fakes.logs.some((row) => row.event === 'ai.request')).toBe(true);
						return answer({
							content: '',
							toolCalls: [{ id: 'd1', name: 'history', input: { query: 'x' } }],
							finish: 'tool',
							usage: { input: 3, output: 1, cost: 6, call: 'gen-1' }
						});
					};
					const unpriced: Step = () =>
						answer({
							content: 'Done.',
							toolCalls: [],
							finish: 'stop',
							usage: { input: 3, output: 1 }
						});
					const fixture = yield* setup([pricey, unpriced]);
					return yield* Effect.gen(function* () {
						const { t, agent, user, ai } = fixture;
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* agent.post({ conversation: c, as: { member: root }, text: 'go' });
						const { reply } = yield* agent.drain(c);
						expect(reply?.text).toBe('Done.');
						expect(ai.requests).toHaveLength(2);
						expect(ai.requests.every((request) => request.purpose === 'chat')).toBe(true);
						expect(reply?.meta).toMatchObject({ usage: { calls: 2, cost: 6, model: 'default' } });
						const trace = t.fakes.logs.filter(
							(row) => row.conversation === c && row.event.startsWith('ai.request')
						);
						expect(trace.map((row) => row.event)).toEqual([
							'ai.request',
							'ai.request.finished',
							'ai.request',
							'ai.request.finished'
						]);
						const calls = yield* events(t, c);
						const requestOf = Schema.decodeUnknownSync(Schema.Struct({ request: Schema.String }));
						for (const [index, request] of ai.requests.entries()) {
							const prepared = trace[index * 2]?.attributes;
							expect(prepared).toMatchObject({
								phase: 'prepared',
								evidence: requestEvidence(request)
							});
							expect(trace[index * 2 + 1]?.attributes).toMatchObject({
								request: requestOf(prepared).request,
								status: 'answered',
								finish: index === 0 ? 'tool' : 'stop'
							});
							expect(requestOf(calls[index]?.attributes).request).toBe(requestOf(prepared).request);
						}
						expect(requestOf(trace[0]?.attributes).request).not.toBe(
							requestOf(trace[2]?.attributes).request
						);
						expect(JSON.stringify(trace)).not.toContain('Staff brief.');
						// the request's size in characters, per part
						const prompt = {
							system: expect.any(Number),
							messages: expect.any(Number),
							tools: expect.any(Number)
						};
						const memory = {
							rssMiB: expect.any(Number),
							heapUsedMiB: expect.any(Number),
							heapTotalMiB: expect.any(Number),
							externalMiB: expect.any(Number)
						};
						expect(yield* events(t, c)).toEqual([
							{
								severity: 'warn',
								attributes: {
									category: 'chat',
									request: expect.any(String),
									call: 'gen-1',
									model: 'default',
									input: 3,
									output: 1,
									cost: 6,
									cached: null,
									reasoning: null,
									prompt,
									settlement: 'pending',
									gauge: 5,
									...memory
								}
							},
							{
								severity: 'warn',
								attributes: {
									category: 'chat',
									request: expect.any(String),
									call: null,
									model: 'default',
									input: 3,
									output: 1,
									cost: null,
									cached: null,
									reasoning: null,
									prompt,
									settlement: 'attention',
									...memory
								}
							}
						]);
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);
});
