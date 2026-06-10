import type { VisualizationDef } from "../types";
import { buildShader, SHADER_PALETTES } from "../shader-utils";

const noopRender = () => { };

const ORGANIC_SHADERS: { name: string; body: string; tags: string[] }[] = [
    {
        name: "Cell Division",
        tags: ["organic", "cell", "biology"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.3;
    vec2 p = uv * 5.0;
    float minDist = 10.0;
    float secondDist = 10.0;
    vec2 minId = vec2(0.0);
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 neighbor = vec2(float(x), float(y));
            vec2 id = floor(p) + neighbor;
            vec2 r2 = vec2(hash(id), hash(id + 100.0));
            vec2 point = neighbor + sin(r2 * TAU + t + u_bass * 3.0) * 0.4 - fract(p);
            float d = length(point);
            if (d < minDist) { secondDist = minDist; minDist = d; minId = id; }
            else if (d < secondDist) { secondDist = d; }
        }
    }
    float edge = secondDist - minDist;
    float cell_v = smoothstep(0.0, 0.05, edge);
    float id_col = hash(minId);
    float pulse = sin(id_col * 20.0 + t * 2.0 + u_mid * 5.0) * 0.5 + 0.5;
    vec3 col = palette(id_col + t * 0.02) * cell_v * (0.5 + pulse * 0.5);
    col += palette(id_col + 0.5) * (1.0 - cell_v) * 0.8;
    col *= 1.0 + u_beat * 0.4;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Neural Network",
        tags: ["organic", "neural", "brain"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.3;
    vec3 col = vec3(0.0);
    // Nodes
    for (int i = 0; i < 12; i++) {
        float fi = float(i);
        vec2 pos = vec2(sin(fi * 2.1 + t * 0.3), cos(fi * 1.7 + t * 0.4)) * 0.5;
        pos += vec2(sin(t + fi), cos(t * 0.7 + fi)) * 0.1;
        float d = length(uv - pos);
        float glow = 0.008 / (d + 0.008);
        float pulse = sin(fi * 5.0 + t * 3.0 + u_bass * 10.0) * 0.5 + 0.5;
        col += palette(fi / 12.0 + t * 0.02) * glow * (0.3 + pulse * 0.7);
        // Connections
        for (int j = 0; j < 12; j++) {
            if (j <= i) continue;
            float fj = float(j);
            vec2 pos2 = vec2(sin(fj * 2.1 + t * 0.3), cos(fj * 1.7 + t * 0.4)) * 0.5;
            pos2 += vec2(sin(t + fj), cos(t * 0.7 + fj)) * 0.1;
            vec2 ba = pos2 - pos;
            float h = clamp(dot(uv - pos, ba) / dot(ba, ba), 0.0, 1.0);
            float dd = length(uv - pos - ba * h);
            float synapse = 0.001 / (dd + 0.001) * 0.1;
            float signal = sin(h * 20.0 - t * 5.0) * 0.5 + 0.5;
            col += palette(fi / 12.0) * synapse * signal * u_mid;
        }
    }
    col *= 1.0 + u_beat * 0.5;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Coral Reef",
        tags: ["organic", "coral", "underwater"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.2;
    vec2 p = uv * 3.0;
    float v = 0.0;
    for (int i = 0; i < 5; i++) {
        float fi = float(i);
        p += sin(p.yx * (1.5 + fi * 0.2) + t + fi) * 0.5;
        v += sin(length(p) + t) / (2.0 + fi);
    }
    v = abs(v);
    float branch = smoothstep(0.1, 0.0, abs(sin(p.x * 5.0 + v * 3.0)) * abs(sin(p.y * 5.0 + v * 3.0)) - 0.3);
    float f = freq(length(uv) * 0.3);
    vec3 col = palette(v * 0.5 + t * 0.03) * (v + branch * 0.5);
    col += palette(v + 0.3) * branch * f;
    col *= 0.8 + u_volume * 0.4 + u_beat * 0.4;
    gl_FragColor = vec4(col, 1.0);
`,
    },
];

export function createOrganicShaderVisualizations(): VisualizationDef[] {
    const results: VisualizationDef[] = [];
    for (const shader of ORGANIC_SHADERS) {
        for (const pal of SHADER_PALETTES) {
            results.push({
                id: `shader-organic-${shader.name.toLowerCase().replace(/\s+/g, "-")}-${pal.name.toLowerCase()}`,
                name: `${shader.name} (${pal.name})`,
                category: "Shader: Organic",
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
