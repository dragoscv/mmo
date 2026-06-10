"""Manage Azure ML workspace assets (environments, compute) using the
azure-ai-ml SDK. Used as a workaround for the `az ml` CLI extension
which can't be installed on this machine (pip access-violates inside
the Azure CLI's bundled Python 3.12).

Reads credentials from environment variables:
    AZURE_SUBSCRIPTION_ID
    AZURE_RESOURCE_GROUP
    AZUREML_WORKSPACE
    AZURE_TENANT_ID
    AZURE_CLIENT_ID
    AZURE_CLIENT_SECRET

Subcommands:
    register-env <yaml>        Register / update an Environment from yaml
    ensure-compute <yaml>      Idempotently create a Compute (skips if quota=0
                               and prints the portal quota-request URL)
    list-envs                  List registered environments
    list-computes              List compute targets
    submit-job <yaml>          Submit a CommandJob from yaml
    job-status <name>          Print status of a submitted job
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from azure.ai.ml import MLClient, load_environment, load_job
from azure.ai.ml.entities import AmlCompute
from azure.core.exceptions import HttpResponseError
from azure.identity import ClientSecretCredential, DefaultAzureCredential


def _client() -> MLClient:
    sub = os.environ["AZURE_SUBSCRIPTION_ID"]
    rg = os.environ["AZURE_RESOURCE_GROUP"]
    ws = os.environ["AZUREML_WORKSPACE"]
    tenant = os.environ.get("AZURE_TENANT_ID")
    client = os.environ.get("AZURE_CLIENT_ID")
    secret = os.environ.get("AZURE_CLIENT_SECRET")
    if tenant and client and secret:
        cred = ClientSecretCredential(tenant, client, secret)
    else:
        cred = DefaultAzureCredential(exclude_interactive_browser_credential=False)
    return MLClient(cred, sub, rg, ws)


def register_env(yaml_path: str) -> None:
    ml = _client()
    env = load_environment(source=yaml_path)
    out = ml.environments.create_or_update(env)
    print(f"env-registered name={out.name} version={out.version}")


def ensure_compute(yaml_path: str) -> None:
    ml = _client()
    spec = load_job  # placeholder to satisfy import-lint; not actually used
    del spec
    import yaml as pyyaml  # type: ignore
    with open(yaml_path, "r", encoding="utf-8") as fh:
        body = pyyaml.safe_load(fh)
    name = body["name"]
    size = body["size"]
    min_n = int(body.get("min_instances", 0))
    max_n = int(body.get("max_instances", 1))
    idle = int(body.get("idle_time_before_scale_down", 1800))
    existing = None
    try:
        existing = ml.compute.get(name)
    except HttpResponseError:
        existing = None
    if existing:
        print(f"compute-exists name={name} state={existing.provisioning_state} size={existing.size}")
        return
    cluster = AmlCompute(
        name=name,
        type="amlcompute",
        size=size,
        min_instances=min_n,
        max_instances=max_n,
        idle_time_before_scale_down=idle,
        tier=body.get("tier", "Dedicated"),
    )
    try:
        ml.compute.begin_create_or_update(cluster).result()
        print(f"compute-created name={name} size={size}")
    except HttpResponseError as e:
        msg = str(e)
        if "Quota" in msg or "quota" in msg or "exceeds the limit" in msg:
            sub = os.environ["AZURE_SUBSCRIPTION_ID"]
            url = (
                "https://portal.azure.com/#blade/Microsoft_Azure_Capacity/"
                f"UsageAndQuota.ReactView/Parameters/%7B%22subscriptionId%22%3A%22{sub}%22%7D"
            )
            print(f"compute-blocked-quota name={name} size={size}")
            print(f"action-required request-quota: {url}")
            sys.exit(2)
        raise


def list_envs() -> None:
    ml = _client()
    for env in ml.environments.list():
        print(f"{env.name}\t{env.latest_version}")


def list_computes() -> None:
    ml = _client()
    for c in ml.compute.list():
        size = getattr(c, "size", "n/a")
        state = getattr(c, "provisioning_state", "?")
        print(f"{c.name}\t{c.type}\t{size}\t{state}")


def submit_job(yaml_path: str) -> None:
    ml = _client()
    job = load_job(source=yaml_path)
    out = ml.jobs.create_or_update(job)
    print(f"job-submitted name={out.name} status={out.status}")
    print(f"studio-url: {out.studio_url}")


def job_status(name: str) -> None:
    ml = _client()
    job = ml.jobs.get(name)
    print(f"name={job.name} status={job.status}")
    print(f"studio-url: {job.studio_url}")


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    cmd = sys.argv[1]
    args = sys.argv[2:]
    if cmd == "register-env":
        register_env(args[0])
    elif cmd == "ensure-compute":
        ensure_compute(args[0])
    elif cmd == "list-envs":
        list_envs()
    elif cmd == "list-computes":
        list_computes()
    elif cmd == "submit-job":
        submit_job(args[0])
    elif cmd == "job-status":
        job_status(args[0])
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
