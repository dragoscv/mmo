// Synthesiser for the sonic signature: brand/src/sonic.mjs -> 16-bit stereo PCM WAV. No dependency.
import { SONIC } from '../../src/sonic.mjs';

const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Render one variant to a WAV file buffer. */
export function renderWav(key) {
  const v = SONIC.variants[key];
  if (!v) throw new Error(`unknown sonic variant: ${key}`);
  const sr = SONIC.sampleRate;
  const total = Math.round(v.length * sr);
  const left = new Float64Array(total);
  const right = new Float64Array(total);
  for (const voice of v.voices) {
    let phase = 0;
    const first = Math.round(voice.start * sr);
    for (let i = first; i < total; i++) {
      const t = i / sr;
      const lt = t - voice.start;
      const g = voice.glide ? smooth((t - voice.glide[0]) / (voice.glide[1] - voice.glide[0])) : 0;
      const freq = voice.from + ((voice.to ?? voice.from) - voice.from) * g;
      phase += (2 * Math.PI * freq) / sr;
      const env = (1 - Math.exp(-lt / voice.attack)) * Math.exp(-Math.max(0, lt - voice.hold) / voice.decay);
      let s = 0;
      for (let k = 0; k < voice.partials.length; k++) s += voice.partials[k] * Math.sin((k + 1) * phase);
      const pan = voice.pan[0] + (voice.pan[1] - voice.pan[0]) * (voice.glide ? g : 0);
      const angle = ((pan + 1) * Math.PI) / 4; // equal power
      left[i] += s * env * voice.gain * Math.cos(angle);
      right[i] += s * env * voice.gain * Math.sin(angle);
    }
  }
  const fade = Math.round(SONIC.fadeOut * sr);
  let peak = 0;
  for (let i = 0; i < total; i++) {
    const f = i > total - fade ? (total - i) / fade : 1;
    left[i] *= f;
    right[i] *= f;
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  const scale = peak ? SONIC.peak / peak : 0;
  const data = Buffer.alloc(total * 4);
  for (let i = 0; i < total; i++) {
    data.writeInt16LE(Math.round(left[i] * scale * 32767), i * 4);
    data.writeInt16LE(Math.round(right[i] * scale * 32767), i * 4 + 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(2, 22); // stereo
  head.writeUInt32LE(sr, 24);
  head.writeUInt32LE(sr * 4, 28);
  head.writeUInt16LE(4, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** Facts about a rendered WAV: seconds, peak dBFS, RMS dBFS. */
export function wavFacts(buf) {
  const sr = buf.readUInt32LE(24);
  const frames = (buf.length - 44) / 4;
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < frames * 2; i++) {
    const s = buf.readInt16LE(44 + i * 2) / 32768;
    peak = Math.max(peak, Math.abs(s));
    sum += s * s;
  }
  return { seconds: frames / sr, peakDb: 20 * Math.log10(peak), rmsDb: 10 * Math.log10(sum / (frames * 2)) };
}
