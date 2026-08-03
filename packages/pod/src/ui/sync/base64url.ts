const BASE64_CHUNK_SIZE = 0x8000;

export function encodeBase64Url(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE));
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeBase64Url(value: string): string {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
	const binary = atob(padded);
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}
