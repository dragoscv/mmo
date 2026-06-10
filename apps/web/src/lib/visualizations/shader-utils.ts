// Common GLSL header injected before every fragment shader.
// Provides uniform declarations and helper functions.

export const SHADER_HEADER = `
precision mediump float;

uniform float u_time;
uniform vec2  u_resolution;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;
uniform float u_volume;
uniform float u_beat;
uniform float u_beatAcc;
uniform vec2  u_mouse;
uniform float u_sensitivity;
uniform sampler2D u_frequency;

// Up to 6 palette colors
uniform vec3 u_color0;
uniform vec3 u_color1;
uniform vec3 u_color2;
uniform vec3 u_color3;
uniform vec3 u_color4;
uniform vec3 u_color5;
uniform int  u_colorCount;

// Helpers
#define PI 3.14159265359
#define TAU 6.28318530718

vec3 palette(float t) {
    vec3 colors[5];
    colors[0] = u_color0;
    colors[1] = u_color1;
    colors[2] = u_color2;
    colors[3] = u_color3;
    colors[4] = u_color4;
    t = fract(t) * 4.0;
    int i = int(floor(t));
    float f = fract(t);
    if (i == 0) return mix(colors[0], colors[1], f);
    if (i == 1) return mix(colors[1], colors[2], f);
    if (i == 2) return mix(colors[2], colors[3], f);
    return mix(colors[3], colors[4], f);
}

float freq(float x) {
    return texture2D(u_frequency, vec2(x, 0.5)).r;
}

mat2 rot2(float a) {
    float c = cos(a), s = sin(a);
    return mat2(c, -s, s, c);
}

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(hash(i), hash(i + vec2(1,0)), f.x),
        mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x),
        f.y
    );
}

float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) {
        v += a * noise(p);
        p *= 2.0;
        a *= 0.5;
    }
    return v;
}
`;

// Hex color to vec3 (0-1) tuple
export function hexToVec3(hex: string): [number, number, number] {
    const h = hex.replace("#", "");
    return [
        parseInt(h.substring(0, 2), 16) / 255,
        parseInt(h.substring(2, 4), 16) / 255,
        parseInt(h.substring(4, 6), 16) / 255,
    ];
}

export interface ShaderPalette {
    name: string;
    colors: [number, number, number][];
}

export const SHADER_PALETTES: ShaderPalette[] = [
    { name: "Neon", colors: ["#ff00ff", "#00ffff", "#ff0080", "#80ff00", "#0080ff"].map(hexToVec3) as [number, number, number][] },
    { name: "Fire", colors: ["#ff4500", "#ff6a00", "#ff9500", "#ffcc00", "#ffe066"].map(hexToVec3) as [number, number, number][] },
    { name: "Ocean", colors: ["#006994", "#0099cc", "#00bfff", "#40e0d0", "#7fffd4"].map(hexToVec3) as [number, number, number][] },
    { name: "Sunset", colors: ["#ff6b6b", "#ffa07a", "#ffd700", "#ff8c69", "#ff4500"].map(hexToVec3) as [number, number, number][] },
    { name: "Cyberpunk", colors: ["#f72585", "#b5179e", "#7209b7", "#560bad", "#3a0ca3"].map(hexToVec3) as [number, number, number][] },
    { name: "Aurora", colors: ["#00ff87", "#60efff", "#ff00ff", "#7b2ff7", "#00ffc8"].map(hexToVec3) as [number, number, number][] },
    { name: "Lava", colors: ["#ff0000", "#ff4500", "#ff6600", "#cc3300", "#990000"].map(hexToVec3) as [number, number, number][] },
];

// Wrap fragment main with header
export function buildShader(mainBody: string): string {
    return SHADER_HEADER + "\nvoid main() {\n" + mainBody + "\n}\n";
}
