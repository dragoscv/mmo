import type { VisualizationDef } from "../types";
import { buildShader, SHADER_PALETTES } from "../shader-utils";

const noopRender = () => { };

const TUNNEL_SHADERS: { name: string; body: string; tags: string[] }[] = [
    {
        name: "Warp Tunnel",
        tags: ["tunnel", "warp", "zoom"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float a = atan(uv.y, uv.x);
    float r = length(uv);
    float t = u_time * 0.5 + u_bass * 2.0;
    float tunnel = 0.5 / r + t;
    float stripes = sin(a * 6.0 + tunnel * 8.0) * 0.5 + 0.5;
    float f = freq(r * 0.5);
    vec3 col = palette(tunnel * 0.1 + stripes * 0.3 + f * 0.5);
    col *= smoothstep(0.0, 0.3, r) * (1.0 + u_beat * 0.5);
    col *= 1.0 + f * 0.8;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Hyperspace",
        tags: ["tunnel", "hyperspace", "speed"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float a = atan(uv.y, uv.x);
    float r = length(uv);
    float speed = u_time * (1.0 + u_bass * 3.0);
    float rays = abs(sin(a * 12.0 + speed * 0.5));
    float depth = fract(1.0 / r - speed * 0.3);
    float glow = pow(depth, 3.0) * rays;
    vec3 col = palette(a / TAU + u_time * 0.05) * glow * 2.0;
    col += palette(depth) * pow(1.0 - r, 2.0) * u_volume * 2.0;
    col *= 1.0 + u_beat * 0.8;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Vortex Tube",
        tags: ["tunnel", "vortex", "spiral"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float a = atan(uv.y, uv.x);
    float r = length(uv);
    float twist = a + u_time + u_mid * sin(r * 10.0 - u_time * 2.0);
    float rings = sin(1.0 / r * 5.0 - u_time * 2.0) * 0.5 + 0.5;
    float spiral = sin(twist * 4.0 + 1.0 / r * 8.0) * 0.5 + 0.5;
    float f = freq(abs(a) / PI);
    vec3 col = palette(rings * 0.5 + spiral * 0.3) * (rings + spiral * 0.5);
    col *= smoothstep(0.0, 0.2, r) * (1.0 + f * 1.5);
    col *= 1.0 + u_beat * 0.6;
    gl_FragColor = vec4(col, 1.0);
`,
    },
];

export function createTunnelShaderVisualizations(): VisualizationDef[] {
    const results: VisualizationDef[] = [];
    for (const shader of TUNNEL_SHADERS) {
        for (const pal of SHADER_PALETTES) {
            results.push({
                id: `shader-tunnel-${shader.name.toLowerCase().replace(/\s+/g, "-")}-${pal.name.toLowerCase()}`,
                name: `${shader.name} (${pal.name})`,
                category: "Shader: Tunnel",
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
