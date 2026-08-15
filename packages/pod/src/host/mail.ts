/**
 * Host-side mail: outbox, notification drain, identity reads, manifest, pull cursors.
 *
 * These are SQL against a tenant database the host already holds. They must not admit an isolate.
 */
import { z } from 'zod';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import type { HostDbBinding } from '@norbital-ai/platform-utils/runtime/binding';
import { hashToken } from './session.js';
import {
	inviteeEmailForTokenOnDb,
	seatCensusOnDb,
	workspaceMembershipOnDb
} from './directory.js';

export const OUTBOX_CLAIM_LEASE_MS = 5 * 60 * 1000;
const NOTIFICATION_CLAIM_LEASE_MS = 5 * 60 * 1000;

const outboxCommandSchema = z.union([
	z.object({
		kind: z.literal('outbox'),
		action: z.literal('claim'),
		limit: z.number().int().optional()
	}),
	z.object({
		kind: z.literal('outbox'),
		action: z.literal('delivered'),
		ids: z.array(z.string().uuid())
	}),
	z.object({
		kind: z.literal('outbox'),
		action: z.literal('failed'),
		ids: z.array(z.string().uuid()),
		error: z.string(),
		retryAt: z.string().datetime()
	})
]);

const notificationCommandSchema = z.union([
	z.object({
		kind: z.literal('notification'),
		action: z.literal('claim'),
		limit: z.number().int().optional()
	}),
	z.object({
		kind: z.literal('notification'),
		action: z.literal('delivered'),
		ids: z.array(z.string().uuid())
	}),
	z.object({
		kind: z.literal('notification'),
		action: z.literal('failed'),
		ids: z.array(z.string().uuid()),
		error: z.string(),
		retryAt: z.string().datetime()
	})
]);

const identityReadCommandSchema = z.union([
	z.object({ kind: z.literal('identity'), action: z.literal('seats') }),
	z.object({ kind: z.literal('identity'), action: z.literal('membership') }),
	z.object({
		kind: z.literal('identity'),
		action: z.literal('invite-email'),
		token: z.string().min(1).max(512)
	})
]);

const integrationCursorCommandSchema = z.union([
	z.object({
		kind: z.literal('integration-cursor'),
		action: z.literal('read'),
		integrationName: z.string().min(1),
		bindingName: z.string().min(1)
	}),
	z.object({
		kind: z.literal('integration-cursor'),
		action: z.literal('write'),
		integrationName: z.string().min(1),
		bindingName: z.string().min(1),
		cursor: z.string().nullable().optional(),
		error: z.string().nullable().optional()
	})
]);

const hostMailCommandSchema = z.union([
	outboxCommandSchema,
	notificationCommandSchema,
	z.object({ kind: z.literal('getManifest') }),
	identityReadCommandSchema,
	integrationCursorCommandSchema
]);

export type HostMailCommand = z.infer<typeof hostMailCommandSchema>;
export type HostOutboxCommand = z.infer<typeof outboxCommandSchema>;
export type HostNotificationCommand = z.infer<typeof notificationCommandSchema>;
export type HostIntegrationCursorCommand = z.infer<typeof integrationCursorCommandSchema>;

export type HostMailInput = {
	readonly db: HostDbBinding;
	readonly manifest: NorbitalManifest;
	readonly command: unknown;
};

/** The manifest key a pull binding stores its resume point under. */
export function integrationBindingKey(integrationName: string, bindingName: string): string {
	return `${integrationName}:${bindingName}`;
}

export function isHostMailCommand(command: unknown): command is HostMailCommand {
	return hostMailCommandSchema.safeParse(command).success;
}

/**
 * Run a host-mail command against the tenant database. Does not admit a guest.
 */
export async function runHostMail(input: HostMailInput): Promise<unknown> {
	const command = hostMailCommandSchema.parse(input.command);
	switch (command.kind) {
		case 'outbox':
			return runHostOutbox(input.db, command);
		case 'notification':
			return runHostNotification(input.db, command);
		case 'getManifest':
			return input.manifest;
		case 'identity':
			return runHostIdentityRead(input.db, command);
		case 'integration-cursor':
			return runHostIntegrationCursor(input.db, command);
		default: {
			const _exhaustive: never = command;
			throw new Error(`Unknown host-mail command: ${JSON.stringify(_exhaustive)}`);
		}
	}
}

/**
 * Intercept host-mail on a dispatch wrapper. Guest kinds fall through.
 */
