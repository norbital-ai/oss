import { pathToFileURL } from 'node:url';
import {
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	SYSTEM_TIMESTAMP_HEADER,
	decodeBoltBundleModule,
	type FacilityBindings
} from '@norbital-ai/bolt-protocol';
import { Effect, Redacted } from 'effect';
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

const commandValue = (result: unknown, command: string): DispatchSystemCommandResult => {
	if (typeof result !== 'object' || result === null) {
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
	if (typeof status !== 'number' || status < 200 || status >= 300) {
		throw new Error(`${command}: runtime returned ${String(status)}`);
	}
	return { status, value: tagged.response?.value ?? null };
};

/** Signed guest command against a loaded bundle (migrate / founder before listen). */
export const dispatchSystemCommand = async (
	input: DispatchSystemCommandInput
): Promise<DispatchSystemCommandResult> => {
	const bundle = await Effect.runPromise(
		decodeBoltBundleModule(await import(pathToFileURL(input.bundlePath).href))
	);
	const headers = await Effect.runPromise(
		systemCommandHeaders(
			Redacted.make(input.gatewaySecret),
			input.command,
			String(input.scope.tenantId),
			input.input
		)
	);
	const timestamp = Number(headers[SYSTEM_TIMESTAMP_HEADER]?.[0] ?? Date.now());
	const result = await bundle.dispatch(
		Invocation.cases.Command.make({
			protocolVersion: PROTOCOL_VERSION,
			id: InvocationId.make(input.invocationId ?? `${input.command}:${crypto.randomUUID()}`),
			scope: input.scope,
			deadlineEpochMs: timestamp + 30_000,
			command: input.command,
			input: input.input as never,
			headers
		}),
		input.facilities,
		AbortSignal.timeout(30_000)
	);
	return commandValue(result, input.command);
};
