import type { VisualizationDef } from "../types";
import { buildShader, SHADER_PALETTES } from "../shader-utils";

const noopRender = () => { };

const GRID_SHADERS: { name: string; body: string; tags: string[] }[] = [
    {
        name: "Neon Grid",
        tags: ["grid", "neon", "retro"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.5;
    vec2 p = uv * 8.0;
    p.y -= t * 2.0;
    vec2 g = abs(fract(p) - 0.5);
    float grid = min(g.x, g.y);
    float line = smoothstep(0.02, 0.0, grid);
    float perspective = exp(-abs(uv.y) * 2.0);
    float pulse = sin(floor(p.y) * 0.5 + t * 3.0) * 0.5 + 0.5;
    float f = freq(abs(uv.x) * 0.5);
    vec3 col = palette(floor(p.x + p.y) * 0.1 + t * 0.1) * line * perspective;
    col *= 1.0 + pulse * u_bass + f * 1.5;
    col += palette(0.5) * exp(-length(uv) * 3.0) * u_volume;
    col *= 1.0 + u_beat * 0.5;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Digital Rain",
        tags: ["grid", "digital", "matrix"],
        body: `
    vec2 uv = gl_FragCoord.xy / u_resolution;
    float t = u_time;
    float cols = 40.0;
    float col_id = floor(uv.x * cols);
    float speed = hash(vec2(col_id, 0.0)) * 2.0 + 1.0;
    float y = fract(uv.y + t * speed * 0.3);
    float brightness = pow(y, 3.0 + u_bass * 5.0);
    float flicker = step(hash(vec2(col_id, floor(t * 10.0))), 0.7 + u_treble * 0.3);
    float f = freq(uv.x);
    vec3 col = palette(col_id / cols + t * 0.01) * brightness * flicker;
    col *= 1.0 + f * 2.0 + u_beat * 0.5;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Hex Grid",
        tags: ["grid", "hexagon", "pattern"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.3;
    vec2 p = uv * 6.0;
    p.x *= 1.1547;
    vec2 a = mod(p, 2.0) - 1.0;
    vec2 b = mod(p + 1.0, 2.0) - 1.0;
    float ha = dot(a, a);
    float hb = dot(b, b);
    float hex = min(ha, hb);
    float edge = smoothstep(0.9, 0.85, hex);
    float id = hash(floor(p));
    float pulse = sin(id * 20.0 + t * 3.0 + u_bass * 10.0) * 0.5 + 0.5;
    float f = freq(hex * 0.3);
    vec3 col = palette(id + t * 0.05) * pulse * edge;
    col += palette(id + 0.3) * (1.0 - edge) * f * 0.5;
    col *= 1.0 + u_beat * 0.6;
    gl_FragColor = vec4(col, 1.0);
`,
    },
];

export function createGridShaderVisualizations(): VisualizationDef[] {
    const results: VisualizationDef[] = [];
    for (const shader of GRID_SHADERS) {
        for (const pal of SHADER_PALETTES) {
            results.push({
                id: `shader-grid-${shader.name.toLowerCase().replace(/\s+/g, "-")}-${pal.name.toLowerCase()}`,
                name: `${shader.name} (${pal.name})`,
                category: "Shader: Grid",
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
