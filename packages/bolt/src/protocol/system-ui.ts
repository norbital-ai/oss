import { Option, Schema } from 'effect';

/** Shared by discovery, the tool and the native client. Opening a form never submits it. */
export const SYSTEM_UI = {
	'envoy.create': { path: '/settings/integrations', tab: 'envoys', followUp: 'native envoy form' },
	'integration.manage': {
		path: '/settings/integrations',
		tab: 'envoys',
		followUp: 'native connection setup, pairing or configuration'
	},
	'member.invite': {
		path: '/command-center/people',
		tab: 'invitations',
		followUp: 'native invitation form'
	},
	'member.manage': {
		path: '/command-center/people',
		tab: 'members',
		followUp: 'native member details and access controls'
	},
	'mcp.configure': {
		path: '/settings/integrations',
		tab: 'mcp',
		followUp: 'declared MCP settings and linked secret entry'
	},
	'secret.set': {
		path: '/settings/secrets',
		tab: 'secrets',
		followUp: 'native write-only secret form'
	},
	'api_key.create': {
		path: '/settings/integrations',
		tab: 'keys',
		followUp: 'native key form; the issued key is shown only to the person'
	},
	'api_key.manage': {
		path: '/settings/integrations',
		tab: 'keys',
		followUp: 'native key details, rotate or revoke'
	}
} as const;
export const SystemUiRequest = Schema.Union([
	Schema.Struct({
		capability: Schema.Literals(['envoy.create', 'member.invite', 'api_key.create'])
	}),
	Schema.Struct({
		capability: Schema.Literals([
			'integration.manage',
			'member.manage',
			'mcp.configure',
			'secret.set',
			'api_key.manage'
		]),
		record: Schema.NonEmptyString.check(Schema.isMaxLength(512))
	})
]);
export type SystemUiRequest = typeof SystemUiRequest.Type;
export type SystemUiIntent = { readonly key: string; readonly request: SystemUiRequest };
const decode = Schema.decodeUnknownOption(SystemUiRequest, { onExcessProperty: 'error' });

/** Only the registry may add setup parameters; no credential or arbitrary prefill is accepted. */
export function systemUiPath(path: string, request: SystemUiRequest): string | null {
	if (SYSTEM_UI[request.capability].path !== path) return null;
	const query = new URLSearchParams({ setup: request.capability });
	if ('record' in request) query.set('record', request.record);
	return `${path}?${query}`;
}

export function systemUiIntent(url: URL): SystemUiIntent | null {
	const capability = url.searchParams.get('setup');
	if (capability === null) return null;
	const record = url.searchParams.get('record');
	const request = decode({ capability, ...(record === null ? {} : { record }) });
	if (Option.isNone(request) || SYSTEM_UI[request.value.capability].path !== url.pathname)
		return null;
	return {
		key: url.searchParams.get('setupRequest') ?? `${capability}:${record ?? ''}`,
		request: request.value
	};
}

/** The requested client navigation is still an exact known page, optionally with this closed setup intent. */
export function clientNavigationPath(
	path: string,
	paths: readonly string[],
	admin: boolean
): boolean {
	if (paths.includes(path)) return true;
	if (!admin || !path.startsWith('/') || path.startsWith('//')) return false;
	const url = new URL(path, 'https://workspace.invalid');
	if (
		url.origin !== 'https://workspace.invalid' ||
		url.hash !== '' ||
		!paths.includes(url.pathname)
	)
		return false;
	if ([...url.searchParams.keys()].some((key) => key !== 'setup' && key !== 'record')) return false;
	if ([...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1))
		return false;
	return systemUiIntent(url) !== null;
}
