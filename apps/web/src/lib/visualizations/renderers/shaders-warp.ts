import type { VisualizationDef } from "../types";
import { buildShader, SHADER_PALETTES } from "../shader-utils";

const noopRender = () => { };

const WARP_SHADERS: { name: string; body: string; tags: string[] }[] = [
    {
        name: "Space Warp",
        tags: ["warp", "space", "distortion"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.4;
    vec2 p = uv;
    float dist = 0.0;
    for (int i = 0; i < 5; i++) {
        p = sin(p * 2.5 + t) * 0.7 + uv;
        dist += length(p - uv);
    }
    dist *= 0.2;
    float f = freq(dist * 0.2);
    float pulse = 1.0 + u_bass * sin(dist * 10.0 - t * 3.0) * 0.5;
    vec3 col = palette(dist * 0.4 + t * 0.02) * dist * pulse;
    col += palette(dist + 0.5) * f * 0.5;
    col *= 1.0 + u_beat * 0.5;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Dimension Rift",
        tags: ["warp", "dimension", "rift"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.3;
    vec2 p = uv * 3.0;
    float v = 0.0;
    for (int i = 0; i < 8; i++) {
        p = abs(p) / dot(p, p) - vec2(0.8 + sin(t * 0.1) * 0.2, 0.8 + cos(t * 0.1) * 0.2);
        v += exp(-length(p) * 0.5);
    }
    v *= 0.125;
    float f = freq(v * 0.3);
    vec3 col = palette(v + t * 0.02) * v * (1.0 + u_bass * 0.5);
    col += palette(v + 0.3) * f * 0.5 * u_mid;
    col *= 1.0 + u_beat * 0.6;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Sine Warp",
        tags: ["warp", "sine", "wave"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.5;
    vec2 p = uv * 4.0;
    p.x += sin(p.y * 3.0 + t) * (0.5 + u_bass);
    p.y += cos(p.x * 3.0 + t * 0.7) * (0.5 + u_mid);
    float v = sin(p.x) * cos(p.y);
    v = abs(v);
    float grid = smoothstep(0.02, 0.0, abs(sin(p.x * 5.0)) * abs(sin(p.y * 5.0)) - 0.5);
    float f = freq(length(uv) * 0.4);
    vec3 col = palette(v + length(uv) + t * 0.03) * (v + grid * 0.3);
    col *= 1.0 + f * 0.8 + u_beat * 0.5;
    gl_FragColor = vec4(col, 1.0);
`,
    },
];

export function createWarpShaderVisualizations(): VisualizationDef[] {
    const results: VisualizationDef[] = [];
    for (const shader of WARP_SHADERS) {
        for (const pal of SHADER_PALETTES) {
            results.push({
                id: `shader-warp-${shader.name.toLowerCase().replace(/\s+/g, "-")}-${pal.name.toLowerCase()}`,
                name: `${shader.name} (${pal.name})`,
                category: "Shader: Warp",
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
