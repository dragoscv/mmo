import type { VisualizationDef } from "../types";
import { buildShader, SHADER_PALETTES } from "../shader-utils";

const noopRender = () => { };

const CRYSTAL_SHADERS: { name: string; body: string; tags: string[] }[] = [
    {
        name: "Crystal Lattice",
        tags: ["crystal", "lattice", "geometric"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.3;
    vec2 p = uv * 6.0;
    p *= rot2(t * 0.1);
    vec2 id = floor(p);
    vec2 f2 = fract(p) - 0.5;
    // Diamond shape
    float d = abs(f2.x) + abs(f2.y);
    float facet = smoothstep(0.5, 0.48, d);
    float edge = smoothstep(0.48, 0.46, d) - smoothstep(0.46, 0.44, d);
    float refraction = sin(id.x * 3.0 + id.y * 5.0 + t + u_bass * 10.0) * 0.5 + 0.5;
    float f = freq(d * 0.3);
    vec3 col = palette(refraction + hash(id) * 0.5 + t * 0.02) * facet * (0.5 + refraction * 0.5);
    col += palette(hash(id) + 0.3) * edge * 2.0;
    col += palette(0.7) * f * facet * u_treble * 0.5;
    col *= 1.0 + u_beat * 0.5;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Prism Refract",
        tags: ["crystal", "prism", "rainbow"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.2;
    float r = length(uv);
    float a = atan(uv.y, uv.x);
    float prism = abs(sin(a * 3.0 + t));
    float refract = sin(a * 6.0 + r * 10.0 - t * 3.0 + u_bass * 5.0);
    float caustic = pow(abs(refract), 3.0) * exp(-r * 2.0);
    float dispersion = a / TAU + r * 0.5 + t * 0.05;
    float f = freq(r * 0.3);
    vec3 col = palette(dispersion) * caustic * 2.0;
    col += palette(dispersion + 0.33) * prism * exp(-r * 3.0) * 0.5;
    col *= 1.0 + f * 1.0 + u_volume * 0.3;
    col *= 1.0 + u_beat * 0.4;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Geode",
        tags: ["crystal", "geode", "mineral"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.15;
    float r = length(uv);
    float a = atan(uv.y, uv.x);
    // Layers
    float layer = 0.0;
    for (int i = 0; i < 6; i++) {
        float fi = float(i) * 0.1;
        float radius = 0.1 + fi + noise(vec2(a * 3.0, fi + t)) * 0.05;
        layer += smoothstep(radius + 0.01, radius - 0.01, r) * 0.15;
    }
    float crystal_f = pow(abs(sin(a * 12.0 + r * 20.0 + t + u_bass * 5.0)), 4.0);
    crystal_f *= smoothstep(0.6, 0.2, r);
    float f = freq(a / TAU * 0.5 + 0.25);
    vec3 col = palette(layer + r * 2.0 + t * 0.02) * (layer + crystal_f * 0.5);
    col += palette(0.8) * crystal_f * u_treble;
    col *= 1.0 + f * 0.5 + u_beat * 0.5;
    gl_FragColor = vec4(col, 1.0);
`,
    },
];

export function createCrystalShaderVisualizations(): VisualizationDef[] {
    const results: VisualizationDef[] = [];
    for (const shader of CRYSTAL_SHADERS) {
        for (const pal of SHADER_PALETTES) {
            results.push({
                id: `shader-crystal-${shader.name.toLowerCase().replace(/\s+/g, "-")}-${pal.name.toLowerCase()}`,
                name: `${shader.name} (${pal.name})`,
                category: "Shader: Crystal",
                tags: [...shader.tags, "shader", "webgl", pal.name.toLowerCase()],
                render: noopRender,
                shader: {
                    fragment: buildShader(shader.body),
                    palette: pal.colors,
                },
            });
        }
    }
    return results;
}
