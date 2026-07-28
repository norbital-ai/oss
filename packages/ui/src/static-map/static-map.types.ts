export interface StaticMapMarker {
	readonly latitude: number;
	readonly longitude: number;
	readonly label?: string;
	readonly ariaLabel?: string;
	readonly tone?: 'default' | 'alert';
}

export interface StaticMapRequest {
	readonly markers: readonly StaticMapMarker[];
}

export interface StaticMapImage {
	readonly mimeType: 'image/png' | 'image/jpeg';
	readonly dataBase64: string;
	readonly markerPositions?: readonly {
		readonly x: number;
		readonly y: number;
	}[];
}
