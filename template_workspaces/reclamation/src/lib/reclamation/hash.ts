/**
 * SHA-256 over Web Crypto.
 *
 * Document digests are recorded on every stitch so a reconstruction can be tied
 * back to the exact bytes it was built from. Web Crypto is used rather than
 * `node:crypto` so the engine stays isomorphic: the same module runs in the
 * server hook and in the browser tessellation worker.
 */

export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
	const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
	const buffer = new Uint8Array(data).buffer;
	const digest = await crypto.subtle.digest('SHA-256', buffer);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
