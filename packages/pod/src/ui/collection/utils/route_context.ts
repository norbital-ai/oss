export type TRouteContext = {
	organization: string;
	appName?: string;
	isWorkspaceStudio?: boolean;
};

export function getRouteContext(url: URL): TRouteContext | null {
	const segments = url.pathname.split('/').filter(Boolean);
	const organization = segments[0];
	if (!organization) {
		return null;
	}

	if (segments[1] === 'workspace-studio') {
		return {
			organization,
			isWorkspaceStudio: true
		};
	}

	if (segments[1] === 'app' && segments[2]) {
		return {
			organization,
			appName: segments.slice(2).map(decodeURIComponent).join('/')
		};
	}

	return null;
}

export function getBaseUrlForRouteContext(url: URL): string {
	const routeContext = getRouteContext(url);
	if (!routeContext) {
		return url.pathname;
	}

	if (routeContext.isWorkspaceStudio) {
		return `/${routeContext.organization}/workspace-studio`;
	}
	if (routeContext.appName) {
		return `/${routeContext.organization}/app/${routeContext.appName
			.split('/')
			.map(encodeURIComponent)
			.join('/')}`;
	}
	return url.pathname;
}
