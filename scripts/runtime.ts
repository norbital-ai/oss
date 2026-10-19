import * as NodeServices from '@effect/platform-node/NodeServices';
import { ConfigProvider, Context, Layer } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
export const ProcessEnvironment = Context.Service<Readonly<Record<string, string | undefined>>>(
	'oss/scripts/ProcessEnvironment'
);
/** The script's single Node/config boundary; children receive their environment explicitly. */
export const ScriptLive = Layer.mergeAll(
	NodeServices.layer,
	FetchHttpClient.layer,
	ConfigProvider.layer(ConfigProvider.fromEnv()),
	Layer.succeed(ProcessEnvironment, { ...process.env })
);
