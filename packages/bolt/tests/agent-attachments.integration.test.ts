// In-app Norbius attachments (§5.9, rule 58): a panel upload to `sys_message.files` rides `sys_message.post` as a
// stored FileRef on the row; the agent reads it with `read_attachment`; triage's state carries it (P37); only the
// member's own uploads attach, 8 files / 20 MiB, the envoy's media types.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { AiPort, AiRequest, Authority, EngineManifest, Outcome } from '../src/engine/contracts.ts';
import type { System1Request } from '../src/engine/decisions/index.ts';
import { upload } from '../src/engine/callables/upload.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { boltHandler } from '../src/protocol/http.ts';
import { fileAttachments } from '../src/shell/data.ts';
import { testWorkspace, type TestWorkspace } from '../src/test/index.ts';

const manifest = (triage: boolean) => ({
	workspace: { tz: 'UTC', locale: 'en', agent: { triage } }, models: {}, relationships: {}, collections: {}, policies: {},
	agent: { internal: 'Staff brief.', skills: {} },
	integrations: {}, pipelines: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {},
}) as unknown as EngineManifest;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

async function setup(triage: boolean) {
	const requests: AiRequest[] = [], states: System1Request['state'][] = [];
	const ai: AiPort = {
		sys_1: { async ask(r) { states.push(r.state);
			return { answers: { action: { type: 'choice', choice: 'respond', confidence: 1, probabilities: { respond: 1 } },
				wait: { type: 'score', score: 0, level: 0, confidence: 1, probabilities: {}, legend: {} } }, costUsd: 0, provider: 'scripted' }; } },
		sys_2: { models: ['default'], async infer(r) {
			requests.push(r);
			const seq = /\[attachment seq (\d+) file 0: /.exec(JSON.stringify(r.messages))?.[1];
			return requests.length === 1 && seq !== undefined
				? { content: '', toolCalls: [{ id: 'r1', name: 'read_attachment', input: { seq: Number(seq), as: 'image' } }], finish: 'tool', usage: { input: 1, output: 1 } }
				: { content: 'A pump.', toolCalls: [], finish: 'stop', usage: { input: 1, output: 1 } };
		} } };
	let t: TestWorkspace | undefined;
	t = await testWorkspace({ manifest: manifest(triage), ai, agent: { attachments: { read: (f, as, signal) => fileAttachments(t!.db, t!.fakes.files).read(f, as, signal) } } });
	for (const id of ['ann', 'bob']) await t.db.write({ text: `INSERT INTO sys_user (id, email, name) VALUES ($1, $2, $1)`, params: [id, `${id}@x.test`] });
	const authorities = new Authorities(manifest(triage), 'test');
	const who = async (id: string) => (await authorities.member(t!.db, id))!;
	const bolt = boltHandler({ engine: t.engine, uuid: randomUUID, bindings: () => ({ now: t!.clock.now(), today: t!.clock.now().slice(0, 10), tz: 'UTC', params: {} }),
		session: async (r) => who(r.headers.get('x-user') ?? '') });
	const act = async (as: string, callable: string, input: Json) => ((await (await bolt(new Request('http://cell/__bolt/act', { method: 'POST',
		headers: { 'x-user': as, 'content-type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ callable, input, issuedAt: t!.clock.now() }) })))!
		.json()) as { outcome: Outcome }).outcome;
	const put = async (as: Authority, name: string, mime: string, bytes: Uint8Array) =>
		upload({ manifest: t!.manifest, db: t!.db, files: t!.fakes.files }, { id: randomUUID(), collection: 'sys_message', field: 'files', name, mime, bytes, authority: as, now: t!.clock.now() });
	const conversation = async () => String(((await act('ann', 'sys_conversation.start', {})) as unknown as { output: { id: string } }).output.id);
	return { t, bolt, act, put, who, requests, states, conversation };
}

describe('in-app attachments', () => {
	it('an image posted from the panel is stored on the row and read by read_attachment', async () => {
		const { t, bolt, act, put, who, requests, conversation } = await setup(false);
		const ann = await who('ann'), c = await conversation();
		const ref = await put(ann, 'pump.png', 'image/png', PNG);
		expect(ref).toMatchObject({ kind: 'committed', output: { name: 'pump.png', mime: 'image/png', bytes: PNG.length } });
		const file = (ref as { output: Json }).output;
		expect(await act('ann', 'sys_message.post', { conversation: c, text: 'what is this?', attachments: [file] })).toMatchObject({ kind: 'committed' });
		await bolt.settled();
		const [row] = (await t.db.read([{ text: `SELECT files FROM sys_message WHERE conversation = $1 AND role = 'user'`, params: [c] }]))[0]!.rows;
		expect(row!['files']).toEqual([{ id: (file as { id: string }).id, name: 'pump.png', mime: 'image/png', bytes: PNG.length }]);
		expect([...requests[1]!.files![0]!.bytes]).toEqual([...PNG]);
		expect(requests[1]!.files![0]!.mime).toBe('image/png');
	});

	it('only the member\'s own uploads attach, at most 8, of the envoy media types', async () => {
		const { act, put, who, conversation } = await setup(false);
		const ann = await who('ann'), bob = await who('bob'), c = await conversation();
		expect(await put(ann, 'a.zip', 'application/zip', PNG)).toMatchObject({ kind: 'refused', code: 'invalidInput' });
		const bobs = (await put(bob, 'b.png', 'image/png', PNG) as { output: Json }).output;
		expect(await act('ann', 'sys_message.post', { conversation: c, text: 'x', attachments: [bobs] })).toMatchObject({ kind: 'refused', code: 'invalidInput' });
		const own = (await put(ann, 'a.png', 'image/png', PNG) as { output: Json }).output;
		expect(await act('ann', 'sys_message.post', { conversation: c, text: 'x', attachments: Array(9).fill(own) })).toMatchObject({ kind: 'refused', message: 'Attach at most 8 files.' });
	});

	it('a triaged post puts its attachment in the sys_1 state as metadata only (P37 (3))', async () => {
		const { t, act, put, who, states, conversation } = await setup(true);
		const c = await conversation(), file = (await put(await who('ann'), 'pump.png', 'image/png', PNG) as { output: Json }).output;
		await act('ann', 'sys_message.post', { conversation: c, text: 'see photo', attachments: [file] });
		t.clock.advance('2s'); // the trailing debounce (P40)
		await t.runDue();
		const got = (states[0] as unknown as { pending: { attachments?: Json[] }[] }).pending[0]!.attachments![0];
		expect(got).toEqual({ name: 'pump.png', mime: 'image/png', size: PNG.length });
	});
});
