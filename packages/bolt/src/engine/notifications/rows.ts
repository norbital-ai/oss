import { Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import { storedInstant } from '@norbital-ai/host-api';

export const INBOX_LIMIT = 200;
export const StoredNotice = Schema.Struct({
	id: Schema.String, title: Schema.String, body: Schema.NullOr(Schema.String), link: Schema.NullOr(Schema.Json),
	at: Schema.String, read_at: Schema.NullOr(Schema.String)
});
/** The stored notice's public projection is shared by reads, captures and arrival callbacks. */
export function noticeRow(row: typeof StoredNotice.Type): { [key: string]: Json } {
	const id = row['id'], title = row['title'], at = storedInstant(row['at']);
	return { id, title, body: row['body'] ?? null, link: row['link'] ?? null, at,
		read: row['read_at'] !== null && row['read_at'] !== undefined };
}
