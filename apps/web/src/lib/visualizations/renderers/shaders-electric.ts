import type { VisualizationDef } from "../types";
import { buildShader, SHADER_PALETTES } from "../shader-utils";

const noopRender = () => { };

const ELECTRIC_SHADERS: { name: string; body: string; tags: string[] }[] = [
    {
        name: "Lightning Web",
        tags: ["electric", "lightning", "web"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.5;
    float v = 0.0;
    for (int i = 0; i < 8; i++) {
        float fi = float(i);
        vec2 p = vec2(sin(fi * 1.3 + t), cos(fi * 1.7 + t * 0.7)) * 0.5;
        float d = length(uv - p);
        v += 0.01 / (d + 0.01);
    }
    v *= 0.05;
    float bolt = pow(v, 2.0 + u_bass * 3.0);
    float f = freq(v * 0.2);
    vec3 col = palette(v * 0.5 + t * 0.03) * bolt;
    col += palette(0.7) * pow(v, 5.0) * u_treble * 2.0;
    col *= 1.0 + u_beat * 0.8;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Tesla Coil",
        tags: ["electric", "tesla", "arc"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time;
    vec3 col = vec3(0.0);
    for (int i = 0; i < 6; i++) {
        float fi = float(i);
        float a = fi / 6.0 * TAU + t * 0.3;
        vec2 dir = vec2(cos(a), sin(a));
        float d = abs(dot(uv, dir.yx * vec2(1, -1)));
        float n = noise(vec2(dot(uv, dir) * 10.0, t * 5.0 + fi * 10.0));
        d += n * 0.03 * (1.0 + u_bass * 3.0);
        float line_v = 0.003 / (d + 0.003);
        col += palette(fi / 6.0 + t * 0.05) * line_v;
    }
    float glow = exp(-length(uv) * 4.0) * (u_volume + 0.3);
    col += palette(0.5) * glow * 2.0;
    col *= 1.0 + u_beat * 0.7;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Plasma Ball",
        tags: ["electric", "plasma", "ball"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float r = length(uv);
    float a = atan(uv.y, uv.x);
    float t = u_time;
    float shell = smoothstep(0.52, 0.48, r) - smoothstep(0.48, 0.44, r);
    vec3 col = palette(0.3) * shell * 0.3;
    for (int i = 0; i < 8; i++) {
        float fi = float(i);
        float target_a = fi / 8.0 * TAU + sin(t * 0.5 + fi) * 0.5;
        vec2 target = vec2(cos(target_a), sin(target_a)) * 0.45;
        vec2 d = uv - target * 0.1;
        float arc = 0.0;
        for (int j = 0; j < 4; j++) {
            float fj = float(j) / 4.0;
            vec2 mid = mix(vec2(0.0), target, fj);
            mid += vec2(noise(vec2(fi, t * 3.0 + fj * 5.0)) - 0.5, noise(vec2(fi + 50.0, t * 3.0 + fj * 5.0)) - 0.5) * 0.15 * (1.0 + u_bass);
            float dd = length(uv - mid);
            arc += 0.002 / (dd + 0.002);
        }
        col += palette(fi / 8.0 + t * 0.02) * arc * 0.15;
    }
    col *= 1.0 + u_beat * 0.6;
    gl_FragColor = vec4(col, 1.0);
`,
    },
];

export function createElectricShaderVisualizations(): VisualizationDef[] {
    const results: VisualizationDef[] = [];
    for (const shader of ELECTRIC_SHADERS) {
        for (const pal of SHADER_PALETTES) {
            results.push({
                id: `shader-electric-${shader.name.toLowerCase().replace(/\s+/g, "-")}-${pal.name.toLowerCase()}`,
                name: `${shader.name} (${pal.name})`,
                category: "Shader: Electric",
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
