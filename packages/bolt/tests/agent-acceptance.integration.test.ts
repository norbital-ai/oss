// The owner's agent acceptance (2026-09-26) through the engine entry and the test kit, against a scripted model:
// a skill authored at `src/agent/skill/<n>/+skill.md` is compiled and read by the agent; the workspace's source is a
// generic tool (`workspace_search` for staff in the app, the outline in the prompt); an MCP server reaches its URL and token through the workspace secrets with no host MCP binding; and an envoy over a
// fake WhatsApp: group chatter System 1 ignores gets nothing, a mention is answered, a DM is answered after triage.
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll } from 'vitest';
import { describe, expect, it } from '@effect/vitest';
import { ConfigProvider, Context, Effect, Layer, Redacted, Result, Schema, Stream } from 'effect';
import { randomBytes } from 'node:crypto';
import { Ai } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { Agents } from '../src/engine/services.ts';
import { Secrets } from '../src/engine/secrets.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import type { Json } from '../src/decl/values.ts';
import type { AiRequest, AiResponse } from '../src/engine/contracts.ts';
import type { WorkspacePort } from '../src/engine/agent/tools.ts';
import type { DecisionAnswer } from '../src/engine/decisions/index.ts';
import { TRIAGE_DEBOUNCE } from '../src/engine/agent/triage.ts';
import { respondSystem1, TestWorkspace, type TestOptions } from '../src/test/index.ts';

const GOOD = fileURLToPath(new URL('./fixtures/good', import.meta.url));
type Step = (req: AiRequest) => AiResponse;
const say =
	(text: string): Step =>
	() => ({ content: text, toolCalls: [], finish: 'stop', usage: { input: 10, output: 5 } });
const use =
	(name: string, input: Json): Step =>
	() => ({
		content: '',
		toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name, input }],
		finish: 'tool',
		usage: { input: 10, output: 5 }
	});
function cassette(steps: Step[], ask: Ai['Service']['ask'] = respondSystem1) {
	const requests: AiRequest[] = [];
	const ports = Layer.succeed(Ai, {
		ask,
		maxChoices: undefined,
		models: ['default'],
		catalog: Port.unavailable('ai.catalog'),
		embed: () => Port.unavailable('ai.embed'),
		infer: (req) =>
			Stream.fromEffect(
				Effect.try({
					try: () => {
						requests.push(req);
						const step = steps.shift();
						if (step === undefined) throw new Error('cassette exhausted');
						return { _tag: 'Response' as const, response: step(req) };
					},
					catch: Port.failure('ai')
				})
			)
	});
	return { ports, requests };
}
const setup = (options: TestOptions<Ai>) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			TestWorkspace.layer({ ...options, secretsKey: Redacted.make(randomBytes(32)) })
		);
		return {
			context,
			t: Context.get(context, TestWorkspace),
			agent: Context.get(context, Agents),
			secrets: Context.get(context, Secrets)
		};
	});

const names = (r: AiRequest | undefined) => (r?.tools ?? []).map((t) => t.name);
/**
 * The tools a request's prompt names but does not offer. A prompt naming a tool the turn lacks is a call to nothing:
 * staging's WhatsApp envoy called workspace_search, and its tool-call markup went out as a chat message.
 */
const unoffered = (r: AiRequest) =>
	[...new Set(r.system?.match(/\b(?:read|write|workspace|update|sandbox)_[a-z_]+\b/g))].filter(
		(n) => !names(r).includes(n)
	);
const results = (r: AiRequest) =>
	r.messages
		.filter((m) => m.role === 'tool')
		.map((m) => Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Json }))(m.content).result);
const member = (id: string, o: { admin?: boolean; external?: boolean } = {}) => ({
	text: `INSERT INTO sys_user (id, email, name, admin, kind) VALUES ($1, $2, $3, $4, $5)`,
	params: [id, `${id}@x.test`, id, o.admin ?? false, o.external ? 'external' : 'staff']
});

