// Upload identity follows content and ownership; request retries use the native idempotency gate.
import { randomUUID } from 'node:crypto';
import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { attachmentsFor } from '../src/engine/agent/attachments.ts';
import { ATTACHMENT_BYTES, HEADERS, PATHS } from '../src/protocol/wire.ts';
import { json, route_fixture } from './support/route-fixture.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' }, needs: [], models: {}, relationships: {}, exposures: {}, policies: {},
	agent: { skills: {} }, integrations: {}, teams: {}, automations: {}, mcp: {}, apps: {}, custom_fields: {}
} satisfies EngineManifest;

it.live('uploads reuse identical files concurrently, keep changed contents, and isolate uploaders', () => Effect.scoped(Effect.gen(function* () {
	const context = yield* Layer.build(TestWorkspace.layer({ manifest }));
	const t = Context.get(context, TestWorkspace), owner = t.member([], { admin: true }), caller = yield* t.as(owner);
	const file = { name: 'observation.txt', mime: 'text/plain', bytes: new TextEncoder().encode('source values') };
	const put = (id: string, bytes = file.bytes) => caller.upload('sys_conversation.inputs', { ...file, bytes, id });
	const request = randomUUID();
	const first = yield* put(request);
	if (first.kind !== 'committed') throw new Error('Upload was not committed');
	const again = yield* Effect.all([put(request), ...Array.from({ length: 4 }, () => put(randomUUID()))], { concurrency: 'unbounded' });
	for (const result of again) expect(result).toEqual(first);
	expect(yield* t.db.rows(Schema.Struct({ count: Schema.Int }), { text: 'SELECT count(*)::int AS count FROM sys_file', params: [] })).toEqual([{ count: 1 }]);
	expect(yield* Effect.flip(put(request, new TextEncoder().encode('changed value')))).toMatchObject({ code: 'key_reuse' });
	const changed = yield* put(randomUUID(), new TextEncoder().encode('changed value'));
	if (changed.kind !== 'committed') throw new Error('Changed upload was not committed');
	expect(changed.output.id).not.toBe(first.output.id);
	const otherMember = t.member([]), other = yield* t.as(otherMember);
	const theirs = yield* other.upload('sys_conversation.inputs', file);
	if (theirs.kind !== 'committed') throw new Error('Other upload was not committed');
	expect(theirs.output.id).not.toBe(first.output.id);
	expect(yield* attachmentsFor(t.db, owner.id, [first.output, first.output])).toHaveLength(1);
	expect(yield* Effect.flip(attachmentsFor(t.db, otherMember.id, [first.output]))).toMatchObject({ code: 'invalid_input' });
})));

it.live('a panel attachment the host stored over the limit is refused, never recorded', () => Effect.scoped(Effect.gen(function* () {
	const context = yield* Layer.build(TestWorkspace.layer({ manifest }));
	const t = Context.get(context, TestWorkspace), caller = yield* t.as(t.member([])), route = yield* route_fixture(context);
	const put = (bytes: number) => route.handle(caller.authority, new Request(`http://cell${PATHS.files}sys_conversation.inputs`, {
		method: 'PUT',
		headers: {
			'content-type': 'audio/mp4',
			'content-disposition': "attachment; filename*=UTF-8''call.m4a",
			[HEADERS.key]: randomUUID(),
			[HEADERS.stored]: JSON.stringify({ key: `stored/${bytes}`, bytes, sha256: String(bytes).padStart(64, '0') })
		}
	})).pipe(Effect.flatMap(json));
	expect(yield* put(ATTACHMENT_BYTES)).toMatchObject({ bytes: ATTACHMENT_BYTES });
	expect(yield* put(ATTACHMENT_BYTES + 1)).toMatchObject({ error: { code: 'invalid_input' } });
	expect(yield* t.db.rows(Schema.Struct({ size: Schema.Int }), { text: 'SELECT size FROM sys_file', params: [] })).toEqual([{ size: ATTACHMENT_BYTES }]);
})));
