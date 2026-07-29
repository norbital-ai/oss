/**
 * Structural types for the rendering runtime.
 *
 * Three.js is loaded from a CDN at runtime rather than bundled, matching the
 * other Norbital templates. These interfaces describe only the surface the
 * viewer touches, so the CDN module can be typed without a build dependency.
 */

import type {
	SectionCutLine,
	SiteSurfaces,
	StitchedModel,
	SurfaceMesh
} from '../reclamation/types.js';

export type SiteLayer = {
	readonly id: SurfaceMesh['id'];
	readonly label: string;
	readonly color: string;
	readonly triangles: number;
};

export type SiteViewerStats = {
	readonly vertexCount: number;
	readonly triangleCount: number;
	readonly renderCellM: number;
};

export type SiteViewerProps = {
	/** Serialised `StitchedModel` from `site_reconstructions.model_json`. */
	readonly model: StitchedModel;
	readonly label?: string;
	/** Layer visibility, controlled by the panel beside the viewer. */
	readonly visible?: Readonly<Record<string, boolean>>;
	/** Overrides the model's own render cell size, for on-the-fly quality. */
	readonly renderCellM?: number;
	/** Reports the layers present once the surfaces are built. */
	readonly onLayers?: (layers: readonly SiteLayer[]) => void;
	readonly onStats?: (stats: SiteViewerStats) => void;
};

export type ViewerMessage =
	| { readonly type: 'build'; readonly model: StitchedModel }
	| { readonly type: 'surfaces'; readonly surfaces: SiteSurfaces }
	| { readonly type: 'error'; readonly error: string };

export interface ThreeVector3 {
	x: number;
	y: number;
	z: number;
	set(x: number, y: number, z: number): this;
	copy(other: ThreeVector3): this;
	sub(other: ThreeVector3): this;
	add(other: ThreeVector3): this;
	length(): number;
	normalize(): this;
	multiplyScalar(scalar: number): this;
	clone(): ThreeVector3;
}

export interface ThreeColor {
	set(value: number | string): this;
}

export interface ThreeMaterial {
	color: ThreeColor;
	opacity: number;
	transparent: boolean;
	side: number;
	wireframe: boolean;
	flatShading: boolean;
	needsUpdate: boolean;
	dispose(): void;
}

export interface ThreeBufferAttribute {
	needsUpdate: boolean;
}

export interface ThreeBufferGeometry {
	setAttribute(name: string, attribute: ThreeBufferAttribute): void;
	setIndex(attribute: ThreeBufferAttribute): void;
	computeBoundingSphere(): void;
	dispose(): void;
}

export interface ThreeObject3D {
	name: string;
	visible: boolean;
	position: ThreeVector3;
	rotation: { x: number; y: number; z: number };
	add(child: ThreeObject3D): this;
	remove(child: ThreeObject3D): this;
	clear(): this;
	traverse(callback: (object: ThreeObject3D) => void): void;
}

export interface ThreeMesh extends ThreeObject3D {
	geometry: ThreeBufferGeometry;
	material: ThreeMaterial;
	castShadow: boolean;
	receiveShadow: boolean;
	renderOrder: number;
}

export interface ThreeCamera extends ThreeObject3D {
	aspect: number;
	near: number;
	far: number;
	updateProjectionMatrix(): void;
	lookAt(x: number, y: number, z: number): void;
}

export interface ThreeRenderer {
	domElement: HTMLCanvasElement;
	shadowMap: { enabled: boolean; type: number };
	setSize(width: number, height: number): void;
	setPixelRatio(ratio: number): void;
	setClearColor(color: number | string, alpha?: number): void;
	render(scene: ThreeObject3D, camera: ThreeCamera): void;
	dispose(): void;
}

export interface ThreeControls {
	target: ThreeVector3;
	enableDamping: boolean;
	dampingFactor: number;
	minDistance: number;
	maxDistance: number;
	maxPolarAngle: number;
	update(): void;
	dispose(): void;
}

export interface ThreeModule {
	Scene: new () => ThreeObject3D & { background: ThreeColor | null };
	PerspectiveCamera: new (fov: number, aspect: number, near: number, far: number) => ThreeCamera;
	WebGLRenderer: new (parameters: {
		antialias?: boolean;
		alpha?: boolean;
		powerPreference?: string;
	}) => ThreeRenderer;
	BufferGeometry: new () => ThreeBufferGeometry;
	BufferAttribute: new (array: ArrayLike<number>, itemSize: number) => ThreeBufferAttribute;
	MeshStandardMaterial: new (parameters: Record<string, unknown>) => ThreeMaterial;
	LineBasicMaterial: new (parameters: Record<string, unknown>) => ThreeMaterial;
	Mesh: new (geometry: ThreeBufferGeometry, material: ThreeMaterial) => ThreeMesh;
	Line: new (geometry: ThreeBufferGeometry, material: ThreeMaterial) => ThreeMesh;
	Group: new () => ThreeObject3D;
	Color: new (value?: number | string) => ThreeColor;
	Vector3: new (x?: number, y?: number, z?: number) => ThreeVector3;
	AmbientLight: new (color: number, intensity: number) => ThreeObject3D;
	DirectionalLight: new (color: number, intensity: number) => ThreeObject3D;
	HemisphereLight: new (sky: number, ground: number, intensity: number) => ThreeObject3D;
	DoubleSide: number;
	FrontSide: number;
	PCFSoftShadowMap: number;
}

export interface OrbitControlsModule {
	OrbitControls: new (camera: ThreeCamera, element: HTMLElement) => ThreeControls;
}

export type { SectionCutLine, SiteSurfaces, SurfaceMesh };