// a page longer than one read: quotes and tabs grow when encoded, as a Svelte page's do
const DESK = 'src/app/crm/+desk.page.svelte';
const desk = Array.from(
	{ length: 1500 },
	(_, n) => `\t<td class="col">{row["field_${n + 1}"]}</td>`
).join('\n');
/** The artifact's workspace as a host binds it (`workspaceFiles`). */
const workspace: WorkspacePort = {
	files: async () => ['src/agent/skill/triage/+skill.md', 'src/data/model/orders/+model.ts'],
	read: async (p) =>
		p === 'src/agent/skill/triage/+skill.md'
			? '---\ndescription: Triage a notice\n---\n## Steps\nRead it.\n'
			: p === DESK
				? desk
				: null
};

const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: {
			tz: 'UTC',
			locale: 'en',
			secrets: { HQ_URL: { label: 'HQ' }, HQ_TOKEN: { label: 'HQ token' } }
		},
		models: { jobs: { description: 'A job', label: 'title', fields: { title: { kind: 'text' } } } },
		relationships: {},
		exposures: { jobs: { read: { jobs: { fields: 'all' } } } },
		integrations: {},
		policies: { desk: { description: 'Desk', grants: { jobs: { read: true } } } },
		teams: {},
		automations: {},
		connections: { field_wa: { integration: 'whatsapp', envoy: 'field_ops' } },
		envoys: {
			field_ops: {
				audience: 'public',
				name: 'Norbius',
				policies: ['desk'],
				groupMessages: 'mention_or_reply',
				delegation: 'disabled',
				triage: {},
				task: 'Keep jobs up to date.'
			}
		},
		mcp: { hq: { description: 'HQ tools', url: 'HQ_URL', auth: { bearer: 'HQ_TOKEN' } } },
		apps: {},
		customFields: {},
		agent: { internal: 'Staff brief.', external: 'Customer brief.', skills: {} }
	})
);

