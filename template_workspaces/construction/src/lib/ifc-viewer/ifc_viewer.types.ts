export type IFCViewerMarkerGroup = {
	label: string;
	color: string;
	expressIds: number[];
};

export type IFCViewerProps = {
	src: string;
	alt?: string;
	markers?: number[];
	markerGroups?: IFCViewerMarkerGroup[];
};

export interface ViewerColor {
	setStyle(style: string): this;
}

export interface ViewerColorConstructor {
	new (style?: string): ViewerColor;
}

export interface ViewerSceneObject {
	readonly viewerSceneObject: unique symbol;
}

export interface ViewerCameraObject {
	readonly viewerCameraObject: unique symbol;
}

export interface ViewerSimpleScene {
	setup(): void;
	three: {
		background: ViewerColor | null;
		add(object: ViewerSceneObject): void;
		remove(object: ViewerSceneObject): void;
	};
}

export interface ViewerSimpleCamera {
	enabled: boolean;
	three: ViewerCameraObject;
}

export interface ViewerSimpleRenderer {}

export interface ViewerWorld {
	scene: ViewerSimpleScene;
	camera: ViewerSimpleCamera;
	renderer: ViewerSimpleRenderer;
}

export interface ViewerWorlds {
	create(): ViewerWorld;
}

export interface ViewerGrids {
	create(world: ViewerWorld): void;
}

export interface ViewerRaycasters {
	get(world: ViewerWorld): object;
}

export interface ViewerItemDataValue {
	value?: string | number;
}

export interface ViewerItemData {
	[key: string]: ViewerItemDataValue | ViewerItemDataValue[] | undefined;
}

export interface ViewerFragmentsModel {
	modelId: string;
	object: ViewerSceneObject;
	getItemsData(ids: number[]): Promise<Array<ViewerItemData | null | undefined>>;
}

export interface ViewerFragmentsManager {
	init(worker: Worker): void;
	core: {
		load(
			bytes: Uint8Array,
			options: { modelId: string; camera: ViewerCameraObject }
		): Promise<ViewerFragmentsModel>;
		disposeModel(modelId: string): Promise<void>;
	};
	list: Map<string, ViewerFragmentsModel>;
}

export interface ViewerHighlightStyle {
	color: ViewerColor;
	opacity: number;
	transparent: boolean;
	renderedFaces: number;
}

export interface ViewerHighlighter {
	setup(options: {
		world: ViewerWorld;
		autoHighlightOnClick: boolean;
		selectionColor: ViewerColor;
	}): void;
	multiple: 'none';
	zoomToSelection: boolean;
	styles: Map<string, ViewerHighlightStyle>;
	selection: { select: Record<string, Set<number>> };
	clear(styleId: string): Promise<void>;
	highlight(styleId: string, removePrevious: boolean, zoomToSelection: boolean): Promise<void>;
	highlightByID(
		styleId: string,
		fragmentIdMap: Record<string, Set<number>>,
		removePrevious: boolean,
		zoomToSelection: boolean
	): Promise<void>;
}

export interface ViewerComponentToken<T> {
	readonly componentType?: T;
}

export interface ViewerComponents {
	get<T>(token: ViewerComponentToken<T>): T;
	init(): void;
	dispose(): void;
}

export interface ViewerComponentsModule {
	Components: new () => ViewerComponents;
	Worlds: ViewerComponentToken<ViewerWorlds>;
	SimpleScene: new (components: ViewerComponents) => ViewerSimpleScene;
	SimpleRenderer: new (
		components: ViewerComponents,
		container: HTMLDivElement
	) => ViewerSimpleRenderer;
	SimpleCamera: new (components: ViewerComponents) => ViewerSimpleCamera;
	Grids: ViewerComponentToken<ViewerGrids>;
	FragmentsManager: ViewerComponentToken<ViewerFragmentsManager> & {
		getWorker(): Promise<Worker>;
	};
	Raycasters: ViewerComponentToken<ViewerRaycasters>;
}

export interface ViewerFrontendModule {
	Highlighter: ViewerComponentToken<ViewerHighlighter>;
}

export interface ViewerFragmentsModule {
	RenderedFaces: { TWO: number };
	IfcImporter: new () => ViewerIfcImporter;
}

export interface ViewerThreeModule {
	Color: ViewerColorConstructor;
}

export type ViewerLocateFileHandler = (path: string, prefix: string) => string;

export interface ViewerIfcApi {
	Init(
		customLocateFileHandler?: ViewerLocateFileHandler,
		forceSingleThread?: boolean
	): Promise<void>;
}

export interface ViewerIfcApiConstructor {
	new (): ViewerIfcApi;
	prototype: ViewerIfcApi;
}

export interface ViewerIfcImporter {
	wasm: { path: string; absolute: boolean };
	process(input: { bytes: Uint8Array }): Promise<Uint8Array>;
}
