export const POD_CLIENT_PLATFORM_MANIFEST = 'platform-manifest.json';

export interface PodClientPlatformManifest {
	readonly format: 'pod-client-platform-1';
	readonly packageKey: string;
	readonly imports: Readonly<Record<string, string>>;
	readonly stylesheets: readonly string[];
}
