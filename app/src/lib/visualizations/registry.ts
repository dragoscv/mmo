import type { VisualizationDef } from "./types";
import { createBarVisualizations } from "./renderers/bars";
import { createWaveVisualizations } from "./renderers/waves";
import { createCircularVisualizations } from "./renderers/circular";
import { createParticleVisualizations } from "./renderers/particles";
import { createGeometricVisualizations } from "./renderers/geometric";
import { createSpectrumVisualizations } from "./renderers/spectrum";
import { createTerrainVisualizations } from "./renderers/terrain";
import { createDigitalVisualizations } from "./renderers/digital";
import { createNatureVisualizations } from "./renderers/nature";
import { createAbstractVisualizations } from "./renderers/abstract";
import { createLineVisualizations } from "./renderers/lines";
// Shader visualizations
import { createTunnelShaderVisualizations } from "./renderers/shaders-tunnel";
import { createFractalShaderVisualizations } from "./renderers/shaders-fractal";
import { createPlasmaShaderVisualizations } from "./renderers/shaders-plasma";
import { createKaleidoscopeShaderVisualizations } from "./renderers/shaders-kaleidoscope";
import { createNebulaShaderVisualizations } from "./renderers/shaders-nebula";
import { createFluidShaderVisualizations } from "./renderers/shaders-fluid";
import { createGridShaderVisualizations } from "./renderers/shaders-grid";
import { createVortexShaderVisualizations } from "./renderers/shaders-vortex";
import { createFireShaderVisualizations } from "./renderers/shaders-fire";
import { createElectricShaderVisualizations } from "./renderers/shaders-electric";
import { createOrganicShaderVisualizations } from "./renderers/shaders-organic";
import { createGlitchShaderVisualizations } from "./renderers/shaders-glitch";
import { createCosmicShaderVisualizations } from "./renderers/shaders-cosmic";
import { createWarpShaderVisualizations } from "./renderers/shaders-warp";
import { createCrystalShaderVisualizations } from "./renderers/shaders-crystal";
import { createWave3DShaderVisualizations } from "./renderers/shaders-wave3d";

// Build the complete visualization registry
const ALL_VISUALIZATIONS: VisualizationDef[] = [
    // Canvas 2D (~240)
    ...createBarVisualizations(),       // 30
    ...createWaveVisualizations(),      // 25
    ...createCircularVisualizations(),  // 25
    ...createParticleVisualizations(),  // 25
    ...createGeometricVisualizations(), // 20
    ...createSpectrumVisualizations(),  // 15
    ...createTerrainVisualizations(),   // 15
    ...createDigitalVisualizations(),   // 15
    ...createNatureVisualizations(),    // 20
    ...createAbstractVisualizations(),  // 25
    ...createLineVisualizations(),      // 25
    // WebGL Shaders (15 categories × 3 shaders × 7 palettes = 315)
    ...createTunnelShaderVisualizations(),
    ...createFractalShaderVisualizations(),
    ...createPlasmaShaderVisualizations(),
    ...createKaleidoscopeShaderVisualizations(),
    ...createNebulaShaderVisualizations(),
    ...createFluidShaderVisualizations(),
    ...createGridShaderVisualizations(),
    ...createVortexShaderVisualizations(),
    ...createFireShaderVisualizations(),
    ...createElectricShaderVisualizations(),
    ...createOrganicShaderVisualizations(),
    ...createGlitchShaderVisualizations(),
    ...createCosmicShaderVisualizations(),
    ...createWarpShaderVisualizations(),
    ...createCrystalShaderVisualizations(),
    ...createWave3DShaderVisualizations(),
];

// Index by ID for fast lookup
const vizById = new Map<string, VisualizationDef>();
for (const viz of ALL_VISUALIZATIONS) {
    vizById.set(viz.id, viz);
}

// Get all categories
const CATEGORIES = [...new Set(ALL_VISUALIZATIONS.map(v => v.category))].sort();

export function getAllVisualizations(): VisualizationDef[] {
    return ALL_VISUALIZATIONS;
}

export function getVisualizationById(id: string): VisualizationDef | undefined {
    return vizById.get(id);
}

export function getCategories(): string[] {
    return CATEGORIES;
}

export function getVisualizationsByCategory(category: string): VisualizationDef[] {
    return ALL_VISUALIZATIONS.filter(v => v.category === category);
}

export function searchVisualizations(query: string): VisualizationDef[] {
    const q = query.toLowerCase();
    return ALL_VISUALIZATIONS.filter(v =>
        v.name.toLowerCase().includes(q)
        || v.category.toLowerCase().includes(q)
        || v.tags.some(t => t.includes(q))
    );
}

export function getRandomVisualization(exclude?: string): VisualizationDef {
    const pool = exclude
        ? ALL_VISUALIZATIONS.filter(v => v.id !== exclude)
        : ALL_VISUALIZATIONS;
    return pool[Math.floor(Math.random() * pool.length)];
}

export function getVisualizationCount(): number {
    return ALL_VISUALIZATIONS.length;
}

// Visualization favorites & playlists (localStorage)
const STORAGE_KEY = "viz-settings";

export interface VizPlaylist {
    id: string;
    name: string;
    vizIds: string[];
}

export interface VizSettings {
    favorites: string[];
    playlists: VizPlaylist[];
    lastVizId: string | null;
    sensitivity: number;
    quality: "low" | "medium" | "high";
    autoAdvance: boolean;
    advanceInterval: number; // seconds
    showStats: boolean;
}

const DEFAULT_SETTINGS: VizSettings = {
    favorites: [],
    playlists: [],
    lastVizId: null,
    sensitivity: 1,
    quality: "medium",
    autoAdvance: false,
    advanceInterval: 30,
    showStats: false,
};

export function loadVizSettings(): VizSettings {
    if (typeof window === "undefined") return DEFAULT_SETTINGS;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return DEFAULT_SETTINGS;
        return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
        return DEFAULT_SETTINGS;
    }
}

export function saveVizSettings(settings: VizSettings): void {
    if (typeof window === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
