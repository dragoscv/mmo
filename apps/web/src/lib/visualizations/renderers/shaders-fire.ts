import type { VisualizationDef } from "../types";
import { buildShader, SHADER_PALETTES } from "../shader-utils";

const noopRender = () => { };

const FIRE_SHADERS: { name: string; body: string; tags: string[] }[] = [
    {
        name: "Inferno",
        tags: ["fire", "inferno", "hot"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    uv.y += 0.3;
    float t = u_time * 0.5;
    vec2 p = uv * vec2(3.0, 2.0);
    float n = fbm(p + vec2(0.0, -t * 2.0));
    n += fbm(p * 2.0 + vec2(0.0, -t * 3.0)) * 0.5;
    float shape = smoothstep(0.5 + u_bass * 0.3, -0.5, uv.y);
    shape *= smoothstep(0.8, 0.0, abs(uv.x));
    float fire = n * shape;
    fire = pow(fire, 1.5);
    float f = freq(abs(uv.x) * 0.5);
    vec3 col = palette(fire * 0.8 + 0.1) * fire * 2.5;
    col += palette(0.0) * exp(-length(uv + vec2(0.0, 0.2)) * 3.0) * u_volume;
    col *= 1.0 + u_beat * 0.6 + f * 0.5;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Solar Flare",
        tags: ["fire", "solar", "flare"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float r = length(uv);
    float a = atan(uv.y, uv.x);
    float t = u_time * 0.3;
    float surface = 0.3 + noise(vec2(a * 3.0, t)) * 0.05 * (1.0 + u_bass * 2.0);
    float corona = 0.0;
    for (int i = 0; i < 5; i++) {
        float fi = float(i);
        float flare_a = fi * TAU / 5.0 + t * 0.2;
        float flare_w = 0.1 + sin(t + fi) * 0.05;
        float d = abs(mod(a - flare_a + PI, TAU) - PI);
        corona += exp(-d / flare_w) * exp(-(r - surface) * (3.0 - u_mid * 2.0)) * 0.5;
    }
    float sun = smoothstep(surface + 0.01, surface - 0.01, r);
    float glow = exp(-(r - surface) * 5.0) * 0.5;
    vec3 col = palette(0.2) * sun;
    col += palette(r * 0.5 + corona * 0.3) * (corona + glow);
    col *= 1.0 + u_beat * 0.5;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Ember Particles",
        tags: ["fire", "ember", "particles"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time;
    vec3 col = vec3(0.0);
    for (int i = 0; i < 20; i++) {
        float fi = float(i);
        float seed = hash(vec2(fi, 0.0));
        float speed = 0.3 + seed * 0.5;
        float x = sin(seed * TAU + t * (0.2 + seed * 0.3)) * 0.6;
        float y = fract(seed - t * speed * 0.3) * 2.0 - 1.0;
        vec2 pos = vec2(x, y);
        float d = length(uv - pos);
        float bright = exp(-d * (20.0 - u_bass * 10.0));
        float flicker = 0.5 + 0.5 * sin(t * 10.0 + fi * 7.0);
        col += palette(seed + t * 0.05) * bright * flicker;
    }
    float f = freq(length(uv) * 0.3);
    col *= 1.0 + f * 0.5 + u_beat * 0.6;
    gl_FragColor = vec4(col, 1.0);
`,
    },
];

export function createFireShaderVisualizations(): VisualizationDef[] {
    const results: VisualizationDef[] = [];
    for (const shader of FIRE_SHADERS) {
        for (const pal of SHADER_PALETTES) {
            results.push({
                id: `shader-fire-${shader.name.toLowerCase().replace(/\s+/g, "-")}-${pal.name.toLowerCase()}`,
                name: `${shader.name} (${pal.name})`,
                category: "Shader: Fire",
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
