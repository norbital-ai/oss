import { pathToFileURL } from 'node:url';
import {
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	SYSTEM_TIMESTAMP_HEADER,
	decodeBoltBundleModule,
	type FacilityBindings
} from '@norbital-ai/bolt-protocol';
import { Clock, Effect, Redacted, Schema } from 'effect';
import { decodeNumber } from '@norbital-ai/std/json';
import { systemCommandHeaders } from './system-headers.js';

export type DispatchSystemCommandInput = {
	readonly bundlePath: string;
	readonly facilities: FacilityBindings;
	readonly scope: FacilityBindings['scope'];
	readonly gatewaySecret: string;
	readonly command: string;
	readonly input: unknown;
	readonly invocationId?: string;
};

export type DispatchSystemCommandResult = {
	readonly status: number;
	readonly value: unknown;
};

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const isNumber = Schema.is(Schema.Number);

const commandValue = (result: unknown, command: string): DispatchSystemCommandResult => {
	if (!isRecord(result)) {
		throw new Error(`${command} returned a non-object: ${String(result)}`);
	}
	const tagged = result as {
		readonly _tag?: string;
		readonly response?: { readonly status?: number; readonly value?: unknown };
		readonly error?: { readonly message?: string };
	};
	if (tagged._tag === 'Failure') {
		throw new Error(`${command} failed: ${tagged.error?.message ?? JSON.stringify(result)}`);
	}
	if (tagged._tag !== 'Success') {
		throw new Error(`${command} failed: ${JSON.stringify(result)}`);
	}
	const status = tagged.response?.status;
	if (!isNumber(status) || status < 200 || status >= 300) {
		throw new Error(`${command}: runtime returned ${String(status)}`);
	}
	return { status, value: tagged.response?.value ?? null };
};

/** Signed guest command against a loaded bundle (migrate / founder before listen). */
export const dispatchSystemCommand = (
	input: DispatchSystemCommandInput
): Promise<DispatchSystemCommandResult> =>
	Effect.gen(function* () {
		const bundle = yield* decodeBoltBundleModule(
			yield* Effect.tryPromise(() => import(pathToFileURL(input.bundlePath).href))
		);
		const headers = yield* systemCommandHeaders(
			Redacted.make(input.gatewaySecret),
			input.command,
			String(input.scope.tenantId),
			input.input
		);
		// Fallback only when the signed timestamp header is absent; the signed path already
		// sources the clock inside `systemCommandHeaders`.
		const now = yield* Clock.currentTimeMillis;
		const result = yield* Effect.tryPromise(() =>
			bundle.dispatch(
				Invocation.cases.Command.make({
					protocolVersion: PROTOCOL_VERSION,
					// repository-health:allow EFF5 -- a pre-boot dispatch needs a fresh opaque invocation identity; no Effect service provides randomness and the id is transport metadata, never a decision input.
					id: InvocationId.make(input.invocationId ?? `${input.command}:${crypto.randomUUID()}`),
					scope: input.scope,
					deadlineEpochMs: decodeNumber(headers[SYSTEM_TIMESTAMP_HEADER]?.[0] ?? now) + 30_000,
					command: input.command,
					input: input.input as never,
					headers
				}),
				input.facilities,
				AbortSignal.timeout(30_000)
			)
		);
		return yield* Effect.try(() => commandValue(result, input.command));
	}).pipe(Effect.runPromise);
