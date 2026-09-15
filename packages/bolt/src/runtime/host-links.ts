import { PUBLIC_WORKSPACE_ROOT_CONFIG_KEY } from '@norbital-ai/bolt-protocol';
import { Effect, Option, Redacted } from 'effect';
import { HostConfig } from '#lib/runtime/access/system-principal.js';

/**
 * A link into this workspace's shell, minted by the runtime rather than the host.
 *
 * The path is a Bolt browser path, so the same bundle mints a working link under any host that
 * says where it serves the shell — `BOLT_PUBLIC_WORKSPACE_ROOT`, origin and mount prefix, read from
 * the invocation that asked. A context without one (a bare test harness, a host that has not been
 * told) gets the relative link and a logged warning, once per link.
 */
export const workspaceLink = Effect.fn('Bolt.workspaceLink')(function* (
	tenantId: string,
	path: string,
	query: Readonly<Record<string, string>>
) {
	const hostConfig = yield* Effect.serviceOption(HostConfig);
	const root = Option.isNone(hostConfig)
		? Option.none<string>()
		: yield* hostConfig.value.read(PUBLIC_WORKSPACE_ROOT_CONFIG_KEY).pipe(
				Effect.map(Option.map((value) => Redacted.value(value).replace(/\/+$/, ''))),
				Effect.orElseSucceed(() => Option.none<string>())
			);
	if (Option.isNone(root))
		yield* Effect.logWarning(
			`[bolt] ${PUBLIC_WORKSPACE_ROOT_CONFIG_KEY} is not configured; the ${path} link for ${tenantId} is relative.`
		);
	const search = new URLSearchParams({ workspace: tenantId, ...query }).toString();
	return `${Option.getOrElse(root, () => '')}${path}?${search}`;
});
