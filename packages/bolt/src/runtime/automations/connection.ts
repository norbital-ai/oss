import { Effect, Schema } from 'effect';
import {
	EffectId,
	INTEGRATION_HTTP_OPERATION,
	IntegrationHttpResponse
} from '@norbital-ai/bolt-protocol';
import type { AutomationApi } from '#lib/authoring/automations-schema.js';
import type { HttpConnection } from '#lib/authoring/contracts-schema.js';
import { FacilityError } from '#lib/runtime/facilities/database.js';
import type { ConnectorInterface } from '#lib/runtime/facilities/services.js';
import { authenticationHeaders } from '#lib/runtime/integrations/pull.js';
import { Secrets, type Interface as SecretsInterface } from '#lib/runtime/secrets/secrets.js';

type GetInput = Parameters<AutomationApi['connection']['get']>[0];
const failure = (code: string, message: string) =>
	new FacilityError({
		operation: INTEGRATION_HTTP_OPERATION,
		code,
		message,
		retryable: false,
		outcome: 'known'
	});

/** Relative paths stay within the authored API prefix; callers cannot replace its origin or credentials. */
const targetUrl = (connection: HttpConnection, input: GetInput): string => {
	const base = new URL(connection.baseUrl);
	if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
		throw new Error(
			'Managed connections require an HTTPS base URL without credentials, query or fragment.'
		);
	if (!input.path || input.path.startsWith('/') || /[\\?#\s\x00-\x1f]/.test(input.path))
		throw new Error('Connection GET requires a relative path without query or fragment.');
	for (const part of input.path.split('/')) {
		const decoded = decodeURIComponent(part);
		if (decoded === '.' || decoded === '..' || /[\\/%\x00-\x1f]/.test(decoded))
			throw new Error('Connection GET cannot traverse outside its declared API path.');
	}
	base.pathname = `${base.pathname.replace(/\/$/, '')}/`;
	const target = new URL(input.path, base);
	if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname))
		throw new Error('Connection GET must remain within its declared API path.');
	for (const [name, value] of Object.entries(input.query ?? {}))
		target.searchParams.set(name, String(value));
	return target.toString();
};

/** Binds one automation's connection; secrets are resolved only when it makes a request. */
export const connectionReader = (
	effectId: EffectId,
	connection: HttpConnection | undefined,
	connector: ConnectorInterface
): ((
	input: GetInput
) => Effect.Effect<IntegrationHttpResponse, FacilityError, SecretsInterface>) => {
	let sequence = 0;
	return (input: GetInput) =>
		Effect.gen(function* () {
			if (connection === undefined)
				return yield* failure(
					'connection.not_declared',
					'This automation declares no HTTP connection.'
				);
			const url = yield* Effect.try({
				try: () => targetUrl(connection, input),
				catch: () =>
					failure(
						'connection.invalid_path',
						'Connection GET requires a relative path within its declared HTTPS API.'
					)
			});
			const requestId = EffectId.make(`${effectId}:connection:${sequence++}`);
			const secrets = yield* Secrets.Service;
			const headers = yield* authenticationHeaders(
				(id, name) =>
					secrets.read(id, name).pipe(
						Effect.mapError(() => ({
							message: `The managed credential ${name} could not be read.`
						})),
						Effect.flatMap((value) =>
							value === null || value === ''
								? Effect.fail({
										message: `Configure the managed credential ${name} before running this automation.`
									})
								: Effect.succeed(value)
						)
					),
				requestId,
				connection
			).pipe(Effect.mapError((error) => failure('connection.credential', error.message)));
			const response = yield* connector.execute(requestId, {
				connector: 'http',
				operation: INTEGRATION_HTTP_OPERATION,
				input: { method: 'GET', url, headers }
			});
			return yield* Schema.decodeUnknownEffect(IntegrationHttpResponse)(response.output).pipe(
				Effect.mapError(() =>
					failure('connection.invalid_response', 'HTTP connector returned an invalid response.')
				)
			);
		});
};
