// Native agent turns over scoped PGlite workspaces, provider streams and a local MCP ABI fixture.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import {
	Clock,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberSet,
	Layer,
	Option,
	Predicate,
	Queue,
	Result,
	Schedule,
	Schema,
	Scope,
	Stream
} from 'effect';
import type { Json } from '../src/decl/values.ts';
import { mcpServers, mcpSessions } from '../src/engine/agent/mcp.ts';
import type { AiRequest, AiResponse } from '../src/engine/contracts.ts';
import {
	ANSWERED,
	FIXED,
	NUDGE,
	RECOVERY,
	type AgentConfig,
	type HostTool,
	type HostToolContext
} from '../src/engine/agent/index.ts';
import { COMPACT_FORMAT, messages } from '../src/engine/agent/context.ts';
import type { MessageRow } from '../src/engine/agent/schema.ts';
import { conversationId } from '../src/engine/conversations/store.ts';
import { compileAuthority } from '../src/engine/access/authority.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Port, type PortFailure } from '../src/engine/port.ts';
import { Ai, type AiEvent } from '../src/engine/ports.ts';
import { Agents, Live } from '../src/engine/services.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { AgentConversation, AgentRow, type Frame } from '../src/protocol/schema.ts';
import { KitInvalid, TestWorkspace, respondSystem1, type Kit } from '../src/test/effect.ts';
import { actReply, routeFixture } from './support/route-fixture.ts';
import { program } from './support/guest-fixture.ts';

const manifest: EngineManifest = {
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
	collections: {
		quotes: {
			read: { fields: 'all' },
			create: { input: { columns: ['title', 'region'] } },
			update: { input: { columns: ['title', 'region'] } },
			delete: {},
			actions: {
				mark: {
					description: 'Mark a quote',
					input: { title: { kind: 'text' } },
					output: { kind: 'text' },
					agent: 'confirm'
				}
			}
		}
	},
	policies: {
		narrow: { description: 'Titles only', grants: { quotes: { read: { fields: ['title'] } } } },
		rep: {
			description: 'Rep',
			grants: { quotes: { read: true, create: true, update: true, actions: ['mark'] } },
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
			pricing: '---\ndescription: How we price\n---\n## Discounts\nTen percent.\n## Rounding\nUp.'
		}
	},
	integrations: {},
	pipelines: {},
	teams: { rep: ['rep'], reader: ['reader'], narrow: ['narrow'] },
	automations: {},
	connections: {
		desk: { integration: 'whatsapp', envoy: 'sales_desk' },
		field: { integration: 'whatsapp', envoy: 'field' }
	},
	apps: {},
	customFields: {}
};
const guest = program(`export default { collection: { quotes: { bodies: { actions: {
	mark: function* (input, ctx) { return (yield* ctx.act('quotes.create', { title: input.title })).records[0].id; },
} } } } };`);

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
const cassette = (steps: readonly Step[]) => {
	const requests: AiRequest[] = [];
	let index = 0;
	const port: Ai['Service'] = {
		ask: respondSystem1,
		maxChoices: undefined,
		models: ['default'],
		catalog: Effect.succeed({ models: [{ id: 'default', label: 'Default' }], default: 'default' }),
		embed: () => Port.unavailable('ai.embed'),
		infer: (request) =>
			Stream.unwrap(
				Effect.sync(() => {
					requests.push(request);
					const step = steps[index++];
					return step === undefined
						? Stream.fail(Port.failure('ai')(new Error('cassette exhausted')))
						: step(request);
				})
			)
	};
	return { port, requests, layer: Layer.succeed(Ai, port) };
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
const toolResult = <A>(schema: Schema.Decoder<A>, request: AiRequest, index: number) =>
	Schema.decodeUnknownSync(schema)(toolResults(request)[index]);

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
			const hq = yield* mcpFixture;
			const scope = yield* Scope.make();
			yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
			const sessions = yield* mcpSessions(manifest, {
				secret: (name) => Effect.succeed(name === 'HQ_URL' ? hq.url : 's3cret')
			}).pipe(Scope.provide(scope));
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

const setup = (
	steps: readonly Step[],
	over: Partial<Omit<AgentConfig, 'engine' | 'ai' | 'bindings'>> = {},
	now?: string
) =>
	Effect.gen(function* () {
		const hq = yield* mcpFixture,
			ai = cassette(steps);
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
				...(now === undefined ? {} : { now }),
				host: {
					agent: {
						mcp: { secret: (name) => Effect.succeed(values[name]) },
						...over
					}
				}
			})
		);
		const t = Context.get(context, TestWorkspace),
			agent = Context.get(context, Agents),
			live = Context.get(context, Live);
		const route = yield* routeFixture(context);
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
						`${name}@x.test`,
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
					read: { kind: 'transcript', collection: 'sys_message', conversation, thread: false }
				});
				yield* live.register(connection, 'conversations', {
					read: { kind: 'conversations', collection: 'sys_conversation', member }
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
		return { t, ai, agent, user, authority, observe, route, hq, context };
	});
const quotes = (t: Kit) =>
	t.db.rows(Schema.Struct({ title: Schema.String, created_by: Schema.NullOr(Schema.String) }), {
		text: 'SELECT title, created_by FROM quotes ORDER BY title',
		params: []
	});

