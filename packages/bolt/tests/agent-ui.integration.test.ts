// The agent UI's engine half (§5.9): an in-app conversation starts on the workspace's `ai.default`; a failed turn's log
// line and staff row name the real reason; `setAgent`, `file` and `markRead` over `/__bolt/act`; staff
// list the envoy conversations with an unread mark; `read_file` reads an xlsx into std/sheet's cells.
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from '@effect/vitest';
import { parseInstant } from '@norbital-ai/std/date';
import { Context, Effect, Layer, Option, Result, Schema, Stream } from 'effect';
import { Ai } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { Agents, Conversations } from '../src/engine/services.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import { ActReply, AgentRow, WireError } from '../src/protocol/schema.ts';
import { json, routeFixture } from './support/route-fixture.ts';
import { ActRefused, actFailure } from '../src/decl/errors.ts';
import type { Json } from '../src/decl/values.ts';
import type { ActOutcome as Outcome } from '../src/engine/contracts.ts';
import { conversationId } from '../src/engine/conversations/store.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { instanceMessages } from '../src/shell/integration/messages.ts';
import { xlsxCells, xlsxSheets } from '../src/engine/files/xlsx.ts';
import { respondSystem1, TestWorkspace } from '../src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: {
			tz: 'UTC',
			locale: 'en',
			agent: { triage: false },
			ai: { models: ['fast'], default: 'fast' }
		},
		models: {
			quotes: { description: 'A quote', label: 'title', fields: { title: { kind: 'text' } } }
		},
		relationships: {},
		exposures: {
			quotes: { read: { quotes: { fields: 'all' } }, create: { columns: { quotes: ['title'] } } }
		},
		policies: { rep: { description: 'Rep', grants: { quotes: { read: true } } } },
		envoys: {
			field: {
				audience: 'public',
				name: 'Norbius',
				policies: ['rep'],
				triage: false,
				groupMessages: 'disabled',
				delegation: 'disabled',
				task: 'Help.'
			}
		},
		connections: { field: { integration: 'whatsapp', envoy: 'field' } },
		agent: { internal: 'Staff brief.', external: 'Customer brief.', skills: {} },
		integrations: {},
		teams: { 't-ops': { name: 'Ops', policies: ['rep'] } },
		automations: {},
		mcp: {},
		apps: {},
		customFields: {}
	})
);

