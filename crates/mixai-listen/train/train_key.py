"""Train the MixAI key CNN (WP18-16, D69).

Architecture: all-convolutional key classifier after Korzeniowski & Widmer, "Genre-Agnostic Key Classification
with Convolutional Neural Networks" (ISMIR 2018): five 5x5 conv blocks with ELU + batch norm over a
log-frequency spectrogram (24 bins/octave), a 1x1 conv to 24 key maps, global average pooling, softmax.
Our own implementation and weights (no madmom/Essentia weights: non-commercial licences).

Data: `.f32` features + `index.tsv` written by `mixai-listen-bench --dump-features` (the exact on-device
frontend). Train on GiantSteps-MTG, evaluate on the GiantSteps key TEST set, which is never used for training
or model selection (selection uses a held-out 10 % of MTG).

Augmentation: pitch shift by k semitones = roll the frequency axis by 2k bins and rotate the label by k
(-4..+7 like the paper), random 20 s crops, random gain in log domain.

    uv run train_key.py --feat <cache>/feat --out ../models/key_cnn.onnx [--epochs 60]
"""

from __future__ import annotations

import argparse
import json
import math
import random
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

BINS = 120  # must match mixai_listen::features::BINS
FPS = 5.0
CROP = int(20 * FPS)


def load_set(d: Path) -> list[tuple[np.ndarray, int]]:
    out = []
    for line in (d / "index.tsv").read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        sid, key, frames = line.split("\t")
        x = np.fromfile(d / f"{sid}.f32", dtype="<f4").reshape(int(frames), BINS)
        if x.shape[0] >= 10:
            out.append((x, int(key)))
    return out


def shift(x: np.ndarray, key: int, k: int) -> tuple[np.ndarray, int]:
    """Pitch-shift features by k semitones (2k bins, zero-fill) and rotate the key label."""
    if k == 0:
        return x, key
    b = 2 * k
    y = np.zeros_like(x)
    if b > 0:
        y[:, b:] = x[:, :-b]
    else:
        y[:, :b] = x[:, -b:]
    tonic, minor = key % 12, key >= 12
    return y, ((tonic + k) % 12) + (12 if minor else 0)


class KeyCnn(nn.Module):
    def __init__(self, nf: int = 20, dropout: float = 0.1):
        super().__init__()

        def block(cin: int, cout: int) -> nn.Sequential:
            return nn.Sequential(nn.Conv2d(cin, cout, 5, padding=2), nn.BatchNorm2d(cout), nn.ELU())

        self.features = nn.Sequential(
            block(1, nf),
            block(nf, nf),
            nn.MaxPool2d(2),
            nn.Dropout(dropout),
            block(nf, 2 * nf),
            block(2 * nf, 2 * nf),
            nn.MaxPool2d(2),
            nn.Dropout(dropout),
            block(2 * nf, 4 * nf),
            nn.Dropout(dropout),
            nn.Conv2d(4 * nf, 8 * nf, 3, padding=1),
            nn.BatchNorm2d(8 * nf),
            nn.ELU(),
            nn.Conv2d(8 * nf, 24, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: [B, frames, BINS] -> [B, 1, BINS, frames]; logits [B, 24]
        h = self.features(x.transpose(1, 2).unsqueeze(1))
        return h.mean(dim=(2, 3))


def mirex(est: int, ref: int) -> float:
    if est == ref:
        return 1.0
    et, em, rt, rm = est % 12, est >= 12, ref % 12, ref >= 12
    if em == rm and (et == (rt + 7) % 12 or et == (rt + 5) % 12):
        return 0.5
    if (not rm and em and et == (rt + 9) % 12) or (rm and not em and et == (rt + 3) % 12):
        return 0.3
    if et == rt:
        return 0.2
    return 0.0


def batches(data, bs: int, train: bool):
    idx = list(range(len(data)))
    if train:
        random.shuffle(idx)
    for i in range(0, len(idx), bs):
        xs, ys = [], []
        for j in idx[i : i + bs]:
            x, y = data[j]
            if train:
                x, y = shift(x, y, random.randint(-4, 7))
                if x.shape[0] > CROP:
                    s = random.randint(0, x.shape[0] - CROP)
                    x = x[s : s + CROP]
                x = x + random.uniform(-0.3, 0.3) * (x > 0)
            xs.append(x)
            ys.append(y)
        t = max(x.shape[0] for x in xs)
        arr = np.zeros((len(xs), t, BINS), dtype=np.float32)
        for k, x in enumerate(xs):
            arr[k, : x.shape[0]] = x
        yield torch.from_numpy(arr), torch.tensor(ys)


@torch.no_grad()
def evaluate(model, data, dev) -> tuple[float, float]:
    model.eval()
    scores, correct = [], 0
    for x, y in data:
        p = model(torch.from_numpy(x[None]).to(dev)).argmax(1).item()
        scores.append(mirex(p, y))
        correct += int(p == y)
    return float(np.mean(scores)), correct / len(data)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--feat", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--nf", type=int, default=20)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    random.seed(a.seed)
    np.random.seed(a.seed)
    torch.manual_seed(a.seed)
    dev = "cuda" if torch.cuda.is_available() else "cpu"

    mtg = load_set(a.feat / "mtg")
    test = load_set(a.feat / "test")
    random.shuffle(mtg)
    n_val = len(mtg) // 10
    val, train = mtg[:n_val], mtg[n_val:]
    print(f"train {len(train)} val {len(val)} test {len(test)} device {dev}")

    model = KeyCnn(a.nf).to(dev)
    params = sum(p.numel() for p in model.parameters())
    print(f"params {params} (~{params * 4 / 1024:.0f} KB fp32)")
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    steps = a.epochs * math.ceil(len(train) / 8)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=2e-3, total_steps=steps)
    best = (-1.0, None)
    for ep in range(a.epochs):
        model.train()
        tot = 0.0
        for x, y in batches(train, 8, True):
            x, y = x.to(dev), y.to(dev)
            loss = F.cross_entropy(model(x), y, label_smoothing=0.05)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            tot += loss.item() * len(y)
        vw, vc = evaluate(model, val, dev)
        if vw > best[0]:
            best = (vw, {k: v.detach().clone() for k, v in model.state_dict().items()})
        print(f"epoch {ep + 1:3d} loss {tot / len(train):.4f} val_weighted {vw:.4f} val_correct {vc:.4f}", flush=True)

    model.load_state_dict(best[1])
    tw, tc = evaluate(model, test, dev)
    vw, vc = evaluate(model, val, dev)
    print(f"BEST val_weighted {vw:.4f} | TEST giantsteps weighted {tw:.4f} correct {tc:.4f}")

    model.eval().cpu()
    a.out.parent.mkdir(parents=True, exist_ok=True)
    dummy = torch.zeros(1, 50, BINS)
    torch.onnx.export(
        model,
        (dummy,),
        str(a.out),
        input_names=["logspec"],
        output_names=["logits"],
        dynamic_axes={"logspec": {0: "batch", 1: "frames"}, "logits": {0: "batch"}},
        opset_version=17,
        dynamo=False,
    )
    meta = {
        "bins": BINS,
        "fps": FPS,
        "params": params,
        "val_weighted": vw,
        "test_weighted": tw,
        "test_correct": tc,
        "train_tracks": len(train),
        "arch": f"allconv nf={a.nf}",
        "seed": a.seed,
    }
    a.out.with_suffix(".json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"wrote {a.out} ({a.out.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
