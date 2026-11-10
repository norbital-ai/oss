import { Effect, Option } from 'effect';
import type * as HttpServerRequest from 'effect/http/HttpServerRequest';
import type { Authority } from '../../engine/contracts.ts';
import type { EngineManifest } from '../../engine/manifest.ts';
import { Identity } from '../../engine/services.ts';
import { audienceOf, canOpenKiosk, kioskOf, kioskPolicies } from '../nav.ts';
import { HEADERS } from '../../protocol/wire.ts';

export const KIOSK_PATH = /^[a-z][a-z0-9_]*(?:\/[a-z][a-z0-9_]*)*$/;

export const requestKiosk = (
	request: HttpServerRequest.HttpServerRequest,
	query: boolean
): Option.Option<string> => {
	const value =
		request.headers[HEADERS.kiosk.toLowerCase()] ??
		(query ? new URL(request.url, 'http://bolt.local').searchParams.get('kiosk') : null);
	return value !== null && value !== undefined && KIOSK_PATH.test(value)
		? Option.some(value)
		: Option.none();
};
export const kioskAuthority = Effect.fn('shell.kioskAuthority')(function* (
	manifest: EngineManifest,
	name: string,
	member: Authority | null,
	visitor: { readonly id: string; readonly anonymous: boolean }
) {
	const spec = kioskOf(manifest, name);
	if (spec === undefined) return Option.none<Authority>();
	const policies = kioskPolicies(spec);
	if (
		policies === undefined ||
		policies.length === 0 ||
		policies.some((policy) => manifest.policies[policy] === undefined) ||
		(member === null ? audienceOf(spec) !== 'public' : !canOpenKiosk(spec, member, name))
	)
		return Option.none<Authority>();
	const identity = yield* Identity;
	const authority = yield* identity.authority(
		{
			actor: member?.actor ?? {
				kind: 'visitor',
				app: name,
				visitor: visitor.id,
				...(visitor.anonymous ? { anonymous: true as const } : {})
			},
			policies,
			admin: false,
			...(member?.teamTree === undefined ? {} : { teamTree: member.teamTree }),
			...(member?.scopes === undefined ? {} : { scopes: member.scopes })
		},
		`kiosk:${name}:${member?.key ?? `visitor:${visitor.id}:${visitor.anonymous}`}`
	);
	return Option.some({ ...authority, kiosk: name });
});
type KioskBoot =
	| { readonly _tag: 'Unknown' }
	| { readonly _tag: 'SignIn' }
	| { readonly _tag: 'Closed'; readonly message: string }
	| { readonly _tag: 'Member'; readonly authority: Authority }
	| { readonly _tag: 'Visitor'; readonly authority: Authority };
export const kioskBoot = Effect.fn('shell.kioskBoot')(function* (
	manifest: EngineManifest,
	name: string,
	member: Authority | null,
	visitor: { readonly id: string; readonly anonymous: boolean }
): Effect.fn.Return<KioskBoot, never, Identity> {
	const spec = kioskOf(manifest, name);
	if (spec === undefined) return { _tag: 'Unknown' };
	if (member === null && audienceOf(spec) !== 'public') return { _tag: 'SignIn' };
	const authority = yield* kioskAuthority(manifest, name, member, visitor);
	return Option.isNone(authority)
		? { _tag: 'Closed', message: 'This kiosk is not open to you.' }
		: member === null
			? { _tag: 'Visitor', authority: authority.value }
			: { _tag: 'Member', authority: authority.value };
});