describe('skills and the workspace tools (acceptance 1, 3, 8)', () => {
	it.live(
		'a compiled triage/+skill.md is listed in the static prompt beside the source layout and read by the skill tool; workspace_search answers staff',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const ai = cassette([
						use('skill', { name: 'triage', section: 'Steps' }),
						use('workspace_search', { path: 'src/agent/skill/triage/+skill.md' }),
						say('Read it first.')
					]);
					const { t, agent } = yield* setup({
						root: GOOD,
						seed: 'none',
						ports: ai.ports,
						host: { agent: { workspace } }
					});
					yield* t.db.write(member('ann', { admin: true }));
					const c = yield* agent.start({ owner: 'ann' });
					yield* agent.post({
						conversation: c,
						as: { member: 'ann' },
						text: 'How do I triage a notice?'
					});
					expect((yield* agent.drain(c)).reply?.text).toBe('Read it first.');
					expect(ai.requests[0]!.system).toContain('- triage: Triage a notice');
					expect(ai.requests[0]!.system).toContain('# Workspace source');
					expect(names(ai.requests[0])).toEqual(
						expect.arrayContaining(['read', 'act', 'skill', 'workspace_search', 'workspace_list'])
					);
					expect(
						JSON.stringify(ai.requests[0]!.tools?.find((tool) => tool.name === 'read')?.input)
					).toContain('"customers"');
					expect(results(ai.requests[1]!)[0]).toBe('## Steps\n\nRead it.\n');
					expect(results(ai.requests[2]!)[1]).toEqual({
						path: 'src/agent/skill/triage/+skill.md',
						total: 6,
						from: 1,
						to: 6,
						lines: expect.arrayContaining(['4: ## Steps'])
					});
				})
			)
	);

	it.live(
		'a workspace_list identical to the one that just answered is not run again; the list tool says how to read a file',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const ai = cassette([
						use('workspace_list', { path: 'src/' }),
						use('workspace_list', { path: 'src/' }),
						say('listed')
					]);
					const { t, agent } = yield* setup({
						root: GOOD,
						seed: 'none',
						ports: ai.ports,
						host: { agent: { workspace } }
					});
					yield* t.db.write(member('ann', { admin: true }));
					const c = yield* agent.start({ owner: 'ann' });
					yield* agent.post({ conversation: c, as: { member: 'ann' }, text: 'List the files.' });
					yield* agent.drain(c);
					expect(
						ai.requests[0]!.tools?.find((tool) => tool.name === 'workspace_list')?.description
					).toContain('workspace_search { path }');
					expect(results(ai.requests[1]!)[0]).toEqual({
						path: 'src/',
						entries: ['agent/', 'data/']
					});
					expect(results(ai.requests[2]!)[1]).toMatchObject({
						error: expect.stringContaining('you just made this exact call')
					});
				})
			)
	);

	it.live(
		'workspace_search pages a long file as numbered lines with its line count, unclipped; from and to read a range',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const ai = cassette([
						use('workspace_search', { path: DESK }),
						use('workspace_search', { path: DESK, from: 1400, to: 1402 }),
						use('workspace_search', { path: DESK, from: 1490 }),
						say('read')
					]);
					const { t, agent } = yield* setup({
						root: GOOD,
						seed: 'none',
						ports: ai.ports,
						host: { agent: { workspace } }
					});
					yield* t.db.write(member('ann', { admin: true }));
					const c = yield* agent.start({ owner: 'ann' });
					yield* agent.post({ conversation: c, as: { member: 'ann' }, text: 'Read the desk.' });
					yield* agent.drain(c);
					const first = yield* Schema.decodeUnknownEffect(
						Schema.Struct({
							total: Schema.Number,
							from: Schema.Number,
							to: Schema.Number,
							lines: Schema.Array(Schema.String),
							next: Schema.optionalKey(Schema.Number)
						})
					)(results(ai.requests[1]!)[0]);
					expect(first).toMatchObject({ total: 1500, from: 1 });
					expect(first.lines[0]).toBe('1: \t<td class="col">{row["field_1"]}</td>');
					expect(first.lines).toHaveLength(first.to);
					expect(first.next).toBe(first.to + 1);
					expect(JSON.stringify(results(ai.requests[1]!)[0])).not.toContain('clipped');
					expect(results(ai.requests[2]!)[1]).toEqual({
						path: DESK,
						total: 1500,
						from: 1400,
						to: 1402,
						lines: [1400, 1401, 1402].map((n) => `${n}: \t<td class="col">{row["field_${n}"]}</td>`)
					});
					expect(results(ai.requests[3]!)[2]).toMatchObject({
						path: DESK,
						total: 1500,
						from: 1490,
						to: 1500
					});
					expect(results(ai.requests[3]!)[2]).not.toHaveProperty('next');
				})
			)
	);

	it.live('an external member gets no workspace_search and no outline', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const ai = cassette([say('ok')]);
				const { t, agent } = yield* setup({
					manifest,
					ports: ai.ports,
					host: { agent: { workspace } }
				});
				yield* t.db.write(member('eve', { external: true }));
				const c = yield* agent.start({ owner: 'eve' });
				yield* agent.post({ conversation: c, as: { member: 'eve' }, text: 'types?' });
				yield* agent.drain(c);
				expect(names(ai.requests[0])).not.toContain('workspace_search');
				expect(ai.requests[0]!.system).not.toContain('# Workspace outline');
				expect(unoffered(ai.requests[0]!)).toEqual([]);
			})
		)
	);
});

// a local MCP server: stateless streamable HTTP answering JSON
let hq: Server,
	hqUrl = '';
beforeAll(async () => {
	hq = createServer(async (req, res) => {
		if (req.headers.authorization !== 'Bearer tenant-token') {
			res.writeHead(401).end();
			return;
		}
		if (req.method !== 'POST') {
			res.writeHead(405).end();
			return;
		}
		let body = '';
		for await (const c of req) body += String(c);
		const msg = Schema.decodeUnknownSync(
			Schema.fromJsonString(
				Schema.Struct({
					id: Schema.optionalKey(Schema.Number),
					method: Schema.String,
					params: Schema.optionalKey(
						Schema.Struct({
							protocolVersion: Schema.optionalKey(Schema.String),
							arguments: Schema.optionalKey(
								Schema.Struct({ text: Schema.optionalKey(Schema.String) })
							)
						})
					)
				})
			)
		)(body);
		if (msg.id === undefined) {
			res.writeHead(202).end();
			return;
		}
		const result =
			msg.method === 'initialize'
				? {
						protocolVersion: msg.params?.protocolVersion,
						capabilities: { tools: {} },
						serverInfo: { name: 'hq', version: '1' }
					}
				: msg.method === 'tools/list'
					? {
							tools: [
								{
									name: 'echo',
									description: 'Echo text',
									inputSchema: { type: 'object', properties: { text: { type: 'string' } } }
								}
							]
						}
					: { content: [{ type: 'text', text: `echo: ${msg.params?.arguments?.text}` }] };
		res
			.writeHead(200, { 'content-type': 'application/json' })
			.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
	});
	await new Promise<void>((r) => hq.listen(0, '127.0.0.1', r));
	const address = hq.address();
	if (address === null || typeof address === 'string') throw new Error('no MCP server address');
	hqUrl = `http://127.0.0.1:${address.port}/mcp`;
});
afterAll(() => new Promise<void>((r) => hq.close(() => r())));