describe('in-app turns', () => {
	it.live(
		'acts as the member, records tool rows, and ends on a reply carrying its receipts (rule 59)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup([
						use('act', { callable: 'quotes.create', input: { title: 'Desk' } }),
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
						expect(yield* quotes(t)).toEqual([{ title: 'Desk', created_by: ann }]);
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
						use('skill', { name: 'pricing', section: 'Discounts' }),
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
						expect(toolResults(ai.requests[1]!)[0]).toMatchObject({
							content: [{ type: 'text', text: 'echo: hi' }]
						});
						expect(hq.calls).toContainEqual({ name: 'echo', arguments: { text: 'hi' } });
						expect(toolResults(ai.requests[2]!)[1]).toBe('## Discounts\nTen percent.\n');
						const d = yield* agent.start({ owner: bob });
						yield* agent.post({ conversation: d, as: { member: bob }, text: 'anything?' });
						yield* agent.drain(d);
						const names = toolNames(ai.requests[3]);
						expect(names).not.toContain('skill');
						expect(names.some((n) => n.startsWith('mcp__'))).toBe(false);
						expect(names).not.toContain('act');
						expect({ mcp: mcpServers(manifest, yield* authority(ann)) }).toMatchObject({
							mcp: [{ name: 'hq' }]
						});
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live('an unreachable MCP server is unavailable, never a failed turn', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fixture = yield* setup([say('Fine.')]);
				return yield* Effect.gen(function* () {
					const { ai, agent, user } = fixture;
					const root = yield* user('root', { admin: true });
					const c = yield* agent.start({ owner: root });
					yield* agent.post({ conversation: c, as: { member: root }, text: 'hello' });
					expect((yield* agent.drain(c)).reply?.text).toBe('Fine.');
					expect(toolNames(ai.requests[0])).toContain('mcp__hq__echo');
					expect(toolNames(ai.requests[0]).some((n) => n.startsWith('mcp__down__'))).toBe(false);
				}).pipe(Effect.provide(fixture.context));
			})
		)
	);

	it.live(
		'holds a confirm action on a card until the member confirms; it then executes and the turn goes on',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup([
						use('act', { callable: 'quotes.mark', input: { title: 'Chair' } }, 'k1'),
						say('Marked.')
					]);
					return yield* Effect.gen(function* () {
						const { t, ai, agent, user, authority } = fixture;
						const ann = yield* user('ann', { team: 'rep' });
						const c = yield* agent.start({ owner: ann });
						yield* agent.post({ conversation: c, as: { member: ann }, text: 'mark a chair' });
						yield* agent.drain(c);
						expect(yield* quotes(t)).toEqual([]);
						const held = (yield* agent.transcript(c)).find((r) => r.state === 'confirm')!;
						expect(held.meta).toMatchObject({ tag: 'confirm', call: { id: 'k1', name: 'act' } });
						const bob = yield* user('bob', { team: 'rep' });
						expect(
							(yield* Effect.flip(agent.confirm(held.id, true, yield* authority(bob)))).message
						).toMatch(/only the person/);
						const { reply } = yield* agent.confirm(held.id, true, yield* authority(ann));
						expect(yield* quotes(t)).toEqual([{ title: 'Chair', created_by: ann }]);
						expect(reply).toMatchObject({
							text: 'Marked.',
							meta: { receipts: [{ outcome: 'committed', callable: 'quotes.mark' }] }
						});
						expect(toolResults(ai.requests[1]!)[0]).toMatchObject({ kind: 'committed' });
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live(
		'a confirm host tool is held on a card: declined it never runs; approved it runs once, as the person, and the turn goes on',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const calls: Array<{ input: Json; actor: string; callId: string }> = [];
					const publish: HostTool = {
						name: 'go_live',
						description: 'Go live',
						input: { type: 'object' },
						confirm: true,
						call: async (input, context) => {
							calls.push({
								input,
								actor: context.actor.kind === 'member' ? context.actor.id : context.actor.kind,
								callId: context.callId
							});
							return { live: true };
						}
					};
					const fixture = yield* setup(
						[
							use('go_live', { commit: 'c1' }, 'g1'),
							say('Not published.'),
							use('go_live', { commit: 'c2' }, 'g2'),
							say('Published.')
						],
						{ hostTools: async () => [publish] }
					);
					return yield* Effect.gen(function* () {
						const { ai, agent, user, authority } = fixture;
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* agent.post({ conversation: c, as: { member: root }, text: 'publish' });
						yield* agent.drain(c);
						expect(calls).toEqual([]);
						const first = (yield* agent.transcript(c)).find((r) => r.state === 'confirm')!;
						expect(first.meta).toMatchObject({
							tag: 'confirm',
							call: { id: 'g1', name: 'go_live' }
						});
						const declined = yield* agent.confirm(first.id, false, yield* authority(root));
						expect(declined.reply?.text).toBe('Not published.');
						expect(calls).toEqual([]);
						expect(toolResults(ai.requests[1]!)[0]).toMatchObject({ declined: true });
						yield* agent.post({ conversation: c, as: { member: root }, text: 'publish now' });
						yield* agent.drain(c);
						const second = (yield* agent.transcript(c)).find((r) => r.state === 'confirm')!;
						expect(calls).toEqual([]);
						const { reply } = yield* agent.confirm(second.id, true, yield* authority(root));
						expect(calls).toEqual([{ input: { commit: 'c2' }, actor: root, callId: 'g2' }]);
						expect(reply?.text).toBe('Published.');
						expect(toolResults(ai.requests[3]!).at(-1)).toMatchObject({ live: true });
						// a repeat press is refused: the call never runs a second time
						expect(
							(yield* Effect.flip(agent.confirm(second.id, true, yield* authority(root)))).message
						).toBe(ANSWERED);
						expect(calls).toHaveLength(1);
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live(
		'an approved host call is claimed once, shows its steps, and still settles when its confirm is interrupted',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let calls = 0;
					const publish: HostTool = {
						name: 'go_live',
						description: 'Go live',
						input: { type: 'object' },
						confirm: true,
						// like a publish whose cutover retires the generation running it: it never answers here
						call: (_input, context, signal) => {
							calls += 1;
							context.progress?.('diagnose');
							return new Promise((_resolve, reject) =>
								signal.addEventListener('abort', () => reject(signal.reason))
							);
						}
					};
					const fixture = yield* setup([use('go_live', { commit: 'c1' }, 'g1')], {
						hostTools: async () => [publish]
					});
					return yield* Effect.gen(function* () {
						const { agent, user, authority } = fixture;
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* agent.post({ conversation: c, as: { member: root }, text: 'publish' });
						yield* agent.drain(c);
						const held = (yield* agent.transcript(c)).find((r) => r.state === 'confirm')!;
						const pressed = yield* Effect.forkChild(
							agent.confirm(held.id, true, yield* authority(root))
						);
						const row = Effect.map(agent.transcript(c), (rows) =>
							rows.find((r) => r.id === held.id)
						);
						// the card is claimed and shows the host's step while the call runs
						const running = yield* row.pipe(
							Effect.repeat({
								until: (r) =>
									r?.state === 'approved' &&
									Predicate.isObject(r.content) &&
									r.content['progress'] === 'diagnose',
								schedule: Schedule.spaced('10 millis'),
								times: 500
							})
						);
						expect(running?.state).toBe('approved');
						expect(
							(yield* Effect.flip(agent.confirm(held.id, true, yield* authority(root)))).message
						).toBe(ANSWERED);
						yield* Fiber.interrupt(pressed);
						const settled = yield* row;
						expect(settled?.state).toBeNull();
						expect(settled?.content).toMatchObject({
							id: 'g1',
							name: 'go_live',
							result: { restarted: FIXED.restartedDuring('Building…') }
						});
						expect(
							(yield* Effect.flip(agent.confirm(held.id, true, yield* authority(root)))).message
						).toBe(ANSWERED);
						expect(calls).toBe(1);
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live(
		'a confirm settled by the switch-over restart is resumed once by the next generation, which reports the outcome',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const publish: HostTool = {
						name: 'go_live',
						description: 'Go live',
						input: { type: 'object' },
						confirm: true,
						// its cutover retires the generation running it: it never answers there
						call: (_input, context, signal) => {
							context.progress?.('merge');
							return new Promise((_resolve, reject) =>
								signal.addEventListener('abort', () => reject(signal.reason))
							);
						}
					};
					const fixture = yield* setup(
						[use('go_live', { commit: 'c1' }, 'g1'), say('Applied: the workspace is on c1.')],
						{ hostTools: async () => [publish] }
					);
					const { agent, user, authority, ai, t } = fixture;
					const { c, held } = yield* Effect.gen(function* () {
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* agent.post({ conversation: c, as: { member: root }, text: 'publish' });
						yield* agent.drain(c);
						const held = (yield* agent.transcript(c)).find((r) => r.state === 'confirm')!;
						const pressed = yield* Effect.forkChild(
							agent.confirm(held.id, true, yield* authority(root))
						);
						yield* agent.transcript(c).pipe(
							Effect.repeat({
								until: (rows) =>
									rows.some(
										(r) =>
											r.id === held.id &&
											Predicate.isObject(r.content) &&
											r.content['progress'] === 'merge'
									),
								schedule: Schedule.spaced('10 millis'),
								times: 500
							})
						);
						yield* Fiber.interrupt(pressed);
						return { c, held };
					}).pipe(Effect.provide(fixture.context));
					// the old generation settled the card but never ran the turn on
					expect(ai.requests).toHaveLength(1);
					const generation = Effect.gen(function* () {
						return Context.get(
							yield* Layer.build(
								TestWorkspace.layer({
									manifest,
									guest: yield* guest,
									ports: ai.layer,
									db: Layer.succeed(TenantDb, t.db),
									host: { agent: { mcp: { secret: () => Effect.succeed(undefined) } } }
								})
							),
							Agents
						);
					});
					// the new generation resumes it at its start
					const next = yield* generation;
					const rows = yield* next.transcript(c).pipe(
						Effect.repeat({
							until: (rows) => rows.some((r) => r.role === 'assistant' && r.meta?.tag === 'reply'),
							schedule: Schedule.spaced('10 millis'),
							times: 500
						})
					);
					expect(rows.find((r) => r.role === 'assistant' && r.meta?.tag === 'reply')?.text).toBe(
						'Applied: the workspace is on c1.'
					);
					expect(toolResults(ai.requests[1]!).at(-1)).toMatchObject({
						restarted: FIXED.restartedDuring('Switching over…')
					});
					expect(rows.find((r) => r.id === held.id)?.content).toMatchObject({ resumed: true });
					// one resume per settled card: a later generation finds nothing to resume
					yield* generation;
					yield* Effect.sleep('100 millis');
					expect(ai.requests).toHaveLength(2);
				})
			)
	);

	it.live(
		'compacts when the reported input passes 90% of the window, and the next call starts from the checkpoint (rule 62)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup(
						[
							use('history', { query: 'x' }, 'd1', 95),
							say('| Section | Summary |\n|---|---|\n| Goal | g |'),
							say('Done.')
						],
						{ windows: { default: 100 } }
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
		'a stream still open at the wall is cut and continued as a new step: two calls, one reply (rule 63)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const stalls: Step = () =>
						Stream.concat(
							Stream.succeed<AiEvent>({ _tag: 'Delta', text: 'The answer ' }),
							Stream.fromEffect(Effect.never)
						);
					const fixture = yield* setup([stalls, say('is 42.')], { wallMs: 30 });
					return yield* Effect.gen(function* () {
						const { ai, agent, user } = fixture;
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* agent.post({ conversation: c, as: { member: root }, text: 'question' });
						const { reply } = yield* agent.drain(c);
						expect(ai.requests).toHaveLength(2);
						expect(reply?.text).toBe('The answer is 42.');
						expect((yield* agent.transcript(c)).filter((r) => r.role === 'assistant')).toHaveLength(
							1
						);
						expect(ai.requests[1]!.messages.at(-1)).toMatchObject({ role: 'assistant' });
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live('stops at the step budget with a fixed reply', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fixture = yield* setup(
					[
						use('history', { query: 'x' }),
						use('history', { query: 'x' }),
						use('history', { query: 'x' })
					],
					{ steps: 2 }
				);
				return yield* Effect.gen(function* () {
					const { agent, user } = fixture;
					const root = yield* user('root', { admin: true });
					const c = yield* agent.start({ owner: root });
					yield* agent.post({ conversation: c, as: { member: root }, text: 'loop' });
					expect((yield* agent.drain(c)).reply).toMatchObject({
						text: FIXED.budget,
						meta: { tag: 'failed', code: 'stepBudget' }
					});
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

describe('plans and the verifier (rule 63a)', () => {
	it.live(
		"plan mode drafts; execution is verified by an independent sub-run, again after every miss, with no stall (today's behaviour)",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const miss = say(
						JSON.stringify({ complete: false, gaps: ['no evidence'], summary: 'not yet' })
					);
					const fixture = yield* setup([
						use('update_plan', { body: '1. Read quotes\nCheck: a count is reported' }),
						say('Plan drafted.'),
						say('Done.'),
						miss,
						say('Still done.'),
						miss,
						say('Really done.'),
						miss,
						say('Truly done.'),
						miss,
						say('Counted 0 quotes.'),
						say(JSON.stringify({ complete: true, gaps: [], summary: 'ok' }))
					]);
					return yield* Effect.gen(function* () {
						const { ai, agent, user } = fixture;
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* agent.post({
							conversation: c,
							as: { member: root },
							text: 'plan it',
							mode: 'plan'
						});
						yield* agent.drain(c);
						expect(toolNames(ai.requests[0])).not.toContain('act');
						expect((yield* agent.conversation(c)).plan).toMatchObject({
							status: 'draft',
							body: expect.stringContaining('Read quotes')
						});
						yield* agent.executePlan(c, { member: root });
						expect(ai.requests[3]!.system).toContain('independent verification agent');
						expect(ai.requests[3]!.tools).toBeUndefined();
						expect(JSON.stringify(ai.requests[4]!.messages)).not.toContain('plan it');
						expect((yield* agent.conversation(c)).plan).toMatchObject({
							status: 'verified',
							verdicts: 4
						});
						expect(ai.requests).toHaveLength(12);
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
		"an ambient message starts nothing and is readable by read_messages; each addressed steer carries its sender header, and every group turn holds the envoy's policies alone (rule 60, P32)",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const gate = yield* Deferred.make<void>(),
						entered = yield* Deferred.make<void>();
					const fixture = yield* setup([
						(req) =>
							Stream.unwrap(
								Effect.gen(function* () {
									yield* Deferred.succeed(entered, undefined);
									yield* Deferred.await(gate);
									return use('read_messages', {})(req);
								})
							),
						use('read', { collection: 'quotes' }),
						say('Both seen.')
					]);
					return yield* Effect.gen(function* () {
						const { t, ai, agent, user } = fixture;
						const ann = yield* user('ann', { admin: true });
						const ben = yield* user('ben', { team: 'rep' });
						const c = yield* agent.start({ envoy: 'field', integration: 'field' });
						yield* t.db.write({
							text: `INSERT INTO sys_message (id, conversation, seq, role, content, text, state, author, addressed)
				VALUES ($1,$2,1,'user',$3::jsonb,'site 14 photo','consumed','Cara',false)`,
							params: [randomUUID(), c, JSON.stringify({ text: 'site 14 photo' })]
						});
						expect((yield* agent.drain(c)).reply).toBeNull();
						expect(ai.requests).toHaveLength(0);
						yield* agent.post({
							conversation: c,
							as: envoyAs('field', '+1', ann, false),
							text: '@bot add A1',
							author: 'Ann'
						});
						const turn = yield* Effect.forkScoped(agent.drain(c));
						yield* Deferred.await(entered);
						yield* agent.post({
							conversation: c,
							as: envoyAs('field', '+2', ben, false),
							text: '@bot and B1',
							author: 'Ben'
						});
						expect((yield* agent.drain(c)).ran).toBe(false);
						yield* Deferred.succeed(gate, undefined);
						const { reply } = yield* Fiber.join(turn);
						expect(toolNames(ai.requests[0])).not.toContain('act'); // an administrator in a group holds the envoy's `reader` only
						expect(toolNames(ai.requests[1])).not.toContain('act');
						const second = JSON.stringify(ai.requests[1]!.messages);
						expect(second).toContain(`[Ann · linked member ${ann}] @bot add A1`);
						expect(second).toContain(`[Ben · linked member ${ben}] @bot and B1`);
						expect(JSON.stringify(toolResults(ai.requests[1]!).at(-1))).toContain('site 14 photo');
						expect(JSON.stringify(ai.requests[0]!.messages.at(-1))).toContain(
							'1 unread chat message'
						);
						expect(reply?.text).toBe('Both seen.');
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live(
		"a DM holds the envoy's policies joined by the linked member's own authority; the same administrator in a group is refused (rule 57, P32)",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup([
						use('act', { callable: 'quotes.create', input: { title: 'Boss' } }),
						say('ok'),
						say('no')
					]);
					return yield* Effect.gen(function* () {
						const { t, ai, agent, user } = fixture;
						const root = yield* user('root', { admin: true });
						const dm = yield* agent.start({ envoy: 'field', integration: 'field' });
						yield* agent.post({
							conversation: dm,
							as: envoyAs('field', '+9', root, true),
							text: 'add Boss',
							author: 'Root'
						});
						yield* agent.drain(dm);
						expect(yield* quotes(t)).toEqual([{ title: 'Boss', created_by: root }]);
						const group = yield* agent.start({ envoy: 'field', integration: 'field' });
						yield* agent.post({
							conversation: group,
							as: envoyAs('field', '+9', root, false),
							text: '@bot add Boss',
							author: 'Root'
						});
						yield* agent.drain(group);
						expect(toolNames(ai.requests[2])).not.toContain('act');
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live(
		"a public envoy delegates in the background; its sub-agent cannot write outside the envoy's policies, and its report starts a parent turn once the parent has replied (rules 63a, parity 1.14)",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const parent = [
						use('subagent', { action: 'spawn', task: 'Create a quote called Sneaky' }),
						say('Working on it.'),
						say('Sorry, I cannot create that quote.')
					];
					const child = [
						use('act', { callable: 'quotes.create', input: { title: 'Sneaky' } }),
						say('I may not create quotes.')
					];
					let p = 0,
						k = 0;
					const route: Step = (req) =>
						JSON.stringify(req.messages[0]).includes('Sneaky')
							? child[k++]!(req)
							: parent[p++]!(req);
					const fixture = yield* setup(Array(5).fill(route));
					return yield* Effect.gen(function* () {
						const { t, ai, agent } = fixture;
						const c = yield* agent.start({ envoy: 'sales_desk', integration: 'desk' });
						const as = envoyAs('sales_desk', '+6590000000', null, true);
						yield* agent.post({
							conversation: c,
							as,
							text: 'make me a quote',
							author: '+6590000000'
						});
						// the parent answers at once; the sub-agent works detached and its report runs the next parent turn
						expect((yield* agent.drain(c)).reply?.text).toBe('Working on it.');
						const last = () =>
							agent
								.transcript(c)
								.pipe(Effect.map((rows) => rows.findLast((r) => r.role === 'assistant' && r.text)));
						for (
							let i = 0;
							i < 200 && (yield* last())?.text !== 'Sorry, I cannot create that quote.';
							i++
						)
							yield* Effect.sleep('20 millis');
						const reply = yield* last();
						expect(yield* quotes(t)).toEqual([]);
						expect(toolNames(ai.requests[0])).toContain('subagent');
						const kid = ai.requests.filter((r) => JSON.stringify(r.messages[0]).includes('Sneaky'));
						expect(kid).toHaveLength(2);
						expect(toolNames(kid[0])).not.toContain('act');
						expect(toolNames(kid[0])).not.toContain('subagent');
						expect(toolResults(kid[1]!)[0]).toEqual({ error: "No tool 'act'." });
						expect(kid[0]!.system).toContain('Customer brief.');
						expect(JSON.stringify(kid[0]!.messages[0])).toContain('not linked');
						expect(JSON.stringify(ai.requests.at(-1)!.messages)).toContain(
							'I may not create quotes.'
						);
						expect(reply?.text).toBe('Sorry, I cannot create that quote.');
						// the sub-agent's calls stay on its own conversation; the report turn made one call
						expect(reply?.meta).toMatchObject({ usage: { calls: 1 } });
						const report = (yield* agent.transcript(c)).find((r) => r.meta?.tag === 'report');
						expect(report).toMatchObject({ role: 'user', author: 'sub-agent', state: 'consumed' });
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live(
		'a sub-agent stops to ask its delegating agent, which answers with message; it resumes and answers',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let child = '';
					const parent: Step[] = [
						use('subagent', { action: 'spawn', task: 'CHILDTASK: count the people' }),
						(req) => {
							child = Option.match(
								Schema.decodeUnknownOption(Schema.Struct({ conversation: Schema.String }))(
									toolResults(req).at(-1)
								),
								{ onNone: () => '', onSome: (x) => x.conversation }
							);
							return use('wait', {})(req);
						},
						(req) =>
							use('subagent', { action: 'message', conversation: child, text: 'Entity A' })(req),
						use('wait', {}),
						(req) => use('subagent', { action: 'read', conversation: child })(req),
						say('Entity A has 3 people.')
					];
					const kid: Step[] = [
						use('ask_parent', { question: 'Which entity?' }),
						say('Entity A has 3 people.')
					];
					let p = 0,
						k = 0;
					const route: Step = (req) =>
						JSON.stringify(req.messages[0]).includes('CHILDTASK')
							? kid[k++]!(req)
							: parent[p++]!(req);
					const fixture = yield* setup(Array(8).fill(route));
					return yield* Effect.gen(function* () {
						const { ai, agent, user } = fixture;
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* agent.post({
							conversation: c,
							as: { member: root },
							text: 'how many at entity A?'
						});
						const { reply } = yield* agent.drain(c);
						const kidRequests = ai.requests.filter((r) =>
							JSON.stringify(r.messages[0]).includes('CHILDTASK')
						);
						expect(toolNames(kidRequests[0])).toContain('ask_parent');
						expect(toolNames(ai.requests[0])).not.toContain('ask_parent');
						// the parent's wait saw the question, marked asked
						const waited = ai.requests.find((r) =>
							toolResults(r).some((x) => JSON.stringify(x).includes('"asked":true'))
						);
						expect(JSON.stringify(waited?.messages)).toContain('Which entity?');
						// the sub-agent resumed with the answer as its next message, and answered
						expect(JSON.stringify(kidRequests.at(-1)?.messages)).toContain('Entity A');
						const rows = yield* agent.transcript(child);
						expect(
							rows
								.filter((r) => r.role === 'user' || (r.role === 'assistant' && r.text))
								.map((r) => [
									r.role,
									r.text,
									r.meta?.tag === 'reply' ? (r.meta.asked ?? false) : null
								])
						).toEqual([
							['user', 'CHILDTASK: count the people', null],
							['assistant', 'Which entity?', true],
							['user', 'Entity A', null],
							['assistant', 'Entity A has 3 people.', false]
						]);
						expect(reply?.text).toBe('Entity A has 3 people.');
						// read shows the parent what the sub-agent did: its tool calls and its messages
						const inspected = toolResults(ai.requests.at(-1)!).at(-1);
						expect(inspected).toMatchObject({
							status: 'idle',
							steps: [{ tool: 'ask_parent' }],
							messages: expect.arrayContaining([
								{ role: 'assistant', text: 'Which entity?', asked: true },
								{ role: 'assistant', text: 'Entity A has 3 people.' }
							])
						});
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live('a sub-agent its parent stops still reports up that it was stopped', () =>
		Effect.scoped(
			Effect.gen(function* () {
				let child = '';
				const parent: Step[] = [
					use('subagent', { action: 'spawn', task: 'CHILDTASK: count the people' }),
					(req) => {
						child = Option.match(
							Schema.decodeUnknownOption(Schema.Struct({ conversation: Schema.String }))(
								toolResults(req).at(-1)
							),
							{ onNone: () => '', onSome: (x) => x.conversation }
						);
						return use('subagent', { action: 'stop', conversation: child })(req);
					},
					use('wait', {}),
					say('Stopped it.')
				];
				let p = 0;
				const route: Step = (req) =>
					JSON.stringify(req.messages[0]).includes('CHILDTASK')
						? use('wait', {})(req)
						: parent[p++]!(req);
				const fixture = yield* setup(Array(6).fill(route));
				return yield* Effect.gen(function* () {
					const { agent, user } = fixture;
					const root = yield* user('root', { admin: true });
					const c = yield* agent.start({ owner: root });
					yield* agent.post({ conversation: c, as: { member: root }, text: 'count, then stop it' });
					const { reply } = yield* agent.drain(c);
					expect(reply?.text).toBe('Stopped it.');
					expect((yield* agent.conversation(child)).status).toBe('stopped');
					const report = (yield* agent.transcript(c)).find((r) => r.meta?.tag === 'report');
					expect(report).toMatchObject({ role: 'user', author: 'sub-agent' });
					expect(report?.text).toContain('was stopped');
				}).pipe(Effect.provide(fixture.context));
			})
		)
	);

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
						expect(
							(yield* t.db.read([
								{ text: `SELECT severity FROM sys_event WHERE conversation = $1`, params: [c] }
							]))[0]!.rows
						).toEqual([{ severity: 'error' }]);
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

describe('toolset parity with today (agent-tools-parity.md)', () => {
	const post = (
		agent: Agents['Service'],
		c: string,
		member: string,
		text: string,
		o: { mode?: 'agent' | 'plan' | 'compact'; tz?: string } = {}
	) => agent.post({ conversation: c, as: { member }, text, author: member, ...o });

	it.live(
		'steers from two senders are never collated: each step runs under one sender (rule 60, parity 2.7)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup([say('ok bob'), say('ok root')]);
					return yield* Effect.gen(function* () {
						const { ai, agent, user } = fixture;
						const bob = yield* user('bob', { team: 'reader' });
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ envoy: 'field', integration: 'field' });
						yield* post(agent, c, bob, 'read please');
						yield* post(agent, c, root, 'delete everything');
						yield* agent.drain(c);
						expect(toolNames(ai.requests[0])).not.toContain('act');
						expect(JSON.stringify(ai.requests[0]!.messages)).not.toContain('delete everything');
						expect(toolNames(ai.requests[1])).toContain('act');
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live('a write answers the stored row; the reply carries summed usage (parity 1.2, 3.14)', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fixture = yield* setup([
					use('act', { callable: 'quotes.create', input: { title: 'Desk' } }),
					say('Done.')
				]);
				return yield* Effect.gen(function* () {
					const { ai, agent, user } = fixture;
					const ann = yield* user('ann', { team: 'rep' });
					const c = yield* agent.start({ owner: ann });
					yield* post(agent, c, ann, 'desk');
					const { reply } = yield* agent.drain(c);
					expect(toolResults(ai.requests[1]!)[0]).toMatchObject({
						kind: 'committed',
						stored: [{ title: 'Desk', region: 'north' }]
					});
					expect(reply?.meta).toMatchObject({ usage: { input: 20, output: 10, calls: 2 } });
				}).pipe(Effect.provide(fixture.context));
			})
		)
	);

	it.live(
		'the system prompt is byte-identical across actors and days and carries the outline; each step closes with the clock and the actor (rule 62, P32)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup([say('a'), say('b')]);
					return yield* Effect.gen(function* () {
						const { t, ai, agent, user } = fixture;
						const ann = yield* user('ann', { team: 'rep' });
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: ann });
						yield* post(agent, c, ann, 'when', { tz: 'Asia/Singapore' });
						yield* agent.drain(c);
						t.clock.advance('1d');
						const d = yield* agent.start({ owner: root });
						yield* post(agent, d, root, 'hi');
						yield* agent.drain(d);
						expect(ai.requests[1]!.system).toBe(ai.requests[0]!.system);
						expect(ai.requests[0]!.system).toContain('# Workspace outline');
						expect(ai.requests[0]!.system).toMatch(/^- quotes: .*\| title, region/m);
						const note = (n: number) => JSON.stringify(ai.requests[n]!.messages.at(-1)!.content);
						expect(note(0)).toMatch(
							new RegExp(
								`Now: .*\\(UTC, .*theirs .*\\(Asia/Singapore\\).*You act for ann@x.test \\(member id ${ann}\\) \\(rep\\); policies rep`
							)
						);
						expect(note(1)).toContain(
							`You act for root@x.test (member id ${root}), an administrator`
						);
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live(
		'read keeps named fields whole and pages on from the last row it shows, and honours field masks (parity 1.1, 1.3)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const long = (i: number) => `${String(i).padStart(2, '0')} ${'x'.repeat(2_000)}`;
					const q = { collection: 'quotes', select: { title: true }, orderBy: { title: 'asc' } };
					const onward: Step = (req) =>
						use('read', {
							...q,
							limit: 1,
							after: toolResult(Schema.Struct({ next: Schema.String }), req, 0).next
						})(req);
					const fixture = yield* setup([
						use('read', { ...q, limit: 30 }),
						onward,
						say('a'),
						use('read', { collection: 'quotes', limit: 1 }),
						say('b')
					]);
					return yield* Effect.gen(function* () {
						const { t, ai, agent, user } = fixture;
						const root = yield* user('root', { admin: true });
						for (let i = 0; i < 30; i++)
							yield* t.db.write({
								text: `INSERT INTO quotes (id, title, region) VALUES (gen_random_uuid(), $1, 'north')`,
								params: [long(i)]
							});
						const c = yield* agent.start({ owner: root });
						yield* post(agent, c, root, 'list');
						yield* agent.drain(c);
						const page = toolResult(
							Schema.Struct({
								rows: Schema.Array(Schema.Struct({ title: Schema.String })),
								next: Schema.NullOr(Schema.String),
								clipped: Schema.String
							}),
							ai.requests[1]!,
							0
						);
						expect(page.rows.length).toBeGreaterThan(0);
						expect(page.rows.length).toBeLessThan(30);
						expect(page.rows[0]!.title).toBe(long(0));
						expect(
							toolResult(
								Schema.Struct({ rows: Schema.Array(Schema.Struct({ title: Schema.String })) }),
								ai.requests[2]!,
								1
							).rows[0]!.title
						).toBe(long(page.rows.length));
						const nora = yield* user('nora', { team: 'narrow' });
						const d = yield* agent.start({ owner: nora });
						yield* post(agent, d, nora, 'what is a quote');
						yield* agent.drain(d);
						expect(
							toolResult(
								Schema.Struct({ rows: Schema.Array(Schema.Struct({ region: Schema.Unknown })) }),
								ai.requests[4]!,
								0
							).rows[0]!.region
						).toEqual({ $masked: true });
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live(
		'stop then a follow-up runs; resume after a stop recalls the stopped request (parity 3.4, 2.20)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup([say('two done'), say('resumed')]);
					return yield* Effect.gen(function* () {
						const { ai, agent, user } = fixture;
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* post(agent, c, root, 'one');
						yield* agent.stop(c);
						yield* post(agent, c, root, 'two');
						expect((yield* agent.drain(c)).reply?.text).toBe('two done');
						yield* post(agent, c, root, 'three');
						yield* agent.stop(c);
						expect((yield* agent.resume(c)).reply?.text).toBe('resumed');
						expect(JSON.stringify(ai.requests[1]!.messages)).toContain('Not yet handled: three');
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live(
		'goals are a validated checklist; update_plan patches against its revision; a draft plan locks execution (parity 1.10, 1.11, 3.6)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup([
						use('goals', {
							items: [
								{ id: 'a', text: 'Find', status: 'done' },
								{ id: 'b', text: 'Fix', status: 'doing' }
							]
						}),
						use('goals', { items: [{ id: 'a', text: 'Find', status: 'pending' }] }),
						say('ok'),
						use('update_plan', { body: '1. Read\n2. Write' }),
						use('update_plan', {
							patch: { old: '2. Write', new: '2. Report' },
							expectedRevision: 1
						}),
						use('update_plan', { body: 'stale', expectedRevision: 1 }),
						say('drafted'),
						say('still planning')
					]);
					return yield* Effect.gen(function* () {
						const { ai, agent, user } = fixture;
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* post(agent, c, root, 'track it');
						yield* agent.drain(c);
						expect(toolResults(ai.requests[2]!)[1]).toEqual({
							error: "Goal 'a' is done; it stays done with its text."
						});
						expect((yield* agent.conversation(c)).goals).toEqual([
							{ id: 'a', text: 'Find', status: 'done' },
							{ id: 'b', text: 'Fix', status: 'doing' }
						]);
						yield* post(agent, c, root, 'plan', { mode: 'plan' });
						yield* agent.drain(c);
						expect((yield* agent.conversation(c)).plan).toMatchObject({
							revision: 2,
							body: '1. Read\n2. Report',
							status: 'draft'
						});
						expect(toolResults(ai.requests[6]!).at(-1)).toEqual({
							error: 'The plan is at revision 2; read it again before editing.'
						});
						yield* post(agent, c, root, 'just do it');
						yield* agent.drain(c);
						expect(toolNames(ai.requests[7])).toContain('update_plan');
						expect(toolNames(ai.requests[7])).not.toContain('act');
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live(
		'the compact tool and /compact checkpoint; an empty summary is asked for once more (parity 1.12, 3.9, 3.22)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup([
						use('compact', { reason: 'long' }),
						say(''),
						say('| Goal | g |'),
						say('after'),
						say('| Goal | again |')
					]);
					return yield* Effect.gen(function* () {
						const { ai, agent, user } = fixture;
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* post(agent, c, root, 'go');
						expect((yield* agent.drain(c)).reply?.text).toBe('after');
						expect(ai.requests[1]!.system).toBe(COMPACT_FORMAT);
						expect(ai.requests[2]!.system).toBe(COMPACT_FORMAT);
						expect(JSON.stringify(ai.requests[3]!.messages)).toContain('context checkpoint');
						yield* post(agent, c, root, '/compact', { mode: 'compact' });
						yield* agent.drain(c);
						expect(ai.requests).toHaveLength(5);
						expect(
							(yield* agent.transcript(c)).filter((r) => r.meta?.tag === 'compact')
						).toHaveLength(2);
						expect(yield* agent.exportTranscript(c)).toMatch(
							/Model calls: 4\. Tool calls: compact 1\.[\s\S]*## Checkpoint[\s\S]*### Assistant\n\nafter/
						);
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live(
		"history searches this conversation or all of the person's; a clipped result is readable with read_output; repeated failures get guidance (parity 1.7, 1.19, 3.11)",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const big = { blob: 'y'.repeat(40_000) };
					const bigTool: HostTool = {
						name: 'big',
						description: 'Big',
						input: { type: 'object' },
						call: async () => big
					};
					const bad = use('read', { collection: 'nope' });
					const fixture = yield* setup(
						[
							say('first'),
							use('history', { query: 'PURPLE', scope: 'mine' }),
							use('big', {}, 'b1'),
							use('read_output', { call: 'b1', offset: 100 }),
							bad,
							bad,
							bad,
							say('done')
						],
						{ hostTools: [bigTool] }
					);
					return yield* Effect.gen(function* () {
						const { ai, agent, user } = fixture;
						const root = yield* user('root', { admin: true });
						const c1 = yield* agent.start({ owner: root });
						yield* post(agent, c1, root, 'the PURPLE door');
						yield* agent.drain(c1);
						const c2 = yield* agent.start({ owner: root });
						yield* post(agent, c2, root, 'where was that door?');
						yield* agent.drain(c2);
						expect(toolResults(ai.requests[2]!)[0]).toMatchObject({
							hits: [{ conversation: c1, text: 'the PURPLE door' }]
						});
						expect(JSON.stringify(toolResults(ai.requests[3]!)[1])).toContain(
							'clipped, 40002 bytes'
						);
						const whole = JSON.stringify(big, null, 2);
						expect(toolResults(ai.requests[3]!)[1]).toMatchObject({
							readOutput: `clipped: the whole result (${whole.length} bytes) is .scratch/tool-output/${c2}/b1-big.txt. read_output { call: 'b1', offset } reads it on`
						});
						expect(toolResults(ai.requests[4]!)[2]).toMatchObject({
							offset: 100,
							total: whole.length,
							next: 13_100,
							parts: expect.arrayContaining(['y'.repeat(1000)])
						});
						expect(toolResults(ai.requests[7]!).at(-1)).toMatchObject({ guidance: RECOVERY });
						expect(toolResults(ai.requests[6]!).at(-1)).not.toHaveProperty('guidance');
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live(
		'a clipped file is read on with read_output: by the call its clip note names, or the latest with no call; escaped code stays within the bound (rule 62)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					// a Svelte page: quotes, tabs and newlines grow when the result is encoded again
					const page = Array.from(
						{ length: 900 },
						(_, n) => `\t<td class="c" data-k="${n}">{row["f${n}"]}</td>`
					).join('\n');
					const read: HostTool = {
						name: 'draft_read',
						description: 'Read',
						input: { type: 'object' },
						readOnly: true,
						call: async () => ({ files: { 'src/app/crm/+desk.page.svelte': page } })
					};
					const fixture = yield* setup(
						[
							use('draft_read', {}, 'r1'),
							use('read_output', { call: 'r1' }),
							use('read_output', { offset: 5_000 }),
							use('read_output', { call: 'guess' }),
							say('done')
						],
						{ hostTools: [read] }
					);
					return yield* Effect.gen(function* () {
						const { ai, agent, user } = fixture;
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* post(agent, c, root, 'read the desk');
						yield* agent.drain(c);
						const whole = JSON.stringify(
							{ files: { 'src/app/crm/+desk.page.svelte': page } },
							null,
							2
						);
						expect(toolResults(ai.requests[1]!)[0]).toMatchObject({
							readOutput: expect.stringContaining(
								`.scratch/tool-output/${c}/r1-draft_read.txt. read_output { call: 'r1', offset } reads it on`
							)
						});
						const Out = Schema.Struct({
							offset: Schema.Number,
							total: Schema.Number,
							parts: Schema.Array(Schema.String),
							next: Schema.optionalKey(Schema.Number)
						});
						const byId = toolResult(Out, ai.requests[2]!, 1);
						expect(byId).toMatchObject({ offset: 0, total: whole.length });
						expect(byId.parts.join('')).toBe(whole.slice(0, byId.next));
						expect(byId.parts.every((p) => !p.includes('[clipped'))).toBe(true);
						expect(
							new TextEncoder().encode(JSON.stringify(toolResults(ai.requests[2]!)[1])).length
						).toBeLessThanOrEqual(16 * 1024);
						const latest = toolResult(Out, ai.requests[3]!, 2);
						expect(latest.parts.join('')).toBe(whole.slice(5_000, latest.next ?? whole.length));
						expect(toolResults(ai.requests[4]!)[3]).toMatchObject({
							error: expect.stringContaining('omit call')
						});
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live(
		'host tools learn the person and conversation, readOnly ones serve plan mode, a slow one becomes a job collected with wait; host skills merge (parity 1.13, 1.17, 1.6)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const seen: HostToolContext[] = [];
					let finish!: (v: Json) => void;
					const tools: HostTool[] = [
						{
							name: 'studio_read',
							description: 'Read the draft',
							input: { type: 'object' },
							readOnly: true,
							call: async (_i, ctx) => {
								seen.push(ctx);
								return 'draft';
							}
						},
						{
							name: 'studio_validate',
							description: 'Validate',
							input: { type: 'object' },
							call: () =>
								new Promise<Json>((r) => {
									finish = r;
								})
						}
					];
					const fixture = yield* setup(
						[
							use('studio_read', {}),
							say('planned'),
							use('studio_validate', {}),
							(req) => {
								finish({ valid: true });
								return use('wait', { seconds: 5 })(req);
							},
							say('valid'),
							use('skill', { name: 'authoring', section: 'Rules' }),
							say('read')
						],
						{
							hostTools: async () => tools,
							hostInlineMs: 20,
							skills: async () => ({
								authoring:
									'---\ndescription: Author a workspace\n---\n## Rules\nOne file per collection.'
							})
						}
					);
					return yield* Effect.gen(function* () {
						const { ai, agent, user } = fixture;
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* post(agent, c, root, 'plan', { mode: 'plan' });
						yield* agent.drain(c);
						expect(toolNames(ai.requests[0])).toContain('studio_read');
						expect(toolNames(ai.requests[0])).not.toContain('studio_validate');
						expect(seen[0]).toMatchObject({ actor: { kind: 'member', id: root }, conversation: c });
						yield* agent.discardPlan(c);
						yield* post(agent, c, root, 'validate');
						yield* agent.drain(c);
						expect(toolResults(ai.requests[3]!).at(-1)).toMatchObject({ job: expect.any(String) });
						expect(toolResults(ai.requests[4]!).at(-1)).toMatchObject({
							settled: { label: 'studio_validate', result: { valid: true } }
						});
						yield* post(agent, c, root, 'how do I author?');
						yield* agent.drain(c);
						expect(toolResults(ai.requests[6]!).at(-1)).toBe('## Rules\nOne file per collection.');
						const bob = yield* user('bob', { team: 'reader' });
						const d = yield* agent.start({ owner: bob });
						yield* post(agent, d, bob, 'hi');
						yield* Effect.result(agent.drain(d));
						expect(toolNames(ai.requests[7])).not.toContain('studio_read');
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live('geocode is offered when the host binds a geocoder (parity 1.5)', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fixture = yield* setup([use('geocode', { query: '1 Main St' }), say('ok')], {
					geocoder: {
						search: () =>
							Effect.succeed([
								{ point: { lat: 1.3, lng: 103.8 }, label: 'Main', address: '1 Main St' }
							]),
						reverse: () => Effect.succeed(null)
					}
				});
				return yield* Effect.gen(function* () {
					const { ai, agent, user } = fixture;
					const root = yield* user('root', { admin: true });
					const c = yield* agent.start({ owner: root });
					yield* post(agent, c, root, 'where');
					yield* agent.drain(c);
					expect(toolResults(ai.requests[1]!)[0]).toEqual([
						{ label: 'Main', address: '1 Main St', location: { lat: 1.3, lng: 103.8 } }
					]);
				}).pipe(Effect.provide(fixture.context));
			})
		)
	);

	it.live(
		'in-app attachments are listed as file references and read with read_attachment; images beyond the budget drop the oldest (parity 1.9, 2.10)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let seq = 0;
					const nine: Step = () =>
						answer({
							content: '',
							toolCalls: Array.from({ length: 9 }, (_, i) => ({
								id: `r${i}`,
								name: 'read_attachment',
								input: { seq, file: i, as: 'image' }
							})),
							finish: 'tool',
							usage: { input: 1, output: 1 }
						});
					const fixture = yield* setup([nine, say('seen')], {
						attachments: {
							read: () => Effect.succeed({ mime: 'image/png', bytes: new Uint8Array(4) })
						}
					});
					return yield* Effect.gen(function* () {
						const { ai, agent, user } = fixture;
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						const files = Array.from({ length: 9 }, (_, i) => ({
							id: randomUUID(),
							name: `p${i}.png`,
							mime: 'image/png'
						}));
						seq = (yield* agent.post({
							conversation: c,
							as: { member: root },
							text: 'look',
							files
						})).seq;
						yield* agent.drain(c);
						expect(JSON.stringify(ai.requests[0]!.messages)).toContain(
							JSON.stringify(`file reference ${JSON.stringify(files[0])}`).slice(1, -1)
						);
						expect(ai.requests[1]!.files).toHaveLength(8);
						expect(toolResults(ai.requests[1]!).at(-1)).toMatchObject({
							dropped: expect.stringContaining('1 older')
						});
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live('read_attachment sends a PDF to the next model step as a document', () =>
		Effect.scoped(
			Effect.gen(function* () {
				let seq = 0;
				const fixture = yield* setup(
					[
						() =>
							answer({
								content: '',
								toolCalls: [{ id: 'pdf', name: 'read_attachment', input: { seq, as: 'document' } }],
								finish: 'tool',
								usage: { input: 1, output: 1 }
							}),
						say('seen')
					],
					{
						attachments: {
							read: () =>
								Effect.succeed({ mime: 'application/pdf', bytes: new Uint8Array([37, 80, 68, 70]) })
						}
					}
				);
				return yield* Effect.gen(function* () {
					const { ai, agent, user } = fixture;
					const root = yield* user('root', { admin: true });
					const c = yield* agent.start({ owner: root });
					seq = (yield* agent.post({
						conversation: c,
						as: { member: root },
						text: 'inspect the report',
						files: [{ id: randomUUID(), name: 'report.pdf', mime: 'application/pdf' }]
					})).seq;
					yield* agent.drain(c);
					expect(ai.requests[1]!.files).toMatchObject([{ mime: 'application/pdf' }]);
					expect(toolResults(ai.requests[1]!)[0]).toMatchObject({
						attached: 'the file is attached to your next step'
					});
				}).pipe(Effect.provide(fixture.context));
			})
		)
	);

	it.live(
		'inbound rows carry their envelope; read_messages reads unread ambient rows once, oldest first, without revoked ones; revokes and edits converge without rewriting an admitted row (parity 2.9, 1.8, 2.19)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup([
						use('read_messages', {}, 'r1'),
						use('read_messages', {}, 'r2'),
						say('ok')
					]);
					return yield* Effect.gen(function* () {
						const { t, ai, agent, user } = fixture;
						const ann = yield* user('ann', { team: 'rep' });
						const group = '1203@g.us',
							wire = (id: string, text: string, o: { [k: string]: Json } = {}) =>
								t.receive('field', {
									id,
									thread: group,
									group: true,
									sentAt: t.clock.now(),
									from: { handle: `${id}@s.whatsapp.net`, name: `Sender ${id}` },
									text,
									attachments: [],
									...o
								});
						yield* wire('A', 'site 14 photo');
						yield* wire('B', 'wrong message');
						yield* wire('C', 'crane is late');
						yield* t.receive('field', { id: 'B', deleted: true }); // a bare revoke: the id alone
						const c = conversationId('field', group);
						yield* agent.post({
							conversation: c,
							as: { member: ann },
							text: '@bot anything new?',
							author: 'Ann'
						});
						yield* agent.drain(c);
						expect(JSON.stringify(ai.requests[0]!.messages.at(-1))).toContain(
							'2 unread chat messages'
						);
						const first = toolResult(
							Schema.Struct({
								messages: Schema.Array(
									Schema.Struct({
										text: Schema.String,
										sender: Schema.String,
										message: Schema.String
									})
								)
							}),
							ai.requests[1]!,
							0
						);
						expect(first.messages.map((m) => m.text)).toEqual(['site 14 photo', 'crane is late']);
						expect(first.messages[0]).toMatchObject({ sender: 'A@s.whatsapp.net', message: 'A' });
						expect(toolResults(ai.requests[2]!)[1]).toMatchObject({ messages: [] });
						// an admitted row is the transcript: an edit or a revoke never rewrites it; an unadmitted one converges
						yield* t.db.write({
							text: `UPDATE sys_message SET role = 'user', state = 'consumed', content = jsonb_build_object('text', text) WHERE provider_id = 'A'`,
							params: []
						});
						yield* wire('A', 'edited', {
							version: new Date(Date.parse(t.clock.now()) + 1000).toISOString()
						});
						yield* wire('C', 'crane is on time', {
							version: new Date(Date.parse(t.clock.now()) + 1000).toISOString()
						});
						yield* t.receive('field', { id: 'A', deleted: true });
						yield* t.receive('field', { id: 'Z', deleted: true });
						yield* wire('Z', 'revoked before it arrived');
						const rows = (yield* t.db.read([
							{
								text: `SELECT provider_id, text, deleted_at IS NOT NULL AS deleted FROM sys_message WHERE integration = 'field' ORDER BY provider_id`,
								params: []
							}
						]))[0]!.rows;
						expect(rows).toEqual([
							{ provider_id: 'A', text: 'site 14 photo', deleted: true },
							{ provider_id: 'B', text: '', deleted: true },
							{ provider_id: 'C', text: 'crane is on time', deleted: false },
							{ provider_id: 'Z', text: '', deleted: true }
						]);
						const envelope = Schema.decodeUnknownSync(Schema.String)(
							messages([(yield* agent.transcript(c)).find((r) => r.provider_id === 'A')!])[0]!
								.content
						);
						expect(envelope).toMatch(
							/^\[.*Sender A · ambient · chat .* · message A · sender A@s\.whatsapp\.net\]\nsite 14 photo$/
						);
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);
});

describe('durable turns (rule 48)', () => {
	it.live(
		'a turn whose process died is taken over by its agent.turn run once the lease lapses, and never runs twice at once',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup(
						[say('recovered')],
						{},
						new Date(yield* Clock.currentTimeMillis).toISOString()
					);
					return yield* Effect.gen(function* () {
						const { t, ai, agent, user } = fixture;
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* agent.post({ conversation: c, as: { member: root }, text: 'hi' });
						// another process claimed the turn (its lease and its takeover run) and died before its first step
						yield* t.db.write({
							text: `WITH c AS (UPDATE sys_conversation SET status = 'running', lease_until = $2::timestamptz + interval '3 minutes' WHERE id = $1 RETURNING id)
				INSERT INTO sys_run (id, automation, input, due_at, cause, depth) VALUES (gen_random_uuid()::text, 'agent.turn', jsonb_build_object('conversation', $1::text), $2::timestamptz + interval '1 minute', 'schedule', 0)`,
							params: [c, t.clock.now()]
						});
						expect((yield* agent.drain(c)).ran).toBe(false);
						t.clock.advance('2min');
						yield* t.runDue(); // the lease is still live: the run looks again later, and nothing ran
						expect(ai.requests).toHaveLength(0);
						yield* t.db.write({
							text: `UPDATE sys_conversation SET lease_until = $2::timestamptz - interval '1 second' WHERE id = $1`,
							params: [c, t.clock.now()]
						});
						t.clock.advance('2min');
						yield* t.runDue();
						expect(ai.requests).toHaveLength(1);
						expect((yield* agent.transcript(c)).at(-1)).toMatchObject({
							role: 'assistant',
							text: 'recovered'
						});
						expect(
							(yield* t.db.read([
								{
									text: `SELECT count(*)::int AS n FROM sys_run WHERE automation = 'agent.turn' AND state = 'queued'`,
									params: []
								}
							]))[0]!.rows[0]
						).toEqual({ n: 0 });
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);
});

describe('counting is one aggregate read (hr: "why did turnover spike in March 2026" took 24 reads)', () => {
	it.live(
		'the read tool offers aggregate with count and by (time buckets named), and a grouped aggregate needs no limit from the model',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup([
						use('read', { collection: 'quotes', aggregate: { count: true, by: 'region' } }),
						say('Two north, one south.')
					]);
					return yield* Effect.gen(function* () {
						const { t, ai, agent, user, route } = fixture;
						const root = yield* user('root', { admin: true });
						expect(
							(yield* actReply(route, compileAuthority(manifest, t.admin, 'quotes-fixture'), {
								callable: 'quotes.create',
								input: [
									{ title: 'a', region: 'north' },
									{ title: 'b', region: 'north' },
									{ title: 'c', region: 'south' }
								],
								issuedAt: t.clock.now()
							})).outcome.kind
						).toBe('committed');
						const c = yield* agent.start({ owner: root });
						yield* agent.post({
							conversation: c,
							as: { member: root },
							text: 'How many quotes per region?'
						});
						yield* agent.drain(c);
						const read = ai.requests[0]!.tools!.find((x) => x.name === 'read')!;
						expect(read.description).toContain('aggregate');
						expect(read.description).toContain('by: { month:');
						expect(
							Schema.decodeUnknownSync(
								Schema.Struct({
									properties: Schema.Struct({
										aggregate: Schema.Struct({
											properties: Schema.Record(Schema.String, Schema.Json)
										})
									})
								})
							)(read.input).properties.aggregate.properties
						).toMatchObject({ count: {}, by: {} });
						expect(ai.requests[0]!.system).toContain('one aggregate read');
						const answer = JSON.stringify(toolResults(ai.requests[1]!)[0]);
						expect(answer).not.toContain('error');
						expect(answer).toContain('north');
						expect(answer).toContain('2');
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);
});

describe('a turn never settles silently (staging: 12 failing reads, then an empty reply)', () => {
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
		'a bad filter names the field and the valid ones; identical failing calls are cut short; an empty reply ends with a visible message',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const bad = use('read', { collection: 'quotes', where: { month: '2026-03' } });
					const fixture = yield* setup([
						...Array.from({ length: 12 }, () => bad),
						say(''),
						say(''),
						say(''),
						say('')
					]);
					return yield* Effect.gen(function* () {
						const { ai, agent, user } = fixture;
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* agent.post({
							conversation: c,
							as: { member: root },
							text: 'Why did turnover spike in March 2026?'
						});
						yield* agent.drain(c);
						// actionable: the bad path, and what may be named instead
						expect(toolResults(ai.requests[1]!)[0]).toMatchObject({
							error: expect.stringContaining("unknown field 'month'"),
							fields: ['title', 'region']
						});
						// the fourth identical call is not run again
						expect(toolResults(ai.requests[4]!).at(-1)).toMatchObject({
							error: expect.stringContaining('Not run')
						});
						expect(
							ai.requests[4]!.messages.some((m) => String(m.content).includes(NUDGE.failing))
						).toBe(true);
						const rows = yield* agent.transcript(c);
						// staff see the real failure, not the cut-short
						expect(visible(rows)).toEqual([
							expect.objectContaining({
								text: FIXED.stuck,
								meta: expect.objectContaining({
									tag: 'failed',
									code: 'toolFailures',
									detail: expect.stringContaining("unknown field 'month'")
								})
							})
						]);
						expect((yield* agent.conversation(c)).status).toBe('idle');
						expect(ai.requests).toHaveLength(6);
					}).pipe(Effect.provide(fixture.context));
				})
			)
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

	it.live(
		'an empty reply after a successful read is asked for once more, then answered with a visible message',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup([use('read', { collection: 'quotes' }), say(''), say('')]);
					return yield* Effect.gen(function* () {
						const { agent, user } = fixture;
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* agent.post({ conversation: c, as: { member: root }, text: 'summarise' });
						const { reply } = yield* agent.drain(c);
						expect(reply).toMatchObject({ meta: { tag: 'failed', code: 'emptyReply' } });
						expect(reply?.text).toBe(FIXED.empty);
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);
});

describe('reasoning and metering (L-BOLT-412, L-BOLT-432, L-BOLT-547)', () => {
	const events = (t: Kit) =>
		t.db.rows(Schema.Struct({ severity: Schema.String, attributes: Schema.Json }), {
			text: `SELECT severity, attributes FROM sys_event WHERE event = 'ai.call' ORDER BY id`,
			params: []
		});
	it.live(
		'reasoning is stored verbatim beside the text (the literal "None." too) and goes back to the model; a reasoning-only reply is kept and continued once',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const thinks: Step = () =>
						Stream.concat(
							Stream.succeed<AiEvent>({ _tag: 'Progress', reasoning: 'Thinking.' }),
							answer({
								content: '',
								toolCalls: [],
								finish: 'stop',
								reasoning: 'Thinking.',
								usage: { input: 1, output: 1 }
							})
						);
					const answers: Step = () =>
						answer({
							content: 'Balanced.',
							toolCalls: [],
							finish: 'stop',
							reasoning: 'None.',
							usage: { input: 1, output: 1 }
						});
					const fixture = yield* setup([thinks, answers, say('again')]);
					return yield* Effect.gen(function* () {
						const { ai, agent, user } = fixture;
						const root = yield* user('root', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* agent.post({ conversation: c, as: { member: root }, text: 'payroll?' });
						const { reply } = yield* agent.drain(c);
						expect(reply?.content).toMatchObject({ text: 'Balanced.', reasoning: 'None.' });
						const assistant = (yield* agent.transcript(c)).filter((r) => r.role === 'assistant');
						expect(assistant.map((r) => r.content)).toMatchObject([
							{ text: '', reasoning: 'Thinking.' },
							{ text: 'Balanced.', reasoning: 'None.' }
						]);
						expect(ai.requests[1]!.messages).toContainEqual({
							role: 'user',
							content: `[note]\n${NUDGE.empty}`
						});
						expect(ai.requests[1]!.messages).toContainEqual({
							role: 'assistant',
							content: { text: '', toolCalls: [], reasoning: 'Thinking.' }
						});
						yield* agent.post({ conversation: c, as: { member: root }, text: 'and?' });
						yield* agent.drain(c);
						expect(ai.requests[2]!.messages).toContainEqual(
							expect.objectContaining({
								role: 'assistant',
								content: expect.objectContaining({ reasoning: 'None.' })
							})
						);
					}).pipe(Effect.provide(fixture.context));
				})
			)
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
						expect(yield* events(t)).toEqual([
							{
								severity: 'warn',
								attributes: {
									call: 'gen-1',
									model: 'default',
									input: 3,
									output: 1,
									cost: 6,
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
									settlement: 'attention'
								}
							}
						]);
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);

	it.live(
		'a checkpoint names who asked for it, and input still queued at the boundary stays in what the model reads (L-BOLT-546)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* setup([
						say('| Section | Summary |\n|---|---|\n| Goal | g |'),
						say('Seen.')
					]);
					return yield* Effect.gen(function* () {
						const { ai, agent, user } = fixture;
						const root = yield* user('root', { admin: true }),
							ann = yield* user('ann', { admin: true });
						const c = yield* agent.start({ owner: root });
						yield* agent.post({
							conversation: c,
							as: { member: root },
							text: '/compact',
							mode: 'compact'
						});
						const queued = yield* agent.post({
							conversation: c,
							as: { member: ann },
							text: 'late one'
						}); // another sender: claimed at the next step
						yield* agent.drain(c);
						const checkpoint = (yield* agent.transcript(c)).find((r) => r.meta?.tag === 'compact')!;
						expect(checkpoint.meta).toMatchObject({ origin: 'manual', keep: [queued.id] });
						expect(JSON.stringify(ai.requests[1]!.messages)).toContain('late one');
					}).pipe(Effect.provide(fixture.context));
				})
			)
	);
});
