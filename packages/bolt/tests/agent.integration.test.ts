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
import type { AiRequest, AiResponse } from '../src/engine/contracts.ts';
import { FIXED } from '../src/engine/agent/index.ts';
import { COMPACT_FORMAT } from '../src/engine/agent/context.ts';
import type { MessageRow } from '../src/engine/agent/schema.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Port, type PortFailure } from '../src/engine/port.ts';
import { Ai, Mcp, type AiEvent } from '../src/engine/ports.ts';
import { mcpPort } from '../src/node/mcp.ts';
import { Agents, Live } from '../src/engine/services.ts';
import { AgentConversation, AgentRow, type Frame } from '../src/protocol/schema.ts';
import { KitInvalid, TestWorkspace, respondSystem1, type Kit } from '../src/test/effect.ts';
import { program } from '../src/test/guest.ts';

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
			read: { quotes: { fields: 'all' } },
			create: { columns: { quotes: ['title', 'region'] } },
			update: { columns: { quotes: ['title', 'region'] } },
			delete: {}
		}
	},
	policies: {
		narrow: {
			description: 'Titles only',
			grants: { quotes: { read: { quotes: { fields: ['title'] } } } }
		},
		rep: {
			description: 'Rep',
			grants: { quotes: { read: true, create: true, update: true } },
			automations: ['quotes_mark'],
			capabilities: { mcp: ['hq'], skills: ['pricing'] }
		},
		reader: { description: 'Reads quotes', grants: { quotes: { read: true } } }
	},
	envoys: {
		sales_desk: {
			audience: 'public',
			name: 'Norbius',
			policies: ['reader'],
			triage: false,
			groupMessages: 'disabled',
			delegation: 'enabled',
			task: 'Answer questions about quotes.'
		},
		field: {
			audience: 'private',
			name: 'Norbius',
			policies: ['reader'],
			triage: false,
			groupMessages: 'mention_or_reply',
			delegation: 'disabled',
			task: 'Keep quotes up to date.'
		}
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
			runAs: 'trigger',
			agent: 'confirm'
		}
	},
	connections: {
		desk: { integration: 'whatsapp', envoy: 'sales_desk' },
		field: { integration: 'whatsapp', envoy: 'field' }
	},
	apps: {},
	customFields: {}
};
const guest = program(`export default { automation: { quotes_mark: { body: function* (input, ctx) {
	return (yield* ctx.act('quotes.create', [{ title: input.title }])).records[0].id;
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

const build = (ai: ReturnType<typeof cassette>) =>
	Effect.gen(function* () {
		const hq = yield* mcpFixture;
		const values: Record<string, string> = {
			HQ_URL: hq.url,
			HQ_TOKEN: 's3cret',
			DOWN_URL: 'http://127.0.0.1:1/mcp'
		};
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest,
				guest: yield* guest,
				ports: ai.layer,
				// the host clock starts at the wall clock, as a turn drained from a live test reads it
				now: new Date().toISOString(),
				host: {
					agent: {
						mcp: { secret: (name) => Effect.succeed(values[name]) }
					}
				}
			})
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
		"lists only the skills and MCP servers the actor's capabilities name, and calls the MCP tool (rules 58, 63b)",
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
						// platform skills keep the skill tool for every actor; a workspace skill outside the actor's capabilities is never listed
						const skill = ai.requests[2]?.tools?.find((tool) => tool.name === 'skill');
						expect(skill?.description).not.toContain('pricing');
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
	envoy: { name, instance: name === 'field' ? 'field' : 'desk', sender, member, dm }
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
						const c = yield* agent.start({ envoy: 'sales_desk', integration: 'desk' });
						yield* agent.post({
							conversation: c,
							as: envoyAs('sales_desk', 'x', null, true),
							text: 'hi'
						});
						const { reply } = yield* agent.drain(c);
						expect(reply?.text).toBe(FIXED.failed);
						expect(JSON.stringify(reply)).not.toContain('sk-123');
						expect(t.fakes.logs.filter((r) => r.conversation === c).map((r) => r.severity)).toEqual(
							['error']
						);
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
					const pricey: Step = () =>
						answer({
							content: '',
							toolCalls: [{ id: 'd1', name: 'history', input: { query: 'x' } }],
							finish: 'tool',
							usage: { input: 3, output: 1, cost: 6, call: 'gen-1' }
						});
					const unpriced: Step = () =>
						answer({
							content: 'Done.',
							toolCalls: [],
							finish: 'stop',
							usage: { input: 3, output: 1 }
						});
					const fixture = yield* setup([pricey, unpriced]);
					return yield* Effect.gen(function* () {
						const { t, agent, user } = fixture;
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* agent.post({ conversation: c, as: { member: root }, text: 'go' });
						const { reply } = yield* agent.drain(c);
						expect(reply?.text).toBe('Done.');
						expect(reply?.meta).toMatchObject({ usage: { calls: 2, cost: 6, model: 'default' } });
						// the request's size in characters, per part
						const prompt = {
							system: expect.any(Number),
							messages: expect.any(Number),
							tools: expect.any(Number)
						};
						expect(yield* events(t, c)).toEqual([
							{
								severity: 'warn',
								attributes: {
									call: 'gen-1',
									model: 'default',
									input: 3,
									output: 1,
									cost: 6,
									cached: null,
									reasoning: null,
									prompt,
									settlement: 'pending',
									gauge: 5
								}
							},
							{
								severity: 'warn',
								attributes: {
									call: null,
									model: 'default',
									input: 3,
									output: 1,
									cost: null,
									cached: null,
									reasoning: null,
									prompt,
									settlement: 'attention'
								}
							}
						]);
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);
});
