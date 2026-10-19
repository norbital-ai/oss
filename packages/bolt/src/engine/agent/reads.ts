import { Effect, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { Reader } from '../contracts.ts';
import type { ReadIR } from '../../protocol/ir-types.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import { BoltError } from '../../protocol/errors.ts';
import { publicEnvoys, type EngineManifest } from '../manifest.ts';
import { inboxRequests, openRequests } from '../approvals/inbox.ts';
import { INBOX_LIMIT, noticeRow } from '../live/hub.ts';
import { CONVERSATIONS, conversationRow, isStaff, rowsOf, transcriptRow } from './schema.ts';
import { MSG } from '../conversations/store.ts';

/** Direct typed DB reads keep the read service independent of the agent execution service. */
export const agentRead = Effect.fn('Agents.read')(function* (
	db: TenantDbShape,
	manifest: EngineManifest,
	read: ReadIR,
	reader: Reader
) {
	switch (read.kind) {
		case 'transcript': {
			const [result, conv] = yield* db.read([
				{
					text: `SELECT ${MSG} FROM sys_message m WHERE conversation = $1${read.from === undefined ? '' : ' AND seq >= $2'} ORDER BY seq`,
					params: read.from === undefined ? [read.conversation] : [read.conversation, read.from]
				},
				{ text: 'SELECT status FROM sys_conversation WHERE id = $1', params: [read.conversation] }
			]);
			const rows = yield* rowsOf(result?.rows ?? []);
			const staff = reader.as === 'workspace' || isStaff(reader.authority);
			const status = conv?.rows[0]?.['status'];
			return {
				// the conversation's own status: a stop between steps leaves no row that says so
				...(status === 'idle' || status === 'running' || status === 'stopped' ? { status } : {}),
				rows: rows.flatMap((row) => transcriptRow(row, staff, read.thread) ?? []),
				...(read.from === undefined ? {} : { from: read.from }),
				...(read.thread ? { thread: true } : {})
			};
		}
		case 'conversations': {
			const [result] = yield* db.read([
				{
					text: `SELECT to_jsonb(c) AS r FROM sys_conversation c WHERE c.parent IS NULL AND
    (c.owner = $1 OR (c.integration IS NOT NULL AND (c.envoy IN (SELECT jsonb_array_elements_text($2::jsonb)) OR
    EXISTS (SELECT 1 FROM sys_message p WHERE p.conversation = c.id AND $1 IN (p.author, p."as"->>'member', p."as"->'envoy'->>'member')))))
    ORDER BY updated_at DESC, id COLLATE "C" DESC LIMIT ${CONVERSATIONS}`,
					params: [read.member, JSON.stringify(publicEnvoys(manifest))]
				}
			]);
			const rows = yield* Schema.decodeUnknownEffect(
				Schema.Array(Schema.Record(Schema.String, Schema.Json))
			)((result?.rows ?? []).map((row) => row['r'])).pipe(
				Effect.mapError((error) =>
					BoltError.make(
						'corrupt',
						'decode',
						'the conversation list does not match its schema',
						error
					)
				)
			);
			return { rows: rows.map(conversationRow) };
		}
		case 'inbox': {
			if (
				reader.as !== 'caller' ||
				reader.authority.actor.kind !== 'member' ||
				reader.authority.actor.external ||
				reader.authority.actor.id !== read.member
			)
				return yield* Effect.fail(
					BoltError.make('forbidden', 'admission', 'No inbox for this member.')
				);
			const [rows, count, open] = yield* db.read([
				{
					text: `SELECT to_jsonb(n) AS r FROM (SELECT id, title, body, link, at, read_at FROM sys_notification WHERE member = $1
    ORDER BY at DESC, id COLLATE "C" DESC LIMIT ${INBOX_LIMIT}) n ORDER BY n.at DESC, n.id COLLATE "C" DESC`,
					params: [read.member]
				},
				{
					text: 'SELECT count(*)::int AS unread FROM sys_notification WHERE member = $1 AND read_at IS NULL',
					params: [read.member]
				},
				...(read.requests ? [openRequests] : [])
			]);
			const decoded = yield* Schema.decodeUnknownEffect(
				Schema.Array(Schema.Record(Schema.String, Schema.Json))
			)((rows?.rows ?? []).map((row) => row['r'])).pipe(
				Effect.mapError((error) =>
					BoltError.make('corrupt', 'decode', 'the inbox does not match its schema', error)
				)
			);
			return {
				rows: decoded.map(noticeRow),
				unread: count?.rows[0]?.['unread'] ?? 0,
				...(read.requests ? { requests: inboxRequests(open?.rows ?? [], reader.authority) } : {})
			};
		}
		default:
			return yield* Effect.fail(
				BoltError.make(
					'unsupported',
					'decode',
					`the agent read delegate does not handle ${read.kind}`
				)
			);
	}
});
