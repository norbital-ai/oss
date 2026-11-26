// Connection lifecycle finite-state machine shared by connection cards, Settings and Envoys.
// Every card resolves deterministically to one phase, one status badge and one primary CTA button.
import { Option, Schema } from 'effect';
import { InstanceState, type InstanceStatus } from '@norbital-ai/host-api';
import type { Json } from '../decl/values.ts';

/**
 * The lifecycle phases of a connection card:
 * - `not_installed`: no `sys_integration` record exists yet
 * - `not_connected`: record created, not yet paired (or pairing cancelled)
 * - `connecting`: pairing, connecting or reconnecting in progress
 * - `connected`: paired and active
 * - `disconnected`: manually disconnected by the user (`unpaired` with `code: 'disconnected'`)
 * - `paused`: record disabled (`active === false`)
 * - `error`: link or host failure requiring retry
 */
export type ConnectionPhase =
	| 'not_installed'
	| 'not_connected'
	| 'connecting'
	| 'connected'
	| 'disconnected'
	| 'paused'
	| 'error';

/** Semantic status tone mapped to `--tone-*` tokens. */
export type ConnectionTone = 'neutral' | 'info' | 'success' | 'warning' | 'destructive';

/** The primary state-transition action a card's CTA button triggers. */
export type ConnectionAction =
	| 'install'
	| 'connect'
	| 'continue'
	| 'cancel'
	| 'disconnect'
	| 'reconnect'
	| 'retry'
	| 'resume'
	| 'manage';

/** Primary button specification produced by the connection FSM for the card's current phase. */
export type ConnectionCta = {
	readonly action: ConnectionAction;
	readonly label: string;
	readonly variant: 'default' | 'outline';
	readonly disabled: boolean;
};

/** Resolved display snapshot for one connection card: phase, badge tone/label, account, detail and primary CTA. */
export type ConnectionSnapshot = {
	readonly phase: ConnectionPhase;
	/** Short badge label (English key for `t(...)`). */
	readonly label: string;
	readonly tone: ConnectionTone;
	/** Connected account identity when live. */
	readonly account: string | null;
	/** Concise error or detail message when present. */
	readonly detail: string | null;
	readonly cta: ConnectionCta;
};

const StoredStatusSchema = Schema.Struct({
	state: Schema.optionalKey(InstanceState),
	account: Schema.optionalKey(Schema.NullOr(Schema.String)),
	code: Schema.optionalKey(Schema.NullOr(Schema.String)),
	error: Schema.optionalKey(Schema.NullOr(Schema.String))
});
/** Decoded subset of `sys_integration.status` used before the live host status arrives. */
export type StoredStatus = typeof StoredStatusSchema.Type;

/** Decodes the durable `sys_integration.status` JSON column for flicker-free initial rendering. */
export function decodeStoredStatus(raw: Json | null | undefined): StoredStatus | null {
	if (raw === null || raw === undefined) return null;
	return Option.getOrNull(Schema.decodeUnknownOption(StoredStatusSchema)(raw));
}

/** Inputs to `resolveConnectionState` combining durable row state, live status and local UI flags. */
export type ConnectionFsmInput = {
	readonly installed: boolean;
	readonly active?: boolean | undefined;
	readonly status: InstanceStatus | null;
	/** Fallback durable status from the `sys_integration` row while live status loads. */
	readonly storedStatus?: StoredStatus | null | undefined;
	readonly busy?: boolean | undefined;
	readonly error?: string | null | undefined;
	/** `false` when the host has no available provider for this integration. */
	readonly available?: boolean | undefined;
	/** Whether the pairing/setup sheet is currently open. */
	readonly setupOpen?: boolean | undefined;
	/** Whether the caller can resume a paused instance. */
	readonly canResume?: boolean | undefined;
	/** Whether the caller has permission to mutate this connection. */
	readonly readonly?: boolean | undefined;
};

/**
 * Pure FSM resolver: maps durable row + live host status + interaction flags into the card's
 * visual phase, badge tone and primary CTA transition.
 */
export function resolveConnectionState(input: ConnectionFsmInput): ConnectionSnapshot {
	const busy = input.busy === true;
	const available = input.available !== false;
	const locked = input.readonly === true;
	const liveState = input.status?.state ?? input.storedStatus?.state;
	const code = input.status !== null ? (input.status.code ?? null) : (input.storedStatus?.code ?? null);
	const account =
		input.status !== null
			? (input.status.account ?? null)
			: (input.storedStatus?.account ?? null);
	const linkError =
		input.error ??
		(input.status !== null
			? (input.status.error ?? null)
			: (input.storedStatus?.error ?? null));

	if (!input.installed) {
		return {
			phase: 'not_installed',
			label: 'Not yet installed',
			tone: 'neutral',
			account: null,
			detail: input.error ?? null,
			cta: {
				action: 'install',
				label: busy ? 'Installing…' : 'Install',
				variant: 'default',
				disabled: busy || !available || locked
			}
		};
	}

	if (input.active === false) {
		return {
			phase: 'paused',
			label: 'Paused',
			tone: 'warning',
			account,
			detail: input.error ?? null,
			cta: input.canResume
				? {
						action: 'resume',
						label: busy ? 'Working…' : 'Resume',
						variant: 'default',
						disabled: busy || locked
					}
				: {
						action: 'manage',
						label: 'Manage',
						variant: 'outline',
						disabled: busy
					}
		};
	}

	if (liveState === 'error' || (input.error !== null && input.error !== undefined)) {
		return {
			phase: 'error',
			label: 'Error',
			tone: 'destructive',
			account,
			detail: linkError,
			cta: {
				action: 'retry',
				label: busy ? 'Connecting…' : 'Retry',
				variant: 'default',
				disabled: busy || !available || locked
			}
		};
	}

	if (liveState === 'pairing' || liveState === 'connecting' || liveState === 'reconnecting') {
		const label =
			liveState === 'pairing'
				? 'Pairing'
				: liveState === 'reconnecting'
					? 'Reconnecting'
					: 'Connecting';
		return {
			phase: 'connecting',
			label,
			tone: 'info',
			account,
			detail: input.status?.detail ?? null,
			cta:
				input.setupOpen === true
					? {
							action: 'cancel',
							label: 'Cancel',
							variant: 'outline',
							disabled: busy || locked
						}
					: {
							action: 'continue',
							label: liveState === 'pairing' ? 'Continue setup' : 'View status',
							variant: 'default',
							disabled: busy
						}
		};
	}

	if (liveState === 'connected') {
		return {
			phase: 'connected',
			label: 'Connected',
			tone: 'success',
			account,
			detail: input.status?.detail ?? null,
			cta: {
				action: 'disconnect',
				label: busy ? 'Disconnecting…' : 'Disconnect',
				variant: 'outline',
				disabled: busy || locked
			}
		};
	}

	if (code === 'disconnected') {
		return {
			phase: 'disconnected',
			label: 'Disconnected',
			tone: 'warning',
			account: null,
			detail: null,
			cta: {
				action: 'reconnect',
				label: busy ? 'Connecting…' : 'Reconnect',
				variant: 'default',
				disabled: busy || !available || locked
			}
		};
	}

	return {
		phase: 'not_connected',
		label: 'Not connected',
		tone: 'neutral',
		account: null,
		detail: null,
		cta: {
			action: 'connect',
			label: busy ? 'Connecting…' : 'Connect',
			variant: 'default',
			disabled: busy || !available || locked
		}
	};
}
