import type { VisualizationDef } from "../types";
import { buildShader, SHADER_PALETTES } from "../shader-utils";

const noopRender = () => { };

const KALEIDOSCOPE_SHADERS: { name: string; body: string; tags: string[] }[] = [
    {
        name: "Crystal Kaleidoscope",
        tags: ["kaleidoscope", "crystal", "symmetry"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float a = atan(uv.y, uv.x);
    float r = length(uv);
    float segments = 8.0;
    a = mod(a, TAU / segments);
    a = abs(a - PI / segments);
    vec2 p = vec2(cos(a), sin(a)) * r;
    float t = u_time * 0.3;
    float v = sin(p.x * 12.0 + t) * cos(p.y * 12.0 - t);
    v += sin(r * 8.0 - t * 2.0) * u_bass;
    float f = freq(r * 0.5);
    vec3 col = palette(v + f * 0.5 + u_time * 0.03);
    col *= 0.8 + u_volume * 0.5 + u_beat * 0.4;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Fractal Mirror",
        tags: ["kaleidoscope", "fractal", "mirror"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float a = atan(uv.y, uv.x);
    float r = length(uv);
    float seg = 6.0 + floor(u_bass * 4.0);
    a = mod(a + u_time * 0.1, TAU / seg);
    a = abs(a - PI / seg);
    vec2 p = vec2(cos(a), sin(a)) * r;
    p *= 3.0;
    float v = fbm(p + u_time * 0.2);
    v += fbm(p * 2.0 - u_time * 0.3) * u_mid;
    vec3 col = palette(v + r * 0.5);
    col *= 1.0 + u_beat * 0.7;
    col *= smoothstep(1.5, 0.0, r);
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Stained Glass",
        tags: ["kaleidoscope", "stained", "glass"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float a = atan(uv.y, uv.x);
    float r = length(uv);
    float seg = 10.0;
    a = mod(a, TAU / seg);
    a = abs(a - PI / seg);
    vec2 p = vec2(cos(a), sin(a)) * r * 5.0;
    vec2 id = floor(p);
    vec2 f2 = fract(p) - 0.5;
    float d = length(f2);
    float cell = hash(id);
    float pulse = sin(cell * 10.0 + u_time + u_bass * 5.0) * 0.5 + 0.5;
    float edge = smoothstep(0.45, 0.4, d);
    vec3 col = palette(cell + u_time * 0.02) * pulse * edge;
    col += palette(cell + 0.5) * (1.0 - edge) * 0.1;
    col *= 1.0 + u_beat * 0.5;
    gl_FragColor = vec4(col, 1.0);
`,
    },
];

export function createKaleidoscopeShaderVisualizations(): VisualizationDef[] {
    const results: VisualizationDef[] = [];
    for (const shader of KALEIDOSCOPE_SHADERS) {
        for (const pal of SHADER_PALETTES) {
            results.push({
                id: `shader-kaleidoscope-${shader.name.toLowerCase().replace(/\s+/g, "-")}-${pal.name.toLowerCase()}`,
                name: `${shader.name} (${pal.name})`,
                category: "Shader: Kaleidoscope",
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
