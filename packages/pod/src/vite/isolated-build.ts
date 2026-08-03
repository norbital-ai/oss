import { createBuilder, type InlineConfig } from 'vite';

interface IsolatedBuildConfig {
	readonly root: string;
	readonly configFile: string;
	readonly mode: string;
	readonly logLevel: InlineConfig['logLevel'];
	readonly clearScreen: boolean;
}

function readConfig(serialized: string | undefined): IsolatedBuildConfig {
	if (serialized == null) throw new Error('Isolated Pod build requires serialized Vite config');
	const value: unknown = JSON.parse(serialized);
	if (typeof value !== 'object' || value == null) {
		throw new Error('Isolated Pod build config must be an object');
	}
	const candidate = value as Partial<IsolatedBuildConfig>;
	if (
		typeof candidate.root !== 'string' ||
		typeof candidate.configFile !== 'string' ||
		typeof candidate.mode !== 'string' ||
		typeof candidate.clearScreen !== 'boolean'
	) {
		throw new Error('Isolated Pod build config is incomplete');
	}
	return candidate as IsolatedBuildConfig;
}

const config = readConfig(process.argv[2]);
const builder = await createBuilder({
	root: config.root,
	configFile: config.configFile,
	mode: config.mode,
	logLevel: config.logLevel,
	clearScreen: config.clearScreen
});
await builder.buildApp();
