// The retention pass's runtime settings, kept in `sys_config` under `retention` so an administrator changes them
// without a source release (Settings, Organization); the last pass's workspace-zone day sits under `retention.pass`.
import { Effect, Option, Schema } from 'effect';
import type { TenantDbShape } from '../db/tenant-db.ts';

export const RETENTION_KEY = 'retention';
export const RETENTION_PASS_KEY = 'retention.pass';
const Days = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const days = (n: number) => Days.pipe(Schema.withDecodingDefaultKey(Effect.succeed(n)));
/**
 * `every_days` between passes, each the first while the database is awake from `hour` (0–23, workspace zone) on;
 * `notifications_days` a read inbox notice stays after it was read; `runs_days` a finished run, a settled outbox
 * entry and a channel notice stay. Unread inbox notices are kept.
 */
export const Retention = Schema.Struct({
	every_days: days(1),
	hour: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(23)).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed(3))
	),
	notifications_days: days(30),
	runs_days: days(90)
});
export type Retention = typeof Retention.Type;
export const RETENTION_DEFAULTS: Retention = Schema.decodeUnknownSync(Retention)({});

/** The settings and the last pass's day (`null` before the first), in one read. */
export const retentionState = (db: TenantDbShape) =>
	db
		.one(Schema.Struct({ settings: Schema.fromJsonString(Retention), pass: Schema.NullOr(Schema.String) }), {
			text: `SELECT coalesce((SELECT value FROM sys_config WHERE key = '${RETENTION_KEY}'), '{}') AS settings,
				(SELECT value FROM sys_config WHERE key = '${RETENTION_PASS_KEY}') AS pass`,
			params: []
		})
		.pipe(Effect.map(Option.getOrElse(() => ({ settings: RETENTION_DEFAULTS, pass: null }))));

export const saveRetention = (db: TenantDbShape, s: Retention) =>
	db.write({
		text: `INSERT INTO sys_config (key, value) VALUES ('${RETENTION_KEY}', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
		params: [JSON.stringify(s)]
	});
