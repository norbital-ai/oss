export function workspaceContainerCreateArguments({ name, image, platformDirectory }) {
	if (!name) throw new Error('Workspace container name is required.');
	if (!image) throw new Error('Workspace container image is required.');
	if (!platformDirectory) throw new Error('Workspace container platform directory is required.');

	return [
		'create',
		'--platform',
		'linux/amd64',
		'--name',
		name,
		'--network',
		'none',
		'--memory',
		'500m',
		'--memory-swap',
		'500m',
		'--env',
		`NORBITAL_POD_PLATFORM_DIR=${platformDirectory}`,
		image
	];
}
