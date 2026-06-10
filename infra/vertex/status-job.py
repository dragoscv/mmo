#!/usr/bin/env python
"""Print Vertex AI CustomJob state as JSON.

Used by the Next.js reconciler (`app/src/actions/training-reconcile.ts`)
to catch up on jobs whose trainer didn't deliver a final webhook.

Output schema (one line of JSON on stdout):
  {
    "state": "JOB_STATE_SUCCEEDED" | "JOB_STATE_FAILED" | "JOB_STATE_RUNNING" | ...,
    "error":   "<message>" (only when failed),
    "outputUri":  "gs://.../output/" (when present),
    "weightsUri": "gs://.../lora.safetensors" (best-effort guess from outputUri)
  }

Env vars: GOOGLE_APPLICATION_CREDENTIALS, GCP_PROJECT (or PROJECT_ID),
         GCP_REGION (default europe-west1).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job-name", required=True,
                    help="Full Vertex CustomJob resource name "
                    "(e.g. projects/123/locations/europe-west1/customJobs/456)")
    args = ap.parse_args()

    try:
        from google.cloud import aiplatform  # type: ignore
    except ImportError:
        print(json.dumps({"state": "JOB_STATE_UNKNOWN",
                          "error": "google-cloud-aiplatform not installed"}))
        return 1

    project = os.environ.get("GCP_PROJECT") or os.environ.get("PROJECT_ID")
    region = os.environ.get("GCP_REGION", "europe-west1")
    aiplatform.init(project=project, location=region)

    try:
        job = aiplatform.CustomJob.get(args.job_name)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"state": "JOB_STATE_UNKNOWN", "error": str(e)}))
        return 1

    state_name = job.state.name if hasattr(job.state, "name") else str(job.state)
    out: dict[str, Any] = {"state": state_name}
    if hasattr(job, "error") and job.error:
        out["error"] = str(job.error)
    # Best-effort: the trainer convention is `--output-uri gs://.../<job>/output/`
    spec = job.job_spec if hasattr(job, "job_spec") else None
    if spec is not None:
        try:
            for worker in spec.worker_pool_specs or []:
                args_list = list(worker.container_spec.args or [])
                if "--output-uri" in args_list:
                    idx = args_list.index("--output-uri")
                    if idx + 1 < len(args_list):
                        out["outputUri"] = args_list[idx + 1]
                        # Common ACE-Step trainer output filename.
                        out["weightsUri"] = (
                            out["outputUri"].rstrip("/") + "/lora.safetensors"
                        )
        except Exception:  # noqa: BLE001
            pass

    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
