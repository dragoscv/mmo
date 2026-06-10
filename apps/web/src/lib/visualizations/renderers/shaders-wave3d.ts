import type { VisualizationDef } from "../types";
import { buildShader, SHADER_PALETTES } from "../shader-utils";

const noopRender = () => { };

const WAVE3D_SHADERS: { name: string; body: string; tags: string[] }[] = [
    {
        name: "Ocean Waves",
        tags: ["wave3d", "ocean", "water"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.3;
    vec2 p = uv * 3.0;
    // Simulated 3D perspective
    p.y = p.y * 2.0 - 1.0;
    float persp = 1.0 / (p.y + 2.0);
    p.x *= persp;
    float depth = persp;
    // Wave layers
    float wave = 0.0;
    for (int i = 0; i < 4; i++) {
        float fi = float(i);
        float freq_v = 3.0 + fi * 2.0;
        float speed = 1.0 + fi * 0.5;
        wave += sin(p.x * freq_v + t * speed + u_bass * 3.0 * sin(fi + t)) * 0.25 / (1.0 + fi * 0.3);
    }
    float surface = smoothstep(0.01, -0.01, uv.y - wave * 0.15 * depth);
    float foam = smoothstep(0.02, 0.0, abs(uv.y - wave * 0.15 * depth)) * depth;
    float f = freq(abs(uv.x) * 0.5);
    vec3 col = palette(wave + depth * 0.5 + t * 0.02) * surface * depth * 0.5;
    col += palette(0.9) * foam * 2.0;
    col += palette(0.3) * (1.0 - surface) * 0.1;
    col *= 1.0 + f * 0.5 + u_beat * 0.3;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Sound Terrain",
        tags: ["wave3d", "terrain", "landscape"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.3;
    vec3 col = vec3(0.0);
    // Raymarching simplified terrain
    float totalLines = 40.0;
    for (int i = 0; i < 40; i++) {
        float fi = float(i) / totalLines;
        float z = fi * 2.0;
        float y_offset = -0.3 + z * 0.5;
        float scale = 1.0 / (z + 0.5);
        float x = uv.x * scale;
        float height = 0.0;
        height += sin(x * 5.0 + t) * 0.1;
        height += sin(x * 10.0 - t * 1.5) * 0.05 * u_bass;
        float freqIdx = abs(x * scale * 0.1);
        if (freqIdx < 1.0) height += freq(freqIdx) * 0.15;
        float line_y = y_offset + height;
        float d = abs(uv.y - line_y) * scale;
        float line_v = 0.002 / (d + 0.002);
        col += palette(fi + height * 2.0 + t * 0.02) * line_v * (1.0 - fi * 0.5) * 0.15;
    }
    col *= 1.0 + u_beat * 0.5 + u_volume * 0.3;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Frequency Mountain",
        tags: ["wave3d", "frequency", "mountain"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.2;
    vec3 col = vec3(0.0);
    for (int i = 0; i < 30; i++) {
        float fi = float(i) / 30.0;
        float z = fi;
        float y_base = -0.4 + z * 0.8;
        float perspective = 1.0 / (z + 0.3);
        float x = uv.x * perspective * 0.5;
        float freqVal = freq(fi);
        float height = freqVal * 0.3 * (1.0 + u_bass * 0.5);
        height += sin(x * 8.0 + t + z * 5.0) * 0.03;
        float line_y = y_base + height;
        float d = uv.y - line_y;
        float fill = smoothstep(0.0, -0.01, d);
        float edge = smoothstep(0.005, 0.0, abs(d));
        vec3 lineCol = palette(fi + freqVal + t * 0.02);
        col = mix(col, lineCol * 0.3, fill * (1.0 - fi * 0.5));
        col += lineCol * edge * perspective * 0.5;
    }
    col *= 1.0 + u_beat * 0.4;
    gl_FragColor = vec4(col, 1.0);
`,
    },
];

export function createWave3DShaderVisualizations(): VisualizationDef[] {
    const results: VisualizationDef[] = [];
    for (const shader of WAVE3D_SHADERS) {
        for (const pal of SHADER_PALETTES) {
            results.push({
                id: `shader-wave3d-${shader.name.toLowerCase().replace(/\s+/g, "-")}-${pal.name.toLowerCase()}`,
                name: `${shader.name} (${pal.name})`,
                category: "Shader: 3D Waves",
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
