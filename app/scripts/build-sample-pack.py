"""
DAW Sample Pack Builder
========================
Reads analyzed sample data from circuit-tracks-mwrty, selects the best samples
across all categories, copies them into public/samples/ organized for the DAW browser,
and generates a manifest.json for the browser to consume.

Source: H:\Sounds\loops\ (80K+ analyzed samples)
Analysis: E:\gh\circuit-tracks-mwrty\tools\analysis-output\all-results.json
Destination: E:\gh\rekordbox-mwrty\app\public\samples\

Usage:
    python scripts/build-sample-pack.py
    python scripts/build-sample-pack.py --dry-run
    python scripts/build-sample-pack.py --max-total 5000
    python scripts/build-sample-pack.py --max-size-mb 1500
"""

import argparse
import json
import os
import shutil
import sys
import hashlib
from collections import defaultdict
from pathlib import Path

# Fix Windows console encoding
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ─── CONFIGURATION ────────────────────────────────────────────────────────────

ANALYSIS_JSON = r"E:\gh\circuit-tracks-mwrty\tools\analysis-output\all-results.json"
SOURCE_ROOT = r"H:\Sounds\loops"
DEST_ROOT = r"E:\gh\rekordbox-mwrty\app\public\samples"

# ─── CATEGORY DEFINITIONS ────────────────────────────────────────────────────
# Maps primary_type → (folder, display_label, max_per_genre, duration_max, size_max_kb)

CATEGORIES = {
    # Drums — one-shots
    "kick":    {"folder": "drums/kicks",      "label": "Kicks",       "max_per_genre": 40, "dur_max": 3.0,  "size_max_kb": 500,   "prefer_oneshot": True},
    "snare":   {"folder": "drums/snares",     "label": "Snares",      "max_per_genre": 30, "dur_max": 3.0,  "size_max_kb": 500,   "prefer_oneshot": True},
    "clap":    {"folder": "drums/claps",      "label": "Claps",       "max_per_genre": 25, "dur_max": 3.0,  "size_max_kb": 500,   "prefer_oneshot": True},
    "hihat":   {"folder": "drums/hihats",     "label": "Hi-Hats",     "max_per_genre": 50, "dur_max": 3.0,  "size_max_kb": 500,   "prefer_oneshot": True},
    "cymbal":  {"folder": "drums/cymbals",    "label": "Cymbals",     "max_per_genre": 25, "dur_max": 5.0,  "size_max_kb": 800,   "prefer_oneshot": True},
    "perc":    {"folder": "drums/percussion", "label": "Percussion",  "max_per_genre": 40, "dur_max": 3.0,  "size_max_kb": 500,   "prefer_oneshot": True},
    "shaker":  {"folder": "drums/shakers",    "label": "Shakers",     "max_per_genre": 20, "dur_max": 3.0,  "size_max_kb": 500,   "prefer_oneshot": True},
    "darbuka": {"folder": "drums/darbuka",    "label": "Darbuka",     "max_per_genre": 20, "dur_max": 3.0,  "size_max_kb": 500,   "prefer_oneshot": True},
    "fill":    {"folder": "drums/fills",      "label": "Fills",       "max_per_genre": 20, "dur_max": 5.0,  "size_max_kb": 2000,  "prefer_oneshot": False},
    # Melodic one-shots
    "bass":    {"folder": "bass",             "label": "Bass",        "max_per_genre": 60, "dur_max": 5.0,  "size_max_kb": 2000,  "prefer_oneshot": True},
    "lead":    {"folder": "leads",            "label": "Leads",       "max_per_genre": 40, "dur_max": 5.0,  "size_max_kb": 2000,  "prefer_oneshot": True},
    "pad":     {"folder": "pads",             "label": "Pads",        "max_per_genre": 30, "dur_max": 10.0, "size_max_kb": 5000,  "prefer_oneshot": False},
    "acid":    {"folder": "synths/acid",      "label": "Acid",        "max_per_genre": 25, "dur_max": 5.0,  "size_max_kb": 2000,  "prefer_oneshot": True},
    "arp":     {"folder": "synths/arps",      "label": "Arps",        "max_per_genre": 20, "dur_max": 10.0, "size_max_kb": 5000,  "prefer_oneshot": False},
    "chord":   {"folder": "synths/chords",    "label": "Chords",      "max_per_genre": 20, "dur_max": 10.0, "size_max_kb": 3000,  "prefer_oneshot": False},
    # FX & Vocals
    "fx":      {"folder": "fx",               "label": "FX",          "max_per_genre": 40, "dur_max": 8.0,  "size_max_kb": 3000,  "prefer_oneshot": False},
    "vocal":   {"folder": "vocals",           "label": "Vocals",      "max_per_genre": 25, "dur_max": 5.0,  "size_max_kb": 2000,  "prefer_oneshot": True},
    # Loops
    "loop":    {"folder": "loops",            "label": "Loops",       "max_per_genre": 50, "dur_max": 15.0, "size_max_kb": 8000,  "prefer_oneshot": False},
}

