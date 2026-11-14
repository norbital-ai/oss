import { integration } from '../../../decl/runtime/integration.ts';

export default integration('github', {
	description: "GitHub: an account's repositories, private ones included, read-only through its fine-grained access token.",
	driver: 'http',
	credential: { token: { kind: 'text' } },
	http: {
		base_url: 'https://api.github.com/',
		auth: { bearer: 'token' },
		// read-only by construction: whatever the token may do, the connection only reads (and `/user` checks its access)
		allow: {
			methods: ['GET', 'HEAD'],
			paths: [
				'/user',
				'/repos/{owner}/{repo}',
				'/repos/{owner}/{repo}/tarball/{ref}',
				'/repos/{owner}/{repo}/zipball/{ref}',
				'/repos/{owner}/{repo}/contents/**',
				'/repos/{owner}/{repo}/git/trees/**',
				'/repos/{owner}/{repo}/git/blobs/**'
			]
		}
	}
});