const setup = () =>
	Effect.gen(function* () {
		// the host maps only `default`: the workspace's `fast` is unmapped, so a turn fails with that reason
		const ports = Layer.succeed(Ai, {
			ask: respondSystem1,
			maxChoices: undefined,
			models: ['default'],
			catalog: Port.unavailable('ai.catalog'),
			embed: () => Port.unavailable('ai.embed'),
			infer: () => Stream.fail(Port.failure('ai')(new Error('not called')))
		});
		const context = yield* Layer.build(TestWorkspace.layer({ manifest, ports }));
		const t = Context.get(context, TestWorkspace),
			agent = Context.get(context, Agents),
			conversations = Context.get(context, Conversations);
		for (const [id, kind] of [
			['ann', 'staff'],
			['bob', 'staff'],
			['cus', 'external']
		] as const)
			yield* t.db.write({
				text: `INSERT INTO sys_user (id, email, name, kind) VALUES ($1, $2, $1, $3)`,
				params: [id, `${id}@x.test`, kind]
			});
		const authorities = new Authorities(manifest, 'test'),
			route = yield* routeFixture(context);
		const call = (
			as: string,
			method: string,
			path: string,
			body?: unknown,
			preview: boolean | string = false
		) =>
			Effect.gen(function* () {
				const own = yield* authorities.member(t.db, as, preview === true);
				const authority =
					typeof preview !== 'string' || own === null || own.actor.kind !== 'member'
						? own
						: yield* authorities.team(t.db, own.actor, preview);
				return yield* route.handle(
					authority,
					new Request(`http://cell${path}`, {
						method,
						headers: { 'content-type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
						...(body === undefined ? {} : { body: JSON.stringify(body) })
					})
				);
			});
		const act = (as: string, callable: string, input: Json, preview: boolean | string = false) =>
			Effect.gen(function* () {
				const raw = yield* json(
					yield* call(
						as,
						'POST',
						'/__bolt/act',
						{ callable, input, issuedAt: t.clock.now() },
						preview
					)
				);
				const refused = Schema.decodeUnknownOption(WireError)(raw);
				if (Option.isSome(refused)) {
					const { _tag, ...fields } = ActRefused.fields;
					void _tag;
					const failure = yield* Schema.decodeUnknownEffect(
						Schema.Struct({ error: Schema.Struct(fields) })
					)(raw);
					return yield* Effect.fail(new ActRefused(failure.error));
				}
				const outcome = (yield* Schema.decodeUnknownEffect(ActReply)(raw)).outcome;
				const failure = actFailure(outcome);
				return Option.isSome(failure) ? yield* Effect.fail(failure.value) : outcome;
			});
		const transcript = (as: string, c: string) =>
			Effect.gen(function* () {
				return (yield* Schema.decodeUnknownEffect(
					Schema.Struct({ value: Schema.Struct({ rows: Schema.Array(AgentRow) }) })
				)(yield* json(yield* call(as, 'GET', `/__bolt/agent?conversation=${c}`)))).value.rows;
			});
		return { t, route, agent, conversations, act, transcript, authorities };
	});
const started = (outcome: Outcome) =>
	outcome.kind === 'committed'
		? Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(outcome.output).id
		: (() => {
				throw new Error('conversation did not start');
			})();

describe('the agent UI actions', () => {
	it.live(
		'starts on the workspace ai.default; a failed turn logs and shows staff the real reason',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, route, agent, act, transcript } = yield* setup();
					const start = yield* act('ann', 'sys_conversation.start', {});
					const c = started(start);
					expect((yield* agent.conversation(c)).model).toBe('fast');
					yield* act('ann', 'sys_message.post', { conversation: c, text: 'hi', now: true });
					yield* route.settled;
					const event = t.fakes.logs.find(
						(r) => r.event === 'agent.failed' && r.conversation === c
					);
					expect(event?.attributes).toMatchObject({
						code: 'unavailable',
						message: "no model is mapped to the class 'fast'"
					});
					expect((yield* transcript('ann', c)).find((r) => r.tag === 'failed')?.detail).toBe(
						"no model is mapped to the class 'fast'"
					);
				})
			)
	);

	it.live(
		"a message posted while previewing a team runs its turn with that team's grants, not the previewer's",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, act, authorities } = yield* setup();
					yield* t.db.write({
						text: `UPDATE sys_user SET admin = true WHERE id = 'ann'`,
						params: []
					});
					const c = started(yield* act('ann', 'sys_conversation.start', {}));
					expect(
						yield* act(
							'ann',
							'sys_message.post',
							{ conversation: c, text: 'what can I do?', now: true },
							't-ops'
						)
					).toMatchObject({ kind: 'committed' });
					const [row] = (yield* t.db.read([
						{
							text: `SELECT "as" FROM sys_message WHERE conversation = $1 AND role = 'user'`,
							params: [c]
						}
					]))[0]!.rows;
					expect(row!['as']).toEqual({ member: 'ann', team: 't-ops' });
					const ann = (yield* authorities.member(t.db, 'ann'))!;
					expect(ann.admin).toBe(true);
					if (ann.actor.kind !== 'member') throw new Error('ann is not a member');
					expect((yield* authorities.team(t.db, ann.actor, 't-ops'))!.admin).toBe(false);
				})
			)
	);

	it.live("setAgent, file and markRead; an administrator reads an instance's raw messages", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, agent, conversations, act, authorities } = yield* setup();
				const c = yield* agent.start({ owner: 'ann' });
				expect(
					yield* Effect.flip(
						act('ann', 'sys_conversation.setAgent', { conversation: c, agent: 'nope' })
					)
				).toMatchObject({ _tag: 'ActRefused' });
				expect(
					yield* Effect.flip(
						act('bob', 'sys_conversation.setAgent', { conversation: c, agent: 'field' })
					)
				).toMatchObject({ _tag: 'ActRefused', code: 'notFound' });
				expect(
					yield* act('ann', 'sys_conversation.setAgent', { conversation: c, agent: 'field' })
				).toMatchObject({ kind: 'committed' });
				expect((yield* agent.conversation(c)).envoy).toBe('field');
				yield* act('ann', 'sys_conversation.setAgent', { conversation: c, agent: 'workspace' });
				expect((yield* agent.conversation(c)).envoy).toBeNull();

				// ingested only (its admission run left queued): the raw traffic is the inbound row alone
				yield* conversations.receive('field', {
					kind: 'messages',
					messages: [
						{
							id: 'w1',
							thread: '6590000001@s.whatsapp.net',
							sentAt: t.clock.now(),
							from: { handle: '6590000001@s.whatsapp.net', name: 'Kim' },
							text: 'hello?',
							attachments: []
						}
					]
				});
				const thread = conversationId('field', '6590000001@s.whatsapp.net');
				const ann = (yield* authorities.member(t.db, 'ann'))!;
				// the instance's Messages tab: its raw traffic as stored, an administrator's
				yield* t.db.write({
					text: `UPDATE sys_user SET admin = true, revision = revision + 1 WHERE id = 'ann'`,
					params: []
				});
				const admin = (yield* authorities.member(t.db, 'ann'))!;
				const raw = yield* instanceMessages(t.db, admin, 'field');
				expect(raw.map((x) => [x.direction, x.thread, x.sender_name, x.text])).toEqual([
					['inbound', '6590000001@s.whatsapp.net', 'Kim', 'hello?']
				]);
				expect(
					yield* Effect.flip(
						instanceMessages(t.db, (yield* authorities.member(t.db, 'cus'))!, 'field')
					)
				).toMatchObject({ code: 'forbidden' });
				expect(yield* Effect.flip(instanceMessages(t.db, admin, 'nope'))).toMatchObject({
					code: 'notFound'
				});
				expect(yield* act('ann', 'sys_message.markRead', { conversation: thread })).toMatchObject({
					kind: 'committed'
				});

				const [msg] = (yield* t.db.read([
					{ text: `SELECT id FROM sys_message WHERE conversation = $1`, params: [thread] }
				]))[0]!.rows;
				const message = String(msg!['id']);
				expect(
					yield* Effect.flip(
						act('ann', 'sys_message.file', {
							message,
							about: { model: 'quotes', id: 'missing' }
						})
					)
				).toMatchObject({ _tag: 'ActRefused', code: 'notFound' });
				expect(
					yield* Effect.flip(act('cus', 'sys_message.file', { message, about: null }))
				).toMatchObject({ _tag: 'ActRefused', code: 'notFound' });
				const q = String(
					(yield* t.db.write({
						text: `INSERT INTO quotes (id, title) VALUES (gen_random_uuid(), 'Q1') RETURNING id::text AS id`,
						params: []
					})).rows[0]!['id']
				);
				yield* t.db.write({
					text: `UPDATE sys_user SET admin = true, revision = revision + 1 WHERE id = 'ann'`,
					params: []
				});
				expect(
					yield* act('ann', 'sys_message.file', { message, about: { model: 'quotes', id: q } })
				).toMatchObject({ kind: 'committed' });
				expect(
					(yield* t.db.read([
						{ text: `SELECT about FROM sys_message WHERE id = $1`, params: [message] }
					]))[0]!.rows[0]!['about']
				).toEqual({ model: 'quotes', id: q });
			})
		)
	);
});