# Genre display names
GENRE_NAMES = {
    "hard-techno":    "Hard Techno",
    "tech-house":     "Tech House",
    "melodic-techno": "Melodic Techno",
    "house":          "House",
    "deep-organic":   "Deep Organic",
    "hardbounce":     "Hard Bounce",
    "balkan":         "Balkan",
    "manele":         "Manele",
    "latino":         "Latino",
    "trap":           "Trap",
    "afro-tribal":    "Afro Tribal",
    "clasica":        "Clasica",
    "psy":            "Psy Trance",
    "greek":          "Greek",
    "populara":       "Populara",
}


def score_sample(sample: dict, cat_cfg: dict) -> float:
    """Score a sample for selection quality. Higher = better."""
    score = 0.0

    # Base score from genre analysis
    score += sample.get("best_pack_score", 0) * 2.0

    # One-shot bonus (big bonus for drum categories)
    if sample.get("oneshot"):
        score += 15.0 if cat_cfg["prefer_oneshot"] else 5.0

    # Duration: prefer shorter for one-shots, moderate for loops
    dur = sample.get("duration_s") or 999
    if cat_cfg["prefer_oneshot"]:
        if dur < 0.5:
            score += 10.0
        elif dur < 1.0:
            score += 8.0
        elif dur < 2.0:
            score += 5.0
        elif dur < 3.0:
            score += 2.0
    else:
        if 1.0 < dur < 8.0:
            score += 5.0
        elif dur < 1.0:
            score += 3.0

    # RMS: prefer louder, better-recorded samples (not too quiet)
    rms = sample.get("rms_db")
    if rms is not None:
        rms = float(rms)
        if rms > -20:
            score += 5.0
        elif rms > -30:
            score += 3.0
        elif rms > -40:
            score += 1.0
        # Very quiet = probably silence or near-silence
        if rms < -50:
            score -= 10.0

    # Onset strength: prefer punchy samples for drums
    onset = sample.get("onset_strength") or 0
    if cat_cfg["prefer_oneshot"] and onset > 0.7:
        score += 3.0

    # Percussiveness bonus for drum types
    drum_types = {"kick", "snare", "clap", "hihat", "cymbal", "perc", "shaker", "darbuka", "fill"}
    if sample.get("primary_type") in drum_types and sample.get("is_percussive"):
        score += 3.0

    # Tonality bonus for melodic types
    melodic_types = {"bass", "lead", "pad", "acid", "arp", "chord"}
    if sample.get("primary_type") in melodic_types and sample.get("is_tonal"):
        score += 3.0

    # Has pitch info = better analyzed
    if sample.get("pitch_hz"):
        score += 1.0

    # Size: prefer smaller files (less disk usage)
    size = sample.get("size_kb") or 999999
    if size < 50:
        score += 2.0
    elif size < 200:
        score += 1.0

    # Audio type confirmation bonus
    if sample.get("audio_type") == sample.get("primary_type"):
        score += 3.0

    # Penalty for unknown type
    if sample.get("primary_type") == "unknown":
        score -= 5.0

    return score


