// A wire-shaped inbound attachment (`{ name, mime, bytes, bin }`, its bytes in the event's `bins`) is stored as a FileRef
// `{ id, name, mime, bytes }` in its message's statement, or without `id` when its bytes never arrived (any other shape is
// dropped); the transcript and the model context read that one shape. A `messages` feed's map reads it as stored
// (conversations.integration.test.ts).
import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Result } from 'effect';
import { messages } from '../src/engine/agent/context.ts';
import { rowsOf, transcriptRow } from '../src/engine/agent/schema.ts';
import { MSG } from '../src/engine/conversations/store.ts';
import { decodeProjectedManifest } from '../src/engine/manifest.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeProjectedManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {},
		relationships: {},
		exposures: {},
		integrations: {},
		policies: {},
		teams: {},
		connections: { desk_wa: { integration: 'whatsapp' } },
		automations: {},
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {},
		agent: { skills: {} }
	})
);

it.live(
	'a wire-shaped inbound attachment is stored as a FileRef, and the transcript and model context see its name, mime and bytes',
	() =>
		Effect.gen(function* () {
			const context = yield* Layer.build(TestWorkspace.layer({ manifest }));
			const t = Context.get(context, TestWorkspace);
			const pdf = new TextEncoder().encode('%PDF-1.7');
			yield* t.receive(
				'desk_wa',
				{
					id: 'W1',
					thread: '6591234567@s.whatsapp.net',
					sentAt: '2026-09-25T10:00:00.000Z',
					from: { handle: '6591234567@s.whatsapp.net', name: 'Ben' },
					text: 'the form',
					attachments: [
						{ name: 'form.pdf', mime: 'application/pdf', bytes: pdf.byteLength, bin: 0 },
						{ name: 'site.mp4', mime: 'video/mp4', bytes: 9 },
						{ fileName: 'old.pdf', mimeType: 'application/pdf', byteLength: 3 }
					]
				}, // not the wire's shape: dropped, never a file
				{ bins: [pdf] }
			);
			const [result] = yield* t.db.read([
				{ text: `SELECT ${MSG} FROM sys_message m WHERE direction = 'inbound'`, params: [] }
			]);
			if (result === undefined) throw new Error('inbound statement returned no result');
			const [row] = yield* rowsOf(result.rows);
			if (row === undefined) throw new Error('inbound message missing');
			const id = row.files?.[0]?.id;
			if (id === undefined) throw new Error('received attachment has no file id');
			expect(row.files).toEqual([
				{ id, name: 'form.pdf', mime: 'application/pdf', bytes: pdf.byteLength },
				{ name: 'site.mp4', mime: 'video/mp4', bytes: 9 }
			]);
			expect(transcriptRow(row, true, true)?.files).toEqual([
				{ id, name: 'form.pdf', mime: 'application/pdf' },
				{ name: 'site.mp4', mime: 'video/mp4' }
			]);
			// every received file is the conversation's input, naming its message, once: a redelivery adds none
			const inputs = Effect.map(
				t.db.read([
					{ text: `SELECT inputs FROM sys_conversation WHERE id = $1`, params: [row.conversation] }
				]),
				([read]) => read?.rows[0]?.['inputs']
			);
			const stored = [
				{ id, name: 'form.pdf', mime: 'application/pdf', bytes: pdf.byteLength, message: row.id },
				{ name: 'site.mp4', mime: 'video/mp4', bytes: 9, message: row.id }
			];
			expect(yield* inputs).toEqual(stored);
			yield* t.receive(
				'desk_wa',
				{
					id: 'W1',
					thread: '6591234567@s.whatsapp.net',
					sentAt: '2026-09-25T10:00:00.000Z',
					from: { handle: '6591234567@s.whatsapp.net', name: 'Ben' },
					text: 'the form',
					attachments: [
						{ name: 'form.pdf', mime: 'application/pdf', bytes: pdf.byteLength, bin: 0 }
					]
				},
				{ bins: [pdf] }
			);
			expect(yield* inputs).toEqual(stored);
			const [message] = messages([row]);
			if (message === undefined) throw new Error('model context message missing');
			const content = String(message.content);
			expect(content).toContain(
				`[attachment: form.pdf · application/pdf · ${pdf.byteLength} bytes] file reference ${JSON.stringify({ id, name: 'form.pdf', mime: 'application/pdf' })}`
			);
			expect(content).toContain(`[attachment: site.mp4 · video/mp4 · 9 bytes] not received`);
		})
);
