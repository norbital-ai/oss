import { Effect, Schema } from 'effect';
import { q } from '@norbital-ai/store';
import { catalog } from '../../protocol/catalog.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import type { EngineManifest } from '../manifest.ts';

/** A business restore carries the current identity state, including users without sessions and agent tags. */
export const captureIdentity = (db: TenantDbShape) =>
	db.value(Schema.String, {
		text: `SELECT jsonb_build_object('users', COALESCE((SELECT jsonb_agg(to_jsonb(u)) FROM sys_user u), '[]'::jsonb), 'sessions', COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM sys_session s), '[]'::jsonb))::text`,
		params: []
	});

export const restoreIdentity = (db: TenantDbShape, manifest: EngineManifest, snapshot: string) => {
	const models = catalog(manifest).models;
	const columns = (table: string) =>
		[...(models.get(table)?.fields.values() ?? [])]
			.filter((field) => field.computed !== true && field.derived !== true)
			.map((field) => field.column);
	const users = columns('sys_user'),
		sessions = columns('sys_session');
	const update = users
		.filter((name) => name !== 'id' && name !== 'revision' && name !== 'created_at')
		.map((name) => `${q(name)} = EXCLUDED.${q(name)}`);
	return db
		.transaction({
			statements: [
				{ text: 'DELETE FROM sys_session', params: [] },
				// Clear unique contacts before reassignment; target-only principals remain inactive for historical references.
				{
					text: 'UPDATE sys_user SET email = NULL, phone = NULL, active = false, admin = false, team = NULL, party = NULL, revision = revision + 1',
					params: []
				},
				{
					text: `INSERT INTO sys_user (${users.map(q).join(', ')}) SELECT ${users.map(q).join(', ')} FROM jsonb_populate_recordset(NULL::sys_user, $1::jsonb->'users') ON CONFLICT (id) DO UPDATE SET ${update.join(', ')}, revision = greatest(sys_user.revision, EXCLUDED.revision) + 1`,
					params: [snapshot]
				},
				{
					text: `INSERT INTO sys_session (${sessions.map(q).join(', ')}) SELECT ${sessions.map(q).join(', ')} FROM jsonb_populate_recordset(NULL::sys_session, $1::jsonb->'sessions')`,
					params: [snapshot]
				}
			]
		})
		.pipe(Effect.asVoid);
};
