// The agent UI's engine half (§5.9): an in-app conversation starts on the workspace's `ai.default`; a failed turn's log
// line and staff row name the real reason; `setAgent`, `file` and `markRead` over `/__bolt/act`; staff
// list the envoy conversations with an unread mark; `read_attachment` reads an xlsx into std/sheet's cells.
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { AiPort, EngineManifest, Outcome } from '../src/engine/contracts.ts';
import { conversationId } from '../src/engine/channels/store.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { boltHandler } from '../src/protocol/http.ts';
import type { AgentRow } from '../src/protocol/wire.ts';
import { channelMessages } from '../src/shell/data.ts';
import { xlsxCells, xlsxSheets } from '../src/engine/agent/xlsx.ts';
import { respondSystem1, testWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false }, ai: { models: ['fast'], default: 'fast' } },
	models: { quotes: { description: 'A quote', label: 'title', fields: { title: { kind: 'text' } } } },
	relationships: {},
	collections: { quotes: { read: { fields: 'all' }, create: { input: { columns: ['title'] } } } },
	policies: { rep: { description: 'Rep', grants: { quotes: { read: true } } } },
	envoys: { field: { channel: 'field', audience: 'public', name: 'Norbius', policies: ['rep'], triage: false, groupMessages: 'disabled', delegation: 'disabled', task: 'Help.' } },
	channels: { field: { transport: 'whatsapp' } },
	agent: { internal: 'Staff brief.', external: 'Customer brief.', skills: {} },
	integrations: {}, pipelines: {}, teams: {}, automations: {}, connections: {}, mcp: {}, apps: {}, customFields: {},
} as unknown as EngineManifest;