export async function dispatchHostOrGuest(input: {
	readonly command: unknown;
	readonly db: HostDbBinding;
	readonly manifest: NorbitalManifest;
	readonly guest: (command: unknown) => Promise<unknown>;
}): Promise<unknown> {
	if (isHostMailCommand(input.command)) {
		return runHostMail({ db: input.db, manifest: input.manifest, command: input.command });
	}
	return input.guest(input.command);
}

export async function runHostOutbox(
	db: HostDbBinding,
	command: HostOutboxCommand
): Promise<unknown> {
	switch (command.action) {
		case 'claim':
			return claimOutboxRows(db, command.limit);
		case 'delivered':
			return settleOutboxDelivered(db, command.ids);
		case 'failed':
			return settleOutboxFailed(db, command.ids, command.error, command.retryAt);
		default: {
			const _exhaustive: never = command;
			throw new Error(`Unknown outbox action: ${JSON.stringify(_exhaustive)}`);
		}
	}
}

export async function runHostNotification(
	db: HostDbBinding,
	command: HostNotificationCommand
): Promise<unknown> {
	switch (command.action) {
		case 'claim':
			return claimNotificationRows(db, command.limit);
		case 'delivered':
			return settleNotificationDelivered(db, command.ids);
		case 'failed':
			return settleNotificationFailed(db, command.ids, command.error, command.retryAt);
		default: {
			const _exhaustive: never = command;
			throw new Error(`Unknown notification action: ${JSON.stringify(_exhaustive)}`);
		}
	}
}

export async function runHostIntegrationCursor(
	db: HostDbBinding,
	command: HostIntegrationCursorCommand
): Promise<{ readonly cursor: string | null }> {
	const bindingKey = integrationBindingKey(command.integrationName, command.bindingName);
	switch (command.action) {
		case 'read': {
			const result = await db.query(
				`SELECT cursor FROM integration_cursor WHERE binding_key = $1 LIMIT 1`,
				[bindingKey]
			);
			const row = result.rows[0] as { cursor: string | null } | undefined;
			return { cursor: row?.cursor ?? null };
		}
		case 'write': {
			const cursor = command.cursor ?? null;
			await db.query(
				`INSERT INTO integration_cursor
				    (integration_name, binding_name, binding_key, cursor, last_pulled_at, last_error)
				 VALUES ($1, $2, $3, $4, now(), $5)
				 ON CONFLICT (binding_key) DO UPDATE SET
				    integration_name = EXCLUDED.integration_name,
				    binding_name = EXCLUDED.binding_name,
				    cursor = EXCLUDED.cursor,
				    last_pulled_at = EXCLUDED.last_pulled_at,
				    last_error = EXCLUDED.last_error`,
				[command.integrationName, command.bindingName, bindingKey, cursor, command.error ?? null]
			);
			return { cursor };
		}
		default: {
			const _exhaustive: never = command;
			throw new Error(`Unknown integration-cursor action: ${JSON.stringify(_exhaustive)}`);
		}
	}
}

async function runHostIdentityRead(
	db: HostDbBinding,
	command: z.infer<typeof identityReadCommandSchema>
): Promise<unknown> {
	switch (command.action) {
		case 'seats':
			return seatCensusOnDb(db);
		case 'membership':
			return workspaceMembershipOnDb(db);
		case 'invite-email':
			return { email: await inviteeEmailForTokenOnDb(db, hashToken(command.token)) };
		default: {
			const _exhaustive: never = command;
			throw new Error(`Unknown identity read action: ${JSON.stringify(_exhaustive)}`);
		}
	}
}

async function claimOutboxRows(db: HostDbBinding, limit: number | undefined): Promise<unknown[]> {
	const capped = Math.min(Math.max(limit ?? 50, 1), 200);
	const tx = await db.begin();
	try {
		const selected = await db.txQuery(
			tx,
			`SELECT *
			   FROM integration_outbox
			  WHERE (
			    (status IN ('pending', 'failed') AND available_at <= now())
			    OR (status = 'processing' AND claimed_at <= now() - make_interval(secs => $2))
			  )
			  ORDER BY available_at
			  LIMIT $1
			  FOR UPDATE SKIP LOCKED`,
			[capped, OUTBOX_CLAIM_LEASE_MS / 1000]
		);
		if (selected.rows.length === 0) {
			await db.commit(tx);
			return [];
		}
		const ids = selected.rows
			.map((row) =>
				row != null && typeof row === 'object' && 'norbital_id' in row
					? String((row as { norbital_id: unknown }).norbital_id)
					: null
			)
			.filter((id): id is string => id != null);
		await db.txQuery(
			tx,
			`UPDATE integration_outbox
			    SET status = 'processing', claimed_at = now(), attempts = attempts + 1
			  WHERE norbital_id = ANY($1::uuid[])`,
			[ids]
		);
		await db.commit(tx);
		return [...selected.rows];
	} catch (error) {
		await db.rollback(tx).catch(() => undefined);
		throw error;
	}
}

