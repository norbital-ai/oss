import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Option, Result, Schema, Stream } from 'effect';
import { Ai } from '../src/engine/ports.ts';
import { Agents } from '../src/engine/services.ts';
import { decode_projected_manifest } from '../src/engine/manifest.ts';
import { id_of } from '../src/decl/id.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { teams_sql } from './support/teams.ts';
import { with_accounts } from './support/accounts.ts';
import { classifierConfigOf, connectionAllowsAutomation, decodeClassifierConfig, normalizeClassifierConfig } from '../src/engine/integrations/scope.ts';
import { Port, type AiRequest, type AiResponse } from '@norbital-ai/host-api';

const integrationId = Schema.decodeUnknownSync(id_of('sys_integration'));

const manifest = Result.getOrThrow(
	decode_projected_manifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			notes: {
				description: 'Filed notes',
				record_label: 'record.body',
				fields: {
					body: { kind: 'text' },
					source_message: { kind: 'ref', to: 'sys_message', optional: true }
				}
			}
		},
		relationships: {},
		exposures: {
			notes: {
				outputs: { default: { notes: { fields: 'all' } } },
				create: { columns: { notes: ['body', 'source_message'] } }
			}
		},
		integrations: {
			erp: {
				description: 'HTTP ERP',
				driver: 'http'
			}
		},
		policies: {
			filer: {
				description: 'Files inbound messages and reads attachments',
				grants: {
					sys_integration: { outputs: { default: {} } },
					sys_conversation: { outputs: { default: {} } },
					sys_message: { outputs: { default: {} } },
					notes: { outputs: { default: {} }, create: {} }
				}
			}
		},
		automations: {
			on_msg: {
				description: 'Reacts to newly ingested messages',
				policies: ['filer'],
				on: [{ model: 'sys_message', verbs: ['create'] }]
			},
			other_msg: {
				description: 'Secondary message listener',
				policies: ['filer'],
				on: [{ model: 'sys_message', verbs: ['create'] }]
			}
		},
		mcp: {},
		apps: {},
		custom_fields: {},
		agent: { internal: 'Staff brief.', skills: {} }
	})
);

const guestSource = `import { Effect } from 'effect';
export default {
	automation: {
		on_msg: {
			body: function* (_input, ctx) {
				const id = ctx.trigger?.records?.[0];
				if (!id) return;
				const msgs = yield* ctx.query({ sys_message: { where: { id: { eq: id } }, fields: ['text', 'conversation'], limit: 1 } });
				const row = msgs.sys_message.rows[0];
				yield* ctx.act({ 'notes.create': [{ body: 'on_msg:' + (row?.text ?? ''), source_message: id }] });
				if (!row?.conversation) return;
				const convs = yield* ctx.query({ sys_conversation: { where: { id: { eq: row.conversation } }, fields: ['inputs'], limit: 1 } });
				const inputs = convs.sys_conversation.rows[0]?.inputs ?? [];
				const own = Array.isArray(inputs) ? inputs.filter((f) => f && typeof f === 'object' && f.message === id && typeof f.id === 'string') : [];
				if (own.length === 0) return;
				const spawned = yield* ctx.ai.sys_2
					.task({
						description: 'Read message and attachment',
						prompt: 'Inspect message ' + id + ' and read its attachment.',
						files: own.map((f) => ({ id: f.id, name: f.name, mime: f.mime }))
					})
					.pipe(Effect.catchTag('Unavailable', (e) => Effect.succeed({ unavailable: e.reason })));
				if ('unavailable' in spawned) {
					yield* ctx.act({ 'notes.create': [{ body: 'fallback:' + spawned.unavailable, source_message: id }] });
				}
				return spawned;
			}
		},
		other_msg: {
			body: function* (_input, ctx) {
				const id = ctx.trigger?.records?.[0];
				if (!id) return;
				const msgs = yield* ctx.query({ sys_message: { where: { id: { eq: id } }, fields: ['text'], limit: 1 } });
				const row = msgs.sys_message.rows[0];
				yield* ctx.act({ 'notes.create': [{ body: 'other_msg:' + (row?.text ?? ''), source_message: id }] });
			}
		}
	}
};`;

const runtime_accounts = [
	{ id: 'wa_smart', integration: 'whatsapp', status: { state: 'connected' } },
	{ id: 'mail_in', integration: 'email', status: { state: 'connected' } },
	{ id: 'erp_http', integration: 'erp', status: { state: 'connected' } }
] as const;

describe('channel classifier config helpers', () => {
	it('defaults to smart and normalizes instructions and disabled automations', () => {
		expect(classifierConfigOf(null)).toBeNull();
		expect(connectionAllowsAutomation(null, 'on_msg')).toBe(true);
		expect(normalizeClassifierConfig({ mode: 'all', instructions: '  Keep invoices  ', disabled_automations: ['b', 'a', 'b', ''] })).toEqual({
			mode: 'all',
			instructions: 'Keep invoices',
			disabled_automations: ['a', 'b']
		});
		expect(Option.isNone(decodeClassifierConfig({ mode: 'invalid' }))).toBe(true);
		expect(connectionAllowsAutomation({ mode: 'off' }, 'on_msg')).toBe(false);
		expect(connectionAllowsAutomation({ mode: 'smart', disabled_automations: ['on_msg'] }, 'on_msg')).toBe(false);
		expect(connectionAllowsAutomation({ mode: 'smart', disabled_automations: ['on_msg'] }, 'other_msg')).toBe(true);
	});
});