async function setup() {
	// the host maps only `default`: the workspace's `fast` is unmapped, so a turn fails with that reason
	const ai: AiPort = { sys_1: respondSystem1, sys_2: { models: ['default'], async infer() { throw new Error('not called'); } } };
	const t = await testWorkspace({ manifest, ai });
	for (const [id, kind] of [['ann', 'staff'], ['bob', 'staff'], ['cus', 'external']] as const)
		await t.db.write({ text: `INSERT INTO sys_user (id, email, name, kind) VALUES ($1, $2, $1, $3)`, params: [id, `${id}@x.test`, kind] });
	const authorities = new Authorities(manifest, 'test');
	const bolt = boltHandler({ engine: t.engine, uuid: () => crypto.randomUUID(), bindings: () => ({ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }),
		session: async (r) => {
			const own = await authorities.member(t.db, r.headers.get('x-user') ?? '', r.headers.get('x-preview') === '1');
			const team = r.headers.get('x-team'); // the shell's "preview as a team" (rule 39)
			return team === null || own === null || own.actor.kind !== 'member' ? own : authorities.team(t.db, own.actor, team);
		} });
	const call = (as: string, method: string, path: string, body?: unknown, preview: boolean | string = false) => bolt(new Request(`http://cell${path}`, { method,
		headers: { 'x-user': as, ...(preview === true ? { 'x-preview': '1' } : typeof preview === 'string' ? { 'x-team': preview } : {}), 'content-type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
		...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
	const act = async (as: string, callable: string, input: Json, preview: boolean | string = false) =>
		(await (await call(as, 'POST', '/__bolt/act', { callable, input, issuedAt: t.clock.now() }, preview))!.json() as { outcome: Outcome }).outcome;
	const transcript = async (as: string, c: string) => ((await (await call(as, 'GET', `/__bolt/agent?conversation=${c}`))!.json()) as { value: { rows: AgentRow[] } }).value.rows;
	return { t, bolt, act, transcript, authorities };
}

describe('the agent UI actions', () => {
	it('starts on the workspace ai.default; a failed turn logs and shows staff the real reason', async () => {
		const { t, bolt, act, transcript } = await setup();
		const start = await act('ann', 'sys_conversation.start', {});
		const c = String((start as unknown as { output: { id: string } }).output.id);
		expect((await t.engine.agents.conversation(c)).model).toBe('fast');
		await act('ann', 'sys_message.post', { conversation: c, text: 'hi', now: true });
		await bolt.settled();
		const [event] = (await t.db.read([{ text: `SELECT attributes FROM sys_event WHERE event = 'agent.failed' AND conversation = $1`, params: [c] }]))[0]!.rows;
		expect(event!['attributes']).toMatchObject({ code: 'unavailable', message: "no model is mapped to the class 'fast'" });
		expect((await transcript('ann', c)).find((r) => r.tag === 'failed')?.detail).toBe("no model is mapped to the class 'fast'");
	});

	it('a message posted while previewing a team runs its turn with that team\'s grants, not the previewer\'s', async () => {
		const { t, act, authorities } = await setup();
		await t.db.write({ text: `INSERT INTO sys_team (id, name) VALUES ('t-ops', 'Ops')`, params: [] });
		await t.db.write({ text: `UPDATE sys_user SET admin = true WHERE id = 'ann'`, params: [] });
		const c = String((await act('ann', 'sys_conversation.start', {}) as unknown as { output: { id: string } }).output.id);
		expect(await act('ann', 'sys_message.post', { conversation: c, text: 'what can I do?', now: true }, 't-ops')).toMatchObject({ kind: 'committed' });
		const [row] = (await t.db.read([{ text: `SELECT "as" FROM sys_message WHERE conversation = $1 AND role = 'user'`, params: [c] }]))[0]!.rows;
		expect(row!['as']).toEqual({ member: 'ann', team: 't-ops' });
		const ann = (await authorities.member(t.db, 'ann'))!;
		expect(ann.admin).toBe(true);
		expect((await authorities.team(t.db, ann.actor as Extract<typeof ann.actor, { kind: 'member' }>, 't-ops'))!.admin).toBe(false);
	});

	it('setAgent, file and markRead; an administrator reads a channel\'s raw messages', async () => {
		const { t, act, authorities } = await setup();
		const c = await t.engine.agents.start({ owner: 'ann' });
		expect(await act('ann', 'sys_conversation.setAgent', { conversation: c, agent: 'nope' })).toMatchObject({ kind: 'refused' });
		expect(await act('bob', 'sys_conversation.setAgent', { conversation: c, agent: 'field' })).toMatchObject({ kind: 'refused', code: 'notFound' });
		expect(await act('ann', 'sys_conversation.setAgent', { conversation: c, agent: 'field' })).toMatchObject({ kind: 'committed' });
		expect((await t.engine.agents.conversation(c)).envoy).toBe('field');
		await act('ann', 'sys_conversation.setAgent', { conversation: c, agent: 'workspace' });
		expect((await t.engine.agents.conversation(c)).envoy).toBeNull();

		await t.engine.channels.receive({ kind: 'inbound', channel: 'field', message: { id: 'w1', thread: '6590000001@s.whatsapp.net', sentAt: t.clock.now(),
			from: { handle: '6590000001@s.whatsapp.net', name: 'Kim' }, text: 'hello?', attachments: [] } });
		const thread = conversationId('field', '6590000001@s.whatsapp.net');
		const ann = (await authorities.member(t.db, 'ann'))!;
		// the channel's Messages tab: its raw traffic as stored, an administrator's
		await t.db.write({ text: `UPDATE sys_user SET admin = true, revision = revision + 1 WHERE id = 'ann'`, params: [] });
		const admin = (await authorities.member(t.db, 'ann'))!;
		const raw = await channelMessages(t.db, admin, t.manifest, 'field');
		expect(raw.ok && raw.value.map((x) => [x.direction, x.thread, x.sender_name, x.text])).toEqual([['inbound', '6590000001@s.whatsapp.net', 'Kim', 'hello?']]);
		expect(await channelMessages(t.db, (await authorities.member(t.db, 'cus'))!, t.manifest, 'field')).toMatchObject({ ok: false });
		expect(await channelMessages(t.db, admin, t.manifest, 'nope')).toMatchObject({ ok: false, code: 'notFound' });
		expect(await act('ann', 'sys_message.markRead', { conversation: thread })).toMatchObject({ kind: 'committed' });

		const [msg] = (await t.db.read([{ text: `SELECT id FROM sys_message WHERE conversation = $1`, params: [thread] }]))[0]!.rows;
		const message = String(msg!['id']);
		expect(await act('ann', 'sys_message.file', { message, about: { collection: 'quotes', id: 'missing' } })).toMatchObject({ kind: 'refused', code: 'notFound' });
		expect(await act('cus', 'sys_message.file', { message, about: null })).toMatchObject({ kind: 'refused', code: 'notFound' });
		const q = String((await t.db.write({ text: `INSERT INTO quotes (id, title) VALUES (gen_random_uuid(), 'Q1') RETURNING id::text AS id`, params: [] })).rows[0]!['id']);
		await t.db.write({ text: `UPDATE sys_user SET admin = true, revision = revision + 1 WHERE id = 'ann'`, params: [] });
		expect(await act('ann', 'sys_message.file', { message, about: { collection: 'quotes', id: q } })).toMatchObject({ kind: 'committed' });
		expect((await t.db.read([{ text: `SELECT about FROM sys_message WHERE id = $1`, params: [message] }]))[0]!.rows[0]!['about']).toEqual({ collection: 'quotes', id: q });
	});
});

/** A minimal xlsx: deflated entries, a shared string, an inline string, a number, a boolean and a gap. */
function xlsx(files: { readonly [name: string]: string }): Uint8Array {
	const local: Buffer[] = [], central: Buffer[] = [];
	let at = 0;
	for (const [name, text] of Object.entries(files)) {
		const n = Buffer.from(name), data = deflateRawSync(Buffer.from(text)), h = Buffer.alloc(30);
		h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(8, 8); h.writeUInt32LE(data.length, 18); h.writeUInt16LE(n.length, 26);
		local.push(h, n, data);
		const c = Buffer.alloc(46);
		c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10); c.writeUInt32LE(data.length, 20); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(at, 42);
		central.push(c, n);
		at += 30 + n.length + data.length;
	}
	const dir = Buffer.concat(central), end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(at, 16);
	return new Uint8Array(Buffer.concat([...local, dir, end]));
}

describe('read_attachment on an xlsx', () => {
	it('reads the first worksheet into std/sheet cells', () => {
		const book = xlsx({
			'xl/workbook.xml': '<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId7"/><sheet name="Lab data" sheetId="2" r:id="rId8"/></sheets></workbook>',
			'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId7" Type="ws" Target="worksheets/data.xml"/><Relationship Target="worksheets/lab.xml" Id="rId8" Type="ws"/></Relationships>',
			'xl/sharedStrings.xml': '<sst><si><t>name</t></si><si><r><t>Ac</t></r><r><t xml:space="preserve">me &amp; Co</t></r></si></sst>',
			'xl/worksheets/data.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>ok</t></is></c></row>'
				+ '<row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3"><v>12.5</v></c><c r="C3" t="b"><v>1</v></c></row></sheetData></worksheet>',
			'xl/worksheets/lab.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>L*</t></is></c><c r="B1"><v>31.05</v></c></row></sheetData></worksheet>',
		});
		expect(xlsxSheets(book)).toEqual(['Data', 'Lab data']);
		expect(xlsxCells(book)).toEqual([['name', null, 'ok'], [], ['Acme & Co', 12.5, true]]);
		expect(xlsxCells(book, 1)).toEqual([['L*', 31.05]]);
		expect(() => xlsxCells(book, 2)).toThrow('worksheet 2 does not exist');
	});
});