async function settleOutboxDelivered(
	db: HostDbBinding,
	ids: readonly string[]
): Promise<{ updated: number }> {
	if (ids.length === 0) return { updated: 0 };
	const result = await db.query(
		`UPDATE integration_outbox
		    SET status = 'delivered', delivered_at = now(), last_error = NULL
		  WHERE norbital_id = ANY($1::uuid[]) AND status = 'processing'
		  RETURNING norbital_id`,
		[ids]
	);
	return { updated: result.rowCount };
}

async function settleOutboxFailed(
	db: HostDbBinding,
	ids: readonly string[],
	error: string,
	retryAt: string
): Promise<{ updated: number }> {
	if (ids.length === 0) return { updated: 0 };
	const result = await db.query(
		`UPDATE integration_outbox
		    SET status = CASE WHEN attempts >= 10 THEN 'dead_letter' ELSE 'failed' END,
		        available_at = $2::timestamptz,
		        last_error = $3,
		        claimed_at = NULL
		  WHERE norbital_id = ANY($1::uuid[]) AND status = 'processing'
		  RETURNING norbital_id`,
		[ids, retryAt, error]
	);
	return { updated: result.rowCount };
}

async function claimNotificationRows(
	db: HostDbBinding,
	limit: number | undefined
): Promise<unknown[]> {
	const capped = Math.min(Math.max(limit ?? 50, 1), 200);
	const tx = await db.begin();
	try {
		const selected = await db.txQuery(
			tx,
			`SELECT *
			   FROM notification_outbox
			  WHERE (
			    (status IN ('pending', 'failed') AND available_at <= now())
			    OR (status = 'processing' AND claimed_at <= now() - make_interval(secs => $2))
			  )
			  ORDER BY available_at
			  LIMIT $1
			  FOR UPDATE SKIP LOCKED`,
			[capped, NOTIFICATION_CLAIM_LEASE_MS / 1000]
		);
		if (selected.rows.length === 0) {
			await db.commit(tx);
			return [];
		}
		const ids = selected.rows
			.map((row) =>
				row != null && typeof row === 'object' && 'norbital_id' in row
					? String((row as { norbital_id: unknown }).norbital_id)
					: null
			)
			.filter((id): id is string => id != null);
		await db.txQuery(
			tx,
			`UPDATE notification_outbox
			    SET status = 'processing', claimed_at = now(), attempts = attempts + 1
			  WHERE norbital_id = ANY($1::uuid[])`,
			[ids]
		);
		await db.commit(tx);
		return [...selected.rows];
	} catch (error) {
		await db.rollback(tx).catch(() => undefined);
		throw error;
	}
}

async function settleNotificationDelivered(
	db: HostDbBinding,
	ids: readonly string[]
): Promise<{ updated: number }> {
	if (ids.length === 0) return { updated: 0 };
	const result = await db.query(
		`UPDATE notification_outbox
		    SET status = 'delivered', delivered_at = now(), last_error = NULL
		  WHERE norbital_id = ANY($1::uuid[]) AND status = 'processing'
		  RETURNING norbital_id`,
		[ids]
	);
	return { updated: result.rowCount };
}

async function settleNotificationFailed(
	db: HostDbBinding,
	ids: readonly string[],
	error: string,
	retryAt: string
): Promise<{ updated: number }> {
	if (ids.length === 0) return { updated: 0 };
	const result = await db.query(
		`UPDATE notification_outbox
		    SET status = CASE WHEN attempts >= 10 THEN 'dead_letter' ELSE 'failed' END,
		        available_at = $2::timestamptz,
		        last_error = $3,
		        claimed_at = NULL
		  WHERE norbital_id = ANY($1::uuid[]) AND status = 'processing'
		  RETURNING norbital_id`,
		[ids, retryAt, error]
	);
	return { updated: result.rowCount };
}