describe('channel classifier, reactive sys_message triggers, and unified agent message/file access', () => {
	it.live('validates classifier on sys_integration, gates reactive sys_message automations, and exposes read_messages + attachment reads to system agents', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const aiRequests: AiRequest[] = [];
				let step = 0;
				const fileIdFromReq = (req: AiRequest): string => {
					const raw = JSON.stringify(req.messages);
					const match = /"files":\[\{"id":"([^"]+)"/.exec(raw);
					return match?.[1] ?? '';
				};
				const scripted: ((req: AiRequest) => AiResponse)[] = [
					() => ({
						content: '',
						tool_calls: [{ id: 'tc-1', name: 'read_messages', input: { integration: 'wa_smart', limit: 5 } }],
						finish: 'tool',
						usage: { input: 10, output: 10 }
					}),
					(req) => ({
						content: '',
						tool_calls: [{ id: 'tc-2', name: 'read_file', input: { id: fileIdFromReq(req) } }],
						finish: 'tool',
						usage: { input: 10, output: 10 }
					}),
					() => ({
						content: 'Inspected message and file.',
						tool_calls: [],
						finish: 'stop',
						usage: { input: 10, output: 10 }
					})
				];
				const aiLayer = Layer.succeed(Ai, {
					models: ['default'],
					infer: (req) =>
						Stream.suspend(() => {
							aiRequests.push(req);
							const pick = scripted[Math.min(step++, scripted.length - 1)] ?? scripted[0];
							if (pick === undefined) return Stream.empty;
							return Stream.succeed({ _tag: 'Response' as const, response: pick(req) });
						}),
					ask: () => Port.unavailable('ai.ask'),
					maxChoices: undefined,
					deciders: Effect.succeed({ models: [], default: '' }),
					catalog: Port.unavailable('ai.catalog'),
					embed: () => Port.unavailable('ai.embed')
				});

				const ctx = yield* Layer.build(
					with_accounts(
						TestWorkspace.layer({
							manifest,
							guest: yield* program(guestSource),
							ports: aiLayer
						}),
						runtime_accounts
					)
				);
				const t = Context.get(ctx, TestWorkspace);
				const agents = Context.get(ctx, Agents);
				yield* t.db.write({ text: teams_sql({ team_filer: { policies: ['filer'] } }), params: [] });
				const admin = yield* t.as(t.admin);

				// 1. Classifier is accepted on conversation integrations (whatsapp/email) and refused on HTTP/data integrations
				const badHttp = yield* Effect.flip(
					admin.act({
						'sys_integration.update': [
							{ target: { id: integrationId('erp_http') }, set: { classifier: { mode: 'all' } } }
						]
					})
				);
				expect(badHttp._tag).toBe('ActRefused');

				const setSmart = yield* admin.act({
					'sys_integration.update': [
						{
							target: { id: integrationId('wa_smart') },
							set: {
								classifier: {
									mode: 'smart',
									instructions: 'File supplier PO updates',
									disabled_automations: ['other_msg']
								}
							}
						}
					]
				});
				expect(setSmart.kind).toBe('committed');

				// 2. Inbound message with attachment fires `on_msg`, skips disabled `other_msg`
				const fileBytes = new TextEncoder().encode('PO-9001 approved for steel delivery.');
				yield* t.receive(
					'wa_smart',
					[
						{
							id: 'wa-msg-1',
							thread: '6590001111@s.whatsapp.net',
							from: { handle: '6590001111@s.whatsapp.net', name: 'Vendor A' },
							text: 'Attached PO-9001 confirmation',
							attachments: [
								{
									name: 'po-9001.txt',
									mime: 'text/plain',
									bytes: fileBytes.byteLength,
									bin: 0
								}
							],
							sent_at: t.clock.now()
						}
					],
					{ bins: [fileBytes] }
				);
				yield* t.run_due();
				yield* t.settled();

				const notesAfterFirst = yield* t.db.rows(
					Schema.Struct({ body: Schema.String, source_message: Schema.NullOr(Schema.String) }),
					{ text: 'SELECT body, source_message FROM notes ORDER BY body', params: [] }
				);
				expect(notesAfterFirst).toHaveLength(1);
				expect(notesAfterFirst[0]?.body).toBe('on_msg:Attached PO-9001 confirmation');
				const msgId = notesAfterFirst[0]?.source_message;
				expect(typeof msgId).toBe('string');

				// 3. Setting classifier.mode = 'off' suppresses ALL reactive sys_message automations for that connection
				const setOff = yield* admin.act({
					'sys_integration.update': [
						{ target: { id: integrationId('wa_smart') }, set: { classifier: { mode: 'off' } } }
					]
				});
				expect(setOff.kind).toBe('committed');

				yield* t.receive('wa_smart', [
					{
						id: 'wa-msg-2',
						thread: '6590001111@s.whatsapp.net',
						from: { handle: '6590001111@s.whatsapp.net', name: 'Vendor A' },
						text: 'Ignored while classifier is off',
						attachments: [],
						sent_at: t.clock.now()
					}
				]);
				yield* t.run_due();
				yield* t.settled();

				const notesAfterOff = yield* t.db.rows(Schema.Struct({ body: Schema.String }), {
					text: 'SELECT body FROM notes ORDER BY body',
					params: []
				});
				expect(notesAfterOff.map((n) => n.body)).toEqual(['on_msg:Attached PO-9001 confirmation']);

				// 4. Locate the stored attachment file id (field = sys_conversation.inputs)
				const fileRows = yield* t.db.rows(
					Schema.Struct({ id: Schema.String, name: Schema.String, mime: Schema.String, field: Schema.String }),
					{ text: "SELECT id, name, mime, field FROM sys_file WHERE name = 'po-9001.txt'", params: [] }
				);
				expect(fileRows).toHaveLength(1);
				const fileRow = fileRows[0];
				if (fileRow === undefined || typeof msgId !== 'string')
					throw new Error('Missing ingested message or attachment');
				expect(fileRow.field).toBe('sys_conversation.inputs');

				// 5. Reactive automation spawned a System Agent with `files` attached; verify it called `read_messages` + `read_file`
				const taskConvs = yield* t.db.rows(Schema.Struct({ id: Schema.String }), {
					text: "SELECT id FROM sys_conversation WHERE kind = 'task' LIMIT 1",
					params: []
				});
				const taskConv = taskConvs[0]?.id;
				if (taskConv === undefined) throw new Error('Missing system agent task conversation');
				yield* agents.drain(taskConv).pipe(Effect.provide(ctx));

				const transcript = yield* agents.transcript(taskConv).pipe(Effect.provide(ctx));
				const readMsgTool = transcript.find((r) => r.role === 'tool' && r.content.id === 'tc-1');
				const readFileTool = transcript.find((r) => r.role === 'tool' && r.content.id === 'tc-2');
				expect(readMsgTool?.role).toBe('tool');
				expect(readFileTool?.role).toBe('tool');
				if (readMsgTool?.role === 'tool') {
					const payload = yield* Schema.decodeUnknownEffect(
						Schema.Struct({
							messages: Schema.Array(
								Schema.Struct({
									id: Schema.String,
									integration: Schema.NullOr(Schema.String),
									text: Schema.NullOr(Schema.String),
									files: Schema.optionalKey(
										Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.optionalKey(Schema.String) }))
									)
								})
							)
						})
					)(readMsgTool.content.result);
					expect(payload.messages.length).toBeGreaterThanOrEqual(1);
					const withFile = payload.messages.find((m) => m.id === msgId);
					expect(withFile?.integration).toBe('wa_smart');
					expect(withFile?.files?.[0]?.id).toBe(fileRow.id);
				}
				if (readFileTool?.role === 'tool') {
					const content = JSON.stringify(readFileTool.content.result);
					expect(content).toContain('PO-9001 approved for steel delivery.');
				}
				expect(aiRequests.length).toBe(3);

				// 6. Turning off automation system agents causes ctx.ai.sys_2.task to fail with catchable Unavailable
				yield* t.db.write({
					text: `INSERT INTO sys_config (key, value) VALUES ('agent', '{"monthly":null,"member":null,"policies":{},"models":[],"system1":null,"system2":null,"system":{"improve":false,"automations":false,"policies":[],"monthly":10,"task":1}}'::jsonb)
						ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
					params: []
				});
				yield* admin.act({
					'sys_integration.update': [
						{ target: { id: integrationId('wa_smart') }, set: { classifier: { mode: 'smart', disabled_automations: ['other_msg'] } } }
					]
				});
				yield* t.receive(
					'wa_smart',
					[
						{
							id: 'wa-msg-3',
							thread: '6590001111@s.whatsapp.net',
							from: { handle: '6590001111@s.whatsapp.net', name: 'Vendor A' },
							text: 'Fallback check',
							attachments: [{ name: 'note.txt', mime: 'text/plain', bytes: fileBytes.byteLength, bin: 0 }],
							sent_at: t.clock.now()
						}
					],
					{ bins: [fileBytes] }
				);
				yield* t.run_due();
				yield* t.settled();
				const fallbackNotes = yield* t.db.rows(Schema.Struct({ body: Schema.String }), {
					text: "SELECT body FROM notes WHERE body LIKE 'fallback:%'",
					params: []
				});
				expect(fallbackNotes).toHaveLength(1);
				expect(fallbackNotes[0]?.body).toContain('turned off agents');
			})
		)
	);
});