/** A minimal xlsx: deflated entries, a shared string, an inline string, a number, a boolean and a gap. */
function xlsx(files: { readonly [name: string]: string }): Uint8Array {
	const local: Buffer[] = [],
		central: Buffer[] = [];
	let at = 0;
	for (const [name, text] of Object.entries(files)) {
		const n = Buffer.from(name),
			data = deflateRawSync(Buffer.from(text)),
			h = Buffer.alloc(30);
		h.writeUInt32LE(0x04034b50, 0);
		h.writeUInt16LE(8, 8);
		h.writeUInt32LE(data.length, 18);
		h.writeUInt16LE(n.length, 26);
		local.push(h, n, data);
		const c = Buffer.alloc(46);
		c.writeUInt32LE(0x02014b50, 0);
		c.writeUInt16LE(8, 10);
		c.writeUInt32LE(data.length, 20);
		c.writeUInt16LE(n.length, 28);
		c.writeUInt32LE(at, 42);
		central.push(c, n);
		at += 30 + n.length + data.length;
	}
	const dir = Buffer.concat(central),
		end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(dir.length, 12);
	end.writeUInt32LE(at, 16);
	return new Uint8Array(Buffer.concat([...local, dir, end]));
}

describe('read_file on an xlsx', () => {
	it('reads the first worksheet into std/sheet cells', () => {
		const book = xlsx({
			'xl/workbook.xml':
				'<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId7"/><sheet name="Lab data" sheetId="2" r:id="rId8"/></sheets></workbook>',
			'xl/_rels/workbook.xml.rels':
				'<Relationships><Relationship Id="rId7" Type="ws" Target="worksheets/data.xml"/><Relationship Target="worksheets/lab.xml" Id="rId8" Type="ws"/></Relationships>',
			'xl/sharedStrings.xml':
				'<sst><si><t>name</t></si><si><r><t>Ac</t></r><r><t xml:space="preserve">me &amp; Co</t></r></si></sst>',
			'xl/worksheets/data.xml':
				'<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>ok</t></is></c></row>' +
				'<row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3"><v>12.5</v></c><c r="C3" t="b"><v>1</v></c></row></sheetData></worksheet>',
			'xl/worksheets/lab.xml':
				'<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>L*</t></is></c><c r="B1"><v>31.05</v></c></row></sheetData></worksheet>'
		});
		expect(xlsxSheets(book)).toEqual(['Data', 'Lab data']);
		expect(xlsxCells(book)).toEqual([['name', null, 'ok'], [], ['Acme & Co', 12.5, true]]);
		expect(xlsxCells(book, 1)).toEqual([['L*', 31.05]]);
		expect(() => xlsxCells(book, 2)).toThrow('worksheet 2 does not exist');
	});
	it('reads namespace-prefixed workbook parts and absolute worksheet relationships', () => {
		const book = xlsx({
			'xl/workbook.xml':
				'<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sheets><x:sheet name="Work &amp; hours" sheetId="1" rel:id="rId7"/><x:sheet name="Notes" sheetId="2" rel:id="rId8"/></x:sheets></x:workbook>',
			'xl/_rels/workbook.xml.rels':
				'<p:Relationships xmlns:p="http://schemas.openxmlformats.org/package/2006/relationships"><p:Relationship Id="rId7" Type="ws" Target="/xl/worksheets/work.xml"/><p:Relationship Id="rId8" Type="ws" Target="worksheets/notes.xml"/></p:Relationships>',
			'xl/sharedStrings.xml':
				'<x:sst xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:si><x:t>Employee</x:t></x:si><x:si xml:space="preserve"><x:r><x:t>Alex</x:t></x:r><x:r><x:t xml:space="preserve"> &amp; Co</x:t></x:r></x:si></x:sst>',
			'xl/worksheets/work.xml':
				'<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="C1" t="inlineStr"><x:is><x:t xml:space="preserve">Hours</x:t></x:is></x:c></x:row><x:row r="2"/>' +
				'<x:row r="3"><x:c r="A3" t="s"><x:v>1</x:v></x:c><x:c r="B3"/><x:c r="C3"><x:f>8+0.5</x:f><x:v>8.5</x:v></x:c><x:c r="D3" t="b"><x:v>0</x:v></x:c><x:c r="E3" t="str"><x:v>Ready &amp; checked</x:v></x:c><x:c r="F3" t="e"><x:v>#N/A</x:v></x:c></x:row></x:sheetData></x:worksheet>',
			'xl/worksheets/notes.xml':
				'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Public sample</t></is></c></row></sheetData></worksheet>'
		});
		expect(xlsxSheets(book)).toEqual(['Work & hours', 'Notes']);
		expect(xlsxCells(book)).toEqual([
			['Employee', null, 'Hours'],
			[],
			['Alex & Co', null, 8.5, false, 'Ready & checked', '#N/A']
		]);
		expect(xlsxCells(book, 1)).toEqual([['Public sample']]);
	});
	it('retains ISO date cells and clock offsets without producing NaN for invalid dates', () => {
		const book = xlsx({
			'xl/workbook.xml': '<workbook><sheets><sheet name="Dates" sheetId="1"/></sheets></workbook>',
			'xl/worksheets/sheet1.xml':
				'<worksheet><sheetData><row r="1"><c r="A1" t="d"><v>2026-06-03T00:00:00.000Z</v></c><c r="B1" t="d"><v>2026-06-03T08:15:30.125+08:00</v></c><c r="C1" t="d"><v>2026-06-03</v></c><c r="D1" t="d"><v>not-a-date</v></c><c r="E1" t="d"><v>2026-02-30T00:00:00Z</v></c></row></sheetData></worksheet>'
		});
		const cells = xlsxCells(book);
		expect(cells).toEqual([
			[
				'2026-06-03T00:00:00.000Z',
				'2026-06-03T08:15:30.125+08:00',
				'2026-06-03',
				'not-a-date',
				'2026-02-30T00:00:00Z'
			]
		]);
		const clock = cells[0]?.[1];
		if (typeof clock !== 'string') throw new Error('ISO clock cell missing');
		expect(parseInstant(clock, 'Asia/Kuala_Lumpur')).toBe('2026-06-03T00:15:30.125Z');
	});
});
