import type { VisualizationDef } from "../types";
import { buildShader, SHADER_PALETTES } from "../shader-utils";

const noopRender = () => { };

const GLITCH_SHADERS: { name: string; body: string; tags: string[] }[] = [
    {
        name: "Digital Glitch",
        tags: ["glitch", "digital", "broken"],
        body: `
    vec2 uv = gl_FragCoord.xy / u_resolution;
    float t = u_time;
    // Horizontal shift
    float shift = step(0.9 - u_bass * 0.3, hash(vec2(floor(uv.y * 20.0), floor(t * 10.0))));
    uv.x += shift * (hash(vec2(floor(t * 15.0), floor(uv.y * 10.0))) - 0.5) * 0.2;
    // Block noise
    vec2 block = floor(uv * vec2(20.0, 10.0));
    float blockNoise = hash(block + floor(t * 5.0));
    float glitch = step(0.85 - u_treble * 0.2, blockNoise);
    // Base pattern
    float v = sin(uv.x * 30.0 + t * 2.0) * sin(uv.y * 30.0 - t * 3.0);
    v = v * 0.5 + 0.5;
    float f = freq(uv.x);
    vec3 col = palette(v + t * 0.03);
    // Apply glitch
    col = mix(col, palette(blockNoise), glitch);
    col += palette(hash(block)) * glitch * u_beat;
    col *= 1.0 + f * 0.5;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "CRT Scanlines",
        tags: ["glitch", "crt", "retro"],
        body: `
    vec2 uv = gl_FragCoord.xy / u_resolution;
    float t = u_time;
    // CRT warp
    vec2 cu = uv * 2.0 - 1.0;
    cu *= 1.0 + pow(length(cu), 2.0) * 0.1;
    cu = cu * 0.5 + 0.5;
    // Scanlines
    float scan = sin(cu.y * u_resolution.y * 1.5) * 0.1;
    float flicker = sin(t * 60.0) * 0.02;
    // Chromatic aberration
    float ca = 0.003 * (1.0 + u_bass * 3.0);
    float r = freq(cu.x - ca);
    float g = freq(cu.x);
    float b = freq(cu.x + ca);
    vec3 signal = palette(r * 0.3 + t * 0.02) * r + palette(g * 0.3 + 0.33) * g + palette(b * 0.3 + 0.66) * b;
    signal *= 0.4;
    // Noise
    float n = hash(vec2(cu.x, cu.y + t * 100.0)) * 0.1 * u_treble;
    vec3 col = signal + scan + flicker + n;
    col *= 1.0 + u_beat * 0.5;
    // Vignette
    float vig = smoothstep(1.0, 0.3, length(cu - 0.5) * 1.5);
    col *= vig;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Data Corruption",
        tags: ["glitch", "data", "corrupt"],
        body: `
    vec2 uv = gl_FragCoord.xy / u_resolution;
    float t = u_time;
    // Sorted pixel strips
    float stripY = floor(uv.y * 30.0);
    float stripPhase = hash(vec2(stripY, floor(t * 3.0)));
    float sort = step(0.7 - u_bass * 0.3, stripPhase);
    vec2 sorted_uv = uv;
    sorted_uv.x = mix(uv.x, fract(uv.x + stripPhase * 2.0 + t * 0.5), sort);
    // Color channel split
    float r = sin(sorted_uv.x * 40.0 + t) * 0.5 + 0.5;
    float g = sin(sorted_uv.x * 40.0 + t + 2.094) * 0.5 + 0.5;
    float b_v = sin(sorted_uv.x * 40.0 + t + 4.189) * 0.5 + 0.5;
    vec3 base = palette(r * 0.3 + g * 0.3 + t * 0.02);
    // Digital artifacts
    vec2 pixBlock = floor(uv * 50.0);
    float artifact = step(0.95 - u_treble * 0.1, hash(pixBlock + floor(t * 8.0)));
    vec3 col = mix(base * vec3(r, g, b_v), palette(hash(pixBlock) + t * 0.1), artifact);
    col *= 1.0 + u_beat * 0.8;
    gl_FragColor = vec4(col, 1.0);
`,
    },
];

export function createGlitchShaderVisualizations(): VisualizationDef[] {
    const results: VisualizationDef[] = [];
    for (const shader of GLITCH_SHADERS) {
        for (const pal of SHADER_PALETTES) {
            results.push({
                id: `shader-glitch-${shader.name.toLowerCase().replace(/\s+/g, "-")}-${pal.name.toLowerCase()}`,
                name: `${shader.name} (${pal.name})`,
                category: "Shader: Glitch",
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