describe('MCP through the workspace secrets (acceptance 2)', () => {
	it.live(
		'with no host MCP binding, the server URL and token come from the workspace secrets and its tool is called',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const ai = cassette([use('mcp__hq__echo', { text: 'hi' }), say('HQ said hi.')]);
					const values = { HQ_URL: hqUrl, HQ_TOKEN: 'tenant-token' };
					const { context, t, agent, secrets } = yield* setup({ manifest, ports: ai.ports });
					for (const [name, value] of Object.entries(values))
						yield* secrets.set('workspace', name, value);
					yield* t.db.write(member('root', { admin: true }));
					const c = yield* agent.start({ owner: 'root' });
					yield* agent.post({ conversation: c, as: { member: 'root' }, text: 'ask hq' });
					expect(
						(yield* agent
							.drain(c)
							.pipe(
								Effect.provide(context),
								Effect.provideService(ConfigProvider.ConfigProvider, secrets.config)
							)).reply?.text
					).toBe('HQ said hi.');
					expect(names(ai.requests[0])).toContain('mcp__hq__echo');
					expect(results(ai.requests[1]!)[0]).toMatchObject({
						content: [{ type: 'text', text: 'echo: hi' }]
					});
				})
			)
	);
});

describe('an envoy over a fake WhatsApp with System 1 triage (acceptance 7)', () => {
	it.live(
		'group chatter not for Norbius is ignored (no reply, never input); a mention is answered after the pause without a decision; a DM waits, then is answered',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const decided: { kind: string; assistant: string; pending: string[]; asked: string[] }[] =
						[];
					// one verdict per pending message, in one call: the script is read per message, not per conversation
					const script = ['no', 'delay'];
					const sys_1: Ai['Service']['ask'] = (r) =>
						Effect.sync(() => {
							const st = Schema.decodeUnknownSync(
								Schema.Struct({
									conversation: Schema.String,
									assistant: Schema.String,
									pending: Schema.Array(Schema.Struct({ text: Schema.String }))
								})
							)(r.state);
							const asked = Object.keys(r.questions).filter((id) => id !== 'wait');
							decided.push({
								kind: st.conversation,
								assistant: st.assistant,
								pending: st.pending.map((p) => p.text),
								asked
							});
							const answers: Record<string, DecisionAnswer> = {};
							for (const id of asked) {
								const v = script.shift()!;
								answers[id] = {
									type: 'choice',
									choice: v,
									confidence: 0.9,
									probabilities: { [v]: 0.9 }
								};
							}
							answers['wait'] = {
								type: 'score',
								score: 2,
								level: 2,
								confidence: 0.9,
								probabilities: {},
								legend: {}
							};
							return { answers, costUsd: 0.0001, provider: 'scripted' };
						});
					const ai = cassette([say('Noted.'), say('On it.')], sys_1);
					const { t } = yield* setup({ manifest, ports: ai.ports });
					let n = 0;
					const inbound = (from: string, text: string, over: { [k: string]: Json } = {}) =>
						t.receive('field_wa', {
							id: `m${++n}`,
							thread: from,
							sentAt: t.clock.now(),
							from: { handle: from, name: null },
							text,
							attachments: [],
							...over
						});
					const debounce = (s = TRIAGE_DEBOUNCE / 1000) =>
						Effect.gen(function* () {
							t.clock.advance(`${s}s`);
							yield* t.runDue();
						});
					const texts = () =>
						t.fakes.links.sent.map(
							(s) =>
								Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(s.message).text
						);
					const GROUP = { thread: '1203@g.us', group: true };

					// chatter from someone else: a sender's own unaddressed line is context for their next address, another's is not
					yield* inbound('6593330000@s.whatsapp.net', 'lunch at 12?', GROUP);
					yield* debounce();
					expect(decided[0]).toEqual({
						kind: 'envoy group',
						assistant: 'Norbius',
						pending: ['lunch at 12?'],
						asked: ['m0']
					});
					expect(texts()).toEqual([]);
					expect(ai.requests).toHaveLength(0);

					yield* inbound('6591110000@s.whatsapp.net', '@bot the van is late', {
						...GROUP,
						invocation: 'mention'
					});
					yield* debounce(); // held for the sender's pause
					expect(decided).toHaveLength(1); // a mention bypasses System 1
					expect(texts()).toEqual(['Noted.']);
					expect(JSON.stringify(ai.requests[0]!.messages)).not.toContain('lunch at 12?');
					expect(unoffered(ai.requests[0]!)).toEqual([]);

					yield* inbound('6592220000@s.whatsapp.net', 'can you check job 7');
					yield* debounce();
					expect(decided[1]).toEqual({
						kind: 'envoy DM',
						assistant: 'Norbius',
						pending: ['can you check job 7'],
						asked: ['m0']
					});
					expect(texts()).toEqual(['Noted.']); // waiting for more
					yield* debounce(3);
					expect(decided).toHaveLength(2); // one wait at most (TRIAGE_MAX_WAITS): the recheck admits without asking
					expect(texts()).toEqual(['Noted.', 'On it.']);
					expect(t.fakes.links.sent.at(-1)!.message).toMatchObject({
						to: expect.stringContaining('6592220000')
					});
				})
			)
	);

	it.live('one call judges every pending message, and only the one it answers is admitted', () =>
		Effect.scoped(
			Effect.gen(function* () {
				// the shape the decider is asked in: `m0`, `m1`, … each its own yes/no/delay, all in one request. Without this a
				// burst is one verdict for the conversation, so a message that says the name cannot be answered while chatter is
				// ignored — which is exactly the bug that made `hi Norbius` disappear.
				const calls: string[][] = [];
				const sys_1: Ai['Service']['ask'] = (r) =>
					Effect.sync(() => {
						const ids = Object.keys(r.questions).filter((id) => id !== 'wait');
						calls.push(ids);
						const answers: Record<string, DecisionAnswer> = Object.fromEntries(
							ids.map((id, i): readonly [string, DecisionAnswer] => [
								id,
								{
									type: 'choice',
									choice: i === 0 ? 'no' : 'yes',
									confidence: 0.9,
									probabilities: {}
								}
							])
						);
						answers['wait'] = {
							type: 'score',
							score: 0,
							level: 0,
							confidence: 0.9,
							probabilities: {},
							legend: {}
						};
						return { answers, costUsd: 0, provider: 'scripted' };
					});
				const ai = cassette([say('On the van.')], sys_1);
				const { t } = yield* setup({ manifest, ports: ai.ports });
				let n = 0;
				const inbound = (text: string, handle = '6591110000@s.whatsapp.net') =>
					t.receive('field_wa', {
						id: `n${++n}`,
						thread: '1203@g.us',
						sentAt: t.clock.now(),
						from: { handle, name: null },
						text,
						attachments: [],
						group: true
					});
				const texts = () =>
					t.fakes.links.sent.map(
						(s) => Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(s.message).text
					);

				yield* inbound('lunch at 12?', '6593330000@s.whatsapp.net'); // another member's chatter
				yield* inbound('Norbius, the van is late');
				t.clock.advance(`${TRIAGE_DEBOUNCE / 1000}s`);
				yield* t.runDue();

				expect(calls).toEqual([['m0', 'm1']]); // one call, both messages
				expect(texts()).toEqual(['On the van.']);
				expect(JSON.stringify(ai.requests.map((r) => r.messages))).not.toContain('lunch at 12?'); // the `no` never reached the model
			})
		)
	);
});
