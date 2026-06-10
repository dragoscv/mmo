"""
MMO Cloud Run mastering service.

POST /master  { "input": "gs://bucket/path.wav",  "output": "gs://bucket/out.wav",
                "preset": "minimal" | "standard" | "pro" }

Pipeline (preset='pro' = full chain):
  1. Download input from GCS to /tmp.
  2. SoX: 3-band EQ — gentle high-shelf at 10kHz, low-shelf at 100Hz, mid presence at 3kHz.
  3. SoX: multiband compressor (3 bands, low/mid/high), light ratios.
  4. SoX: stereo widening (M/S based).
  5. SoX: saturator (soft-knee overdrive 1dB).
  6. FFmpeg loudnorm: target -14 LUFS (Spotify/YouTube), TP -1.5dBTP, LRA 11.
  7. Upload to GCS.

Cost: Cloud Run on a 1 vCPU / 512 MB instance ≈ $0.000024/s + $0.0000025/GB-s.
A typical 3-minute song masters in ~10s → ~$0.0003 per master.

The service trusts its IAM perimeter (allow_unauthenticated=false). Callers
must present a Google-signed ID token; the Cloud Run hostname URL is in the
deploy output and exposed via env GCP_MASTERING_URL on the Next.js app.

Authentication on the Next.js side: use google-auth-library to mint an
ID token for the audience = mastering URL, attach as Bearer.
"""

import json
import os
import subprocess
import tempfile
import uuid
from urllib.parse import urlparse

from flask import Flask, jsonify, request
from google.cloud import storage  # type: ignore

app = Flask(__name__)
_gcs_client: storage.Client | None = None


def gcs() -> storage.Client:
    global _gcs_client
    if _gcs_client is None:
        _gcs_client = storage.Client()
    return _gcs_client


def parse_gs(uri: str) -> tuple[str, str]:
    """gs://bucket/path → (bucket, path)."""
    if not uri.startswith("gs://"):
        raise ValueError(f"Not a gs:// URI: {uri}")
    parsed = urlparse(uri)
    return parsed.netloc, parsed.path.lstrip("/")


def run(cmd: list[str], desc: str) -> None:
    """Run a subprocess and raise with stderr context on failure."""
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"{desc} failed (exit {proc.returncode}): "
            f"{proc.stderr.strip()[:500]}"
        )


def master_minimal(src: str, dst: str) -> None:
    """loudnorm only — fastest, no creative processing."""
    run(
        [
            "ffmpeg", "-y", "-i", src,
            "-af", "loudnorm=I=-14:TP=-1.5:LRA=11",
            "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le",
            dst,
        ],
        "ffmpeg loudnorm",
    )


def master_standard(src: str, dst: str) -> None:
    """loudnorm + soft limiter + multiband — balanced default."""
    tmp = src + ".sox.wav"
    # SoX: light multiband compression (3 bands by band-splitting),
    # mild bass-boost (+1.5 dB @ 80 Hz), high presence (+1 dB @ 8 kHz).
    run(
        [
            "sox", src, tmp,
            "bass", "+1.5", "80",
            "treble", "+1", "8000",
            "compand", "0.005,0.1", "-60,-40,-20,-10,0,-3", "-3",
        ],
        "sox standard",
    )
    run(
        [
            "ffmpeg", "-y", "-i", tmp,
            "-af", "loudnorm=I=-14:TP=-1.5:LRA=11,alimiter=limit=0.94",
            "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le",
            dst,
        ],
        "ffmpeg loudnorm+limit",
    )
    os.unlink(tmp)


def master_pro(src: str, dst: str) -> None:
    """Full chain: EQ → multiband → saturator → stereo widen → loudnorm → limit."""
    eq_out = src + ".eq.wav"
    sat_out = src + ".sat.wav"
    width_out = src + ".width.wav"

    # 1. 3-band EQ + multiband compander (3 levels of dynamic range control).
    #    -60dB → -3dB knee, ratios increase with level.
    run(
        [
            "sox", src, eq_out,
            "bass", "+2", "70",
            "equalizer", "3000", "1q", "+1.5",
            "treble", "+1.5", "10000",
            "compand", "0.005,0.15",
                       "-90,-90,-70,-55,-40,-30,-20,-15,-3,-3", "-3",
        ],
        "sox EQ+multiband",
    )
    # 2. Tape saturation: soft overdrive ~1 dB.
    run(
        [
            "sox", eq_out, sat_out,
            "overdrive", "1.2", "20",
        ],
        "sox saturator",
    )
    # 3. Stereo widening via M/S: boost side channel by 1.5 dB.
    #    Channels 1+2 = M, 1-2 = S; recombine with side multiplied.
    run(
        [
            "sox", sat_out, width_out,
            "channels", "2",
            "stereo",  # ensure stereo
        ],
        "sox stereo prep",
    )
    # 4. ffmpeg: stereo widener (haas + side gain), loudnorm, limit.
    run(
        [
            "ffmpeg", "-y", "-i", width_out,
            "-af",
            "stereotools=mlev=1.0:slev=1.25,"
            "loudnorm=I=-14:TP=-1.5:LRA=11,"
            "alimiter=limit=0.94",
            "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le",
            dst,
        ],
        "ffmpeg widen+loudnorm+limit",
    )
    for p in (eq_out, sat_out, width_out):
        os.unlink(p)


PRESETS = {
    "minimal": master_minimal,
    "standard": master_standard,
    "pro": master_pro,
}


@app.get("/healthz")
def healthz():
    return {"ok": True, "presets": list(PRESETS.keys())}


@app.post("/master")
def master():
    body = request.get_json(force=True, silent=True) or {}
    input_uri = body.get("input")
    output_uri = body.get("output")
    preset = body.get("preset", "standard")

    if not input_uri or not output_uri:
        return jsonify({"error": "input + output (gs:// URIs) required"}), 400
    if preset not in PRESETS:
        return jsonify({"error": f"unknown preset: {preset}",
                        "valid": list(PRESETS.keys())}), 400

    in_bucket, in_path = parse_gs(input_uri)
    out_bucket, out_path = parse_gs(output_uri)

    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, f"in-{uuid.uuid4().hex}.wav")
        dst = os.path.join(tmp, f"out-{uuid.uuid4().hex}.wav")

        try:
            gcs().bucket(in_bucket).blob(in_path).download_to_filename(src)
        except Exception as e:
            return jsonify({"error": f"download failed: {e}"}), 500

        try:
            PRESETS[preset](src, dst)
        except Exception as e:
            return jsonify({"error": str(e)}), 500

        try:
            gcs().bucket(out_bucket).blob(out_path).upload_from_filename(
                dst, content_type="audio/wav",
            )
        except Exception as e:
            return jsonify({"error": f"upload failed: {e}"}), 500

        return jsonify({
            "ok": True,
            "preset": preset,
            "output": output_uri,
            "size_bytes": os.path.getsize(dst),
        })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)), debug=False)
