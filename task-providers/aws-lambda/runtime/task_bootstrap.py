import hashlib
import io
import json
import os
import subprocess
import tarfile
import threading
import time


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def safe_extract(archive, destination, maximum_bytes):
    total = 0
    names = set()
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:*") as bundle:
        for member in bundle.getmembers():
            parts = member.name.split("/")
            if member.name.startswith("/") or ".." in parts or member.name in names or member.issym() or member.islnk() or member.isdev():
                raise ValueError("unsafe-archive-member")
            names.add(member.name)
            total += member.size
            if total > maximum_bytes:
                raise ValueError("archive-oversized")
        bundle.extractall(destination, filter="data")


def put_immutable(s3, bucket, key, body):
    try:
        s3.put_object(Bucket=bucket, Key=key, Body=body, IfNoneMatch="*")
        return True
    except Exception as error:
        if getattr(error, "response", {}).get("Error", {}).get("Code") not in ("PreconditionFailed", "412"):
            raise
        existing = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
        if existing != body:
            raise ValueError("immutable-object-conflict")
        return False


def handler(event, context, s3=None, runner=None, workspace="/tmp/sdlc-task"):
    s3 = s3 or __import__("boto3").client("s3")
    if event.get("version") != 1 or event.get("functionVersionArn") != getattr(context, "invoked_function_arn", None):
        raise ValueError("lambda-invocation-association-mismatch")
    delivery = event["delivery"]
    terminal = event["terminal"]
    if terminal["prefix"] != delivery["prefix"]:
        raise ValueError("lambda-terminal-prefix-mismatch")
    claim = canonical({"version": 1, "runId": event["runId"], "functionVersionArn": event["functionVersionArn"], "requestId": context.aws_request_id})
    claim_key = f'{delivery["prefix"]}/lambda-claim.json'
    if not put_immutable(s3, delivery["bucket"], claim_key, claim):
        return {"duplicate": True}
    manifest_bytes = s3.get_object(Bucket=delivery["bucket"], Key=f'{delivery["prefix"]}/delivery.json')["Body"].read()
    if digest(manifest_bytes) != delivery["deliveryDigest"]:
        raise ValueError("delivery-digest-mismatch")
    manifest = json.loads(manifest_bytes)
    archive = s3.get_object(Bucket=delivery["bucket"], Key=f'{delivery["prefix"]}/task/archive')["Body"].read()
    runner_bytes = s3.get_object(Bucket=delivery["bucket"], Key=f'{delivery["prefix"]}/runner/task-runner')["Body"].read()
    if digest(archive) != manifest["content"]["archiveSha256"] or digest(runner_bytes) != manifest["runnerSha256"]:
        raise ValueError("delivered-material-digest-mismatch")
    os.makedirs(workspace, exist_ok=True)
    safe_extract(archive, workspace, 1024 * 1024 * 1024)
    runner_path = os.path.join(workspace, "sdlc-task-runner")
    with open(runner_path, "wb") as output:
        output.write(runner_bytes)
    os.chmod(runner_path, 0o700)
    process = (runner or subprocess.Popen)([runner_path], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    sequence = 0
    for line in process.stdout:
        sequence += 1
        frame = json.loads(line)
        put_immutable(s3, delivery["bucket"], f'{delivery["prefix"]}/status/{sequence:020}.json', canonical(frame))
    return {"exitCode": process.wait()}