def select_samples(all_samples: list, max_total: int, max_size_mb: float) -> dict:
    """
    Select the best samples organized by category and genre.
    Returns: { "drums/kicks": [samples...], "bass": [samples...], ... }
    """
    # Group candidates by (primary_type, best_pack)
    by_type_genre = defaultdict(list)
    skipped_no_type = 0
    skipped_no_genre = 0
    skipped_duration = 0
    skipped_size = 0
    skipped_no_file = 0

    for s in all_samples:
        ptype = s.get("primary_type", "unknown")
        genre = s.get("best_pack")

        # Skip unknown type unless it has a very high score
        if ptype == "unknown":
            if s.get("best_pack_score", 0) < 5.0:
                skipped_no_type += 1
                continue
            # Try to infer type from audio_type
            atype = s.get("audio_type")
            if atype and atype in CATEGORIES:
                ptype = atype
            else:
                skipped_no_type += 1
                continue

        if ptype not in CATEGORIES:
            skipped_no_type += 1
            continue

        cat = CATEGORIES[ptype]

        # Duration filter
        dur = s.get("duration_s") or 999
        if dur > cat["dur_max"]:
            skipped_duration += 1
            continue

        # Size filter
        size_kb = s.get("size_kb") or 999999
        if size_kb > cat["size_max_kb"]:
            skipped_size += 1
            continue

        # Must have a valid file path
        fp = s.get("full_path", "")
        if not fp:
            skipped_no_file += 1
            continue

        # Supported formats only
        ext = os.path.splitext(fp)[1].lower()
        if ext not in {".wav", ".mp3", ".flac", ".ogg", ".aac", ".aiff", ".aif", ".m4a"}:
            continue

        # If no genre assigned, use "general"
        g = genre if genre else "general"
        by_type_genre[(ptype, g)].append(s)

    print(f"\n  Filtering stats:")
    print(f"    Skipped (no usable type): {skipped_no_type:,}")
    print(f"    Skipped (duration):       {skipped_duration:,}")
    print(f"    Skipped (size):           {skipped_size:,}")
    print(f"    Skipped (no file path):   {skipped_no_file:,}")

    # Score and sort within each group
    for key in by_type_genre:
        ptype = key[0]
        cat = CATEGORIES[ptype]
        by_type_genre[key].sort(key=lambda s: score_sample(s, cat), reverse=True)

    # Select top N per type/genre, tracking totals
    selected = defaultdict(list)  # folder → [sample_dicts]
    total_count = 0
    total_size_kb = 0
    max_size_kb = max_size_mb * 1024
    seen_filenames = set()  # Deduplicate by filename

    for (ptype, genre), candidates in sorted(by_type_genre.items()):
        cat = CATEGORIES[ptype]
        folder = cat["folder"]
        limit = cat["max_per_genre"]
        added = 0

        for s in candidates:
            if total_count >= max_total:
                break
            if total_size_kb >= max_size_kb:
                break
            if added >= limit:
                break

            # Deduplicate by filename (same sample may appear in multiple analyses)
            fname = s.get("filename", "")
            dedup_key = f"{ptype}_{fname}"
            if dedup_key in seen_filenames:
                continue
            seen_filenames.add(dedup_key)

            # Add genre tag to sample dict
            s["_selected_genre"] = genre
            s["_selected_type"] = ptype
            s["_score"] = score_sample(s, cat)
            selected[folder].append(s)

            total_count += 1
            total_size_kb += s.get("size_kb", 0)
            added += 1

        if added > 0:
            print(f"    {folder}/{genre}: {added} samples selected from {len(candidates)} candidates")

    print(f"\n  Total selected: {total_count:,} samples ({total_size_kb / 1024:.1f} MB)")
    return dict(selected)


