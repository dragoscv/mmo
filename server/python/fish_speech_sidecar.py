"""Fish Speech V1.5 sidecar (TTS).

Multilingual zero-shot TTS with native Romanian + English coverage
(VQGAN + Llama architecture). Targets the speech preview path that
currently falls through to XTTS-v2 (which renders Romanian as Italian
phonemes).

This file is currently a protocol-compliant STUB. Real install path
is non-trivial:
  • The `fish-audio-sdk` PyPI package is a cloud API client, NOT local.
  • The `fish_speech` local package ships via the GitHub repo +
    huggingface-cli checkpoint download — needs a `pip install -e .`
    from a checkout and ~5 GB of weights.

We probe for the local `fish_speech` module; if absent the companion
keeps XTTS-v2 as the default for RO/EN until install lands.

Workflows powered:
  • D: speech preview / Maestro AI voice — replaces XTTS for RO+EN.

Install (deferred)
──────────────────
  git clone https://github.com/fishaudio/fish-speech
  pip install -e fish-speech
  huggingface-cli download fishaudio/fish-speech-1.5 \\
      --local-dir fish-speech/checkpoints/fish-speech-1.5
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _sidecar import Sidecar, has_module  # noqa: E402


INSTALLED = has_module("fish_speech")
CAPABILITIES = ["synthesize"] if INSTALLED else []
EXTRA = {
    "installed": INSTALLED,
    "installHint": None if INSTALLED else "git clone https://github.com/fishaudio/fish-speech && pip install -e fish-speech",
    "languages": ["en", "ro", "es", "fr", "de", "it", "pt", "zh", "ja"] if INSTALLED else [],
}

sc = Sidecar(
    engine_id="fish-speech",
    version="0.1-stub",
    capabilities=CAPABILITIES,
    extra_hello=EXTRA,
)


@sc.handler("fish.health")
def _health(_args: dict, _ctx) -> dict:
    return {"installed": INSTALLED, "languages": EXTRA["languages"]}


@sc.handler("fish.synthesize")
def _synthesize(_args: dict, _ctx) -> dict:
    if not INSTALLED:
        raise RuntimeError("engine-missing: fish_speech (see installHint)")
    raise NotImplementedError("fish.synthesize not implemented yet (Phase 6 in-progress)")


if __name__ == "__main__":
    sc.run()
