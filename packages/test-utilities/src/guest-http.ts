import { SYSTEM_SIGNATURE_HEADER, SYSTEM_TIMESTAMP_HEADER } from '@norbital-ai/bolt-protocol';
import { systemCommandHeaders } from '@norbital-ai/bolt-server';
import { Effect, Redacted } from 'effect';
import type { GuestCommandResult } from './with-self-host.js';

export type MutationResolution = 'accepted' | 'rebased' | 'rejected' | 'quarantined';

export const asRecord = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`${label} was not an object: ${JSON.stringify(value)}`);
	}
	return value as Readonly<Record<string, unknown>>;
};

const isRow = (row: unknown): row is Readonly<Record<string, unknown>> =>
	typeof row === 'object' && row !== null && !Array.isArray(row);

export const rowsOf = (
	value: unknown,
	label: string
): ReadonlyArray<Readonly<Record<string, unknown>>> => {
	if (Array.isArray(value)) return value.filter(isRow);
	const page = asRecord(value, label);
	const rows = page.rows ?? page.records;
	if (!Array.isArray(rows)) throw new Error(`${label} had no rows: ${JSON.stringify(value)}`);
	return rows.filter(isRow);
};

export const pageOf = (
	value: unknown,
	label: string
): {
	readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
	readonly nextCursor: unknown;
} => {
	const rows = rowsOf(value, label);
	if (Array.isArray(value)) return { rows, nextCursor: undefined };
	return { rows, nextCursor: asRecord(value, label).nextCursor };
};

export const mutationPush = (
	schemaFingerprint: string,
	graph: Readonly<Record<string, unknown>>,
	baseVersions: ReadonlyArray<Readonly<Record<string, unknown>>> = []
) => ({
	protocolVersion: 2,
	idempotencyKey: crypto.randomUUID(),
	issuedAtEpochMs: Date.now(),
	partitionKey: crypto.randomUUID(),
	schemaFingerprint,
	graph,
	baseVersions
});

export const mutationResolution = (
	value: unknown,
	label = 'collections.mutate'
): MutationResolution => {
	const resolution = asRecord(value, label).resolution;
	switch (resolution) {
		case 'accepted':
		case 'rebased':
		case 'rejected':
		case 'quarantined':
			return resolution;
		default: {
			const _exhaustive: never = resolution as never;
			throw new Error(
				`${label} returned an unhandled resolution: ${String(_exhaustive)} ${JSON.stringify(value)}`
			);
		}
	}
};

export const requireAccepted = (value: unknown, label: string): void => {
	const resolution = mutationResolution(value, label);
	switch (resolution) {
		case 'accepted':
			return;
		case 'quarantined':
			throw new Error(`${label} quarantined (A1): ${JSON.stringify(value)}`);
		case 'rebased':
		case 'rejected':
			throw new Error(`${label} ${resolution}: ${JSON.stringify(value)}`);
		default: {
			const _exhaustive: never = resolution;
			throw new Error(`${label} unhandled mutation resolution: ${String(_exhaustive)}`);
		}
	}
};

export const postGuestCommand = async (
	baseUrl: string,
	command: string,
	input: unknown,
	headers: Readonly<Record<string, string>>
): Promise<GuestCommandResult> => {
	const response = await fetch(`${baseUrl}/_bolt/command/${encodeURIComponent(command)}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify(input)
	});
	const text = await response.text();
	let value: unknown = null;
	if (text.length > 0) {
		try {
			value = JSON.parse(text);
		} catch {
			value = text;
		}
	}
	return { status: response.status, value };
};

export const requireOk = (result: GuestCommandResult, command: string): unknown => {
	if (result.status < 200 || result.status >= 300) {
		throw new Error(`${command} HTTP ${result.status}: ${JSON.stringify(result.value)}`);
	}
	return result.value;
};

export const bearerHeaders = (credential: string): Readonly<Record<string, string>> => ({
	authorization: `Bearer ${credential}`
});

export const systemHeaders = (
	command: string,
	input: unknown,
	gatewaySecret: string,
	tenantId: string
): Readonly<Record<string, string>> => {
	const signed = Effect.runSync(
		systemCommandHeaders(Redacted.make(gatewaySecret), command, tenantId, input)
	);
	return {
		[SYSTEM_SIGNATURE_HEADER]: signed[SYSTEM_SIGNATURE_HEADER]?.[0] ?? '',
		[SYSTEM_TIMESTAMP_HEADER]: signed[SYSTEM_TIMESTAMP_HEADER]?.[0] ?? ''
	};
};

const sentenceOf = (value: unknown): string => {
	if (typeof value === 'string') return value;
	if (value == null) return '';
	if (typeof value === 'object') {
		const record = value as Readonly<Record<string, unknown>>;
		const nested = record.message ?? record.error;
		if (typeof nested === 'string') return nested;
		if (typeof nested === 'object' && nested !== null && 'message' in nested) {
			const inner = (nested as { readonly message?: unknown }).message;
			if (typeof inner === 'string') return inner;
		}
	}
	return JSON.stringify(value);
};

export const commandSentence = (result: GuestCommandResult): string => sentenceOf(result.value);