def sanitize_filename(name: str) -> str:
    """Make a filename safe for the filesystem."""
    # Remove or replace problematic characters
    for ch in '<>:"/\\|?*':
        name = name.replace(ch, "_")
    # Collapse multiple underscores
    while "__" in name:
        name = name.replace("__", "_")
    return name.strip("_. ")


def copy_samples(selected: dict, dry_run: bool = False) -> dict:
    """
    Copy selected samples to destination, organized by folder.
    Returns manifest data.
    """
    manifest = {
        "version": 1,
        "name": "MWRTY Base Sample Pack",
        "description": "Curated sample library from 80K+ analyzed audio files",
        "categories": [],
        "totalSamples": 0,
        "totalSizeKB": 0,
    }

    total_copied = 0
    total_errors = 0
    total_size = 0

    for folder, samples in sorted(selected.items()):
        # Group by genre within folder
        by_genre = defaultdict(list)
        for s in samples:
            g = s["_selected_genre"]
            by_genre[g].append(s)

        cat_info = {
            "path": folder,
            "label": "",
            "genres": [],
            "sampleCount": 0,
        }

        # Find the label from CATEGORIES
        for ptype, cfg in CATEGORIES.items():
            if cfg["folder"] == folder:
                cat_info["label"] = cfg["label"]
                break

        for genre, genre_samples in sorted(by_genre.items()):
            genre_label = GENRE_NAMES.get(genre, genre.title())
            dest_dir = os.path.join(DEST_ROOT, folder, genre)
            genre_info = {
                "name": genre,
                "label": genre_label,
                "path": f"{folder}/{genre}",
                "samples": [],
            }

            if not dry_run:
                os.makedirs(dest_dir, exist_ok=True)

            for idx, s in enumerate(genre_samples, 1):
                src_path = s.get("full_path", "")
                if not src_path:
                    continue

                # Build destination filename: clean, short, informative
                orig_name = s.get("filename", f"sample_{idx}")
                base, ext = os.path.splitext(orig_name)
                safe_name = sanitize_filename(base) + ext.lower()

                # Ensure uniqueness within folder
                dest_path = os.path.join(dest_dir, safe_name)
                counter = 1
                while os.path.exists(dest_path) or (dry_run and safe_name in [si["file"] for si in genre_info["samples"]]):
                    safe_name = f"{sanitize_filename(base)}_{counter}{ext.lower()}"
                    dest_path = os.path.join(dest_dir, safe_name)
                    counter += 1

                # Copy
                if not dry_run:
                    try:
                        if os.path.exists(src_path):
                            shutil.copy2(src_path, dest_path)
                            total_copied += 1
                            total_size += os.path.getsize(dest_path)
                        else:
                            total_errors += 1
                            continue
                    except Exception as e:
                        print(f"    ERROR copying {orig_name}: {e}")
                        total_errors += 1
                        continue
                else:
                    total_copied += 1
                    total_size += s.get("size_kb", 0) * 1024

                # Add to manifest
                sample_info = {
                    "file": safe_name,
                    "path": f"/samples/{folder}/{genre}/{safe_name}",
                    "name": base,
                    "type": s.get("_selected_type", "unknown"),
                    "duration": round(s.get("duration_s", 0), 3),
                    "sizeKB": round(s.get("size_kb", 0), 1),
                    "oneshot": bool(s.get("oneshot")),
                    "bpm": s.get("bpm"),
                    "key": s.get("key"),
                    "brightness": s.get("brightness"),
                    "rmsDb": s.get("rms_db"),
                }
                genre_info["samples"].append(sample_info)

            cat_info["genres"].append(genre_info)
            cat_info["sampleCount"] += len(genre_info["samples"])

        manifest["categories"].append(cat_info)

    manifest["totalSamples"] = total_copied
    manifest["totalSizeKB"] = round(total_size / 1024, 1)

    print(f"\n{'[DRY RUN] ' if dry_run else ''}Copy results:")
    print(f"  Copied: {total_copied:,}")
    print(f"  Errors: {total_errors:,}")
    print(f"  Total size: {total_size / (1024 * 1024):.1f} MB")

    return manifest


