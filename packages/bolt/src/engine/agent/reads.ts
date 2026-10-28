import { Effect, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { Reader } from '../contracts.ts';
import type { ReadIR } from '../../protocol/reads.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import { BoltError } from '../../protocol/errors.ts';
import { publicEnvoys, type EngineManifest } from '../manifest.ts';
import { inboxRequests, openRequests } from '../approvals/inbox.ts';
import { INBOX_LIMIT, noticeRow } from '../live/hub.ts';
import {
	CONVERSATIONS,
	conversationRow,
	isStaff,
	rowsOf,
	sharedConversations,
	transcriptRow
} from './schema.ts';
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
				{
					text: 'SELECT status, inputs, outputs FROM sys_conversation WHERE id = $1',
					params: [read.conversation]
				}
			]);
			const rows = yield* rowsOf(result?.rows ?? []);
			const staff = reader.as === 'workspace' || isStaff(reader.authority);
			const status = conv?.rows[0]?.['status'];
			// the conversation's files, for the session rail: what came in and what its work made
			const files = (key: 'inputs' | 'outputs') => {
				const refs = conv?.rows[0]?.[key];
				return Array.isArray(refs) && refs.length > 0 ? { [key]: refs } : {};
			};
			return {
				...files('inputs'),
				...files('outputs'),
				// the conversation's own status: a stop between steps leaves no row that says so
				...(status === 'idle' || status === 'running' || status === 'stopped' ? { status } : {}),
				rows: rows.flatMap((row) => transcriptRow(row, staff, read.thread) ?? []),
				...(read.from === undefined ? {} : { from: read.from }),
				...(read.thread ? { thread: true } : {}),
				...(read.automation ? { automation: true } : {})
			};
		}
		case 'conversations': {
			const [result] = yield* db.read([
				{
					text: `SELECT to_jsonb(c) || jsonb_build_object('peer', CASE WHEN c.kind = 'dm' THEN (SELECT u.name FROM sys_message p
    JOIN sys_user u ON u.id = COALESCE(p."as"->'envoy'->>'member', p."as"->>'member', p.author) WHERE p.conversation = c.id
    ORDER BY p.seq LIMIT 1) END) AS r FROM sys_conversation c WHERE c.parent IS NULL AND
    (c.owner = $1 OR ${sharedConversations({ member: '$1', admin: '$3', staff: '$4', envoys: '$2' })})
    ORDER BY updated_at DESC, id COLLATE "C" DESC LIMIT ${CONVERSATIONS}`,
					// an automation's inference transcripts are an administrator's to read
					params: [
						read.member,
						JSON.stringify(publicEnvoys(manifest)),
						reader.as === 'workspace' || reader.authority.admin,
						reader.as === 'workspace' || isStaff(reader.authority)
					]
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
