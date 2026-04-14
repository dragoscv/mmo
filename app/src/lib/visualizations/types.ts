export interface AudioData {
    frequency: Uint8Array;
    timeDomain: Uint8Array;
    bass: number;       // 0-1 normalized energy in bass range
    mid: number;        // 0-1 normalized energy in mid range
    treble: number;     // 0-1 normalized energy in treble range
    volume: number;     // 0-1 overall volume
    beat: boolean;      // true on detected beat
    beatIntensity: number; // 0-1 how strong the beat is
}

export interface RenderConfig {
    width: number;
    height: number;
    time: number;           // elapsed time in seconds
    deltaTime: number;      // time since last frame
    mouse: { x: number; y: number; active: boolean };
    palette: string[];
    sensitivity: number;    // 0.5-2.0 multiplier
    quality: "low" | "medium" | "high";
}

export type VisualizationRenderer = (
    ctx: CanvasRenderingContext2D,
    data: AudioData,
    config: RenderConfig,
) => void;

export interface VisualizationDef {
    id: string;
    name: string;
    category: string;
    tags: string[];
    render: VisualizationRenderer;
    interactive?: boolean;
}

export type PaletteName =
    | "neon"
    | "fire"
    | "ocean"
    | "sunset"
    | "matrix"
    | "arctic"
    | "candy"
    | "midnight"
    | "forest"
    | "lava"
    | "electric"
    | "pastel"
    | "retrowave"
    | "aurora"
    | "copper"
    | "cyberpunk"
    | "gold"
    | "monochrome"
    | "rainbow"
    | "vapor";