def write_manifest(manifest: dict, dry_run: bool = False):
    """Write manifest.json to the samples directory."""
    manifest_path = os.path.join(DEST_ROOT, "manifest.json")
    if not dry_run:
        os.makedirs(DEST_ROOT, exist_ok=True)
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2, ensure_ascii=False)
        print(f"\n  Manifest written to: {manifest_path}")
        print(f"  Categories: {len(manifest['categories'])}")
        print(f"  Total samples: {manifest['totalSamples']:,}")
    else:
        print(f"\n  [DRY RUN] Would write manifest to: {manifest_path}")
        print(f"  Categories: {len(manifest['categories'])}")
        print(f"  Total samples: {manifest['totalSamples']:,}")


def main():
    parser = argparse.ArgumentParser(description="Build DAW sample pack from analyzed library")
    parser.add_argument("--dry-run", action="store_true", help="Preview without copying")
    parser.add_argument("--max-total", type=int, default=8000, help="Max total samples (default: 8000)")
    parser.add_argument("--max-size-mb", type=float, default=2000.0, help="Max total size in MB (default: 2000)")
    parser.add_argument("--clean", action="store_true", help="Remove existing samples directory first")
    args = parser.parse_args()

    print("=" * 70)
    print("  MWRTY DAW Sample Pack Builder")
    print("=" * 70)

    # Verify paths
    if not os.path.exists(ANALYSIS_JSON):
        print(f"\nERROR: Analysis JSON not found: {ANALYSIS_JSON}")
        sys.exit(1)
    if not os.path.exists(SOURCE_ROOT):
        print(f"\nERROR: Source directory not found: {SOURCE_ROOT}")
        sys.exit(1)

    # Clean destination if requested
    if args.clean and os.path.exists(DEST_ROOT) and not args.dry_run:
        print(f"\nCleaning: {DEST_ROOT}")
        shutil.rmtree(DEST_ROOT)

    # Load analysis data
    print(f"\nLoading analysis data from: {ANALYSIS_JSON}")
    with open(ANALYSIS_JSON, "r", encoding="utf-8") as f:
        all_samples = json.load(f)
    print(f"  Loaded {len(all_samples):,} samples")

    # Select best samples
    print(f"\nSelecting samples (max {args.max_total:,}, max {args.max_size_mb:.0f}MB)...")
    selected = select_samples(all_samples, args.max_total, args.max_size_mb)

    if not selected:
        print("\nNo samples selected! Check filtering criteria.")
        sys.exit(1)

    # Copy files
    print(f"\n{'[DRY RUN] ' if args.dry_run else ''}Copying samples to: {DEST_ROOT}")
    manifest = copy_samples(selected, dry_run=args.dry_run)

    # Write manifest
    write_manifest(manifest, dry_run=args.dry_run)

    # Print summary
    print("\n" + "=" * 70)
    print("  SUMMARY")
    print("=" * 70)
    for cat in manifest["categories"]:
        genre_detail = ", ".join(f"{g['label']}: {len(g['samples'])}" for g in cat["genres"] if g["samples"])
        print(f"  {cat['label']:20s} ({cat['path']:25s}): {cat['sampleCount']:5d} samples")
        if genre_detail:
            print(f"    └─ {genre_detail}")

    print(f"\n  TOTAL: {manifest['totalSamples']:,} samples, {manifest['totalSizeKB'] / 1024:.1f} MB")
    print("=" * 70)


if __name__ == "__main__":
    main()
