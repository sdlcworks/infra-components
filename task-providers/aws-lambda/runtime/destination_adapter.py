import hashlib
import json


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def put_immutable(s3, bucket, key, body, metadata=None):
    try:
        arguments = {"Bucket": bucket, "Key": key, "Body": body, "IfNoneMatch": "*"}
        if metadata is not None:
            arguments["Metadata"] = metadata
        s3.put_object(**arguments)
    except Exception as error:
        if getattr(error, "response", {}).get("Error", {}).get("Code") not in ("PreconditionFailed", "412"):
            raise
        if s3.get_object(Bucket=bucket, Key=key)["Body"].read() != body:
            raise ValueError("immutable-terminal-conflict")


def handler(event, context, s3=None):
    s3 = s3 or __import__("boto3").client("s3")
    if event.get("kind") == "qualification":
        record = {"version": 1, "adapterVersionArn": event["adapterVersionArn"], "probeIdentity": event["probeIdentity"]}
        record["digest"] = hashlib.sha256(canonical(record)).hexdigest()
        association = event["association"]
        metadata = {"run-digest": association["runDigest"], "configuration-digest": association["configurationDigest"], "archive-sha256": association["archiveSha256"], "tree-sha256": association["treeSha256"], "runner-sha256": association["runnerSha256"]}
        put_immutable(s3, event["bucket"], f'{event["prefix"]}/{event["key"]}', canonical(record), metadata)
        return {"qualified": True}
    request = event.get("requestContext", {})
    payload = event.get("requestPayload", {})
    response = event.get("responseContext", {})
    if payload.get("version") != 1 or request.get("functionArn") != payload.get("functionVersionArn"):
        raise ValueError("destination-association-mismatch")
    encoded = canonical(event)
    terminal = payload["terminal"]
    if len(encoded) > terminal["maximumRecordBytes"]:
        raise ValueError("destination-record-oversized")
    condition = request.get("condition")
    if condition not in ("Success", "RetriesExhausted"):
        raise ValueError("destination-condition-invalid")
    request_id = request.get("requestId")
    record = canonical({"version": 1, "runId": payload["runId"], "functionVersionArn": payload["functionVersionArn"], "requestId": request_id, "condition": condition, "statusCode": response.get("statusCode"), "functionError": response.get("functionError")})
    put_immutable(s3, terminal["bucket"], f'{terminal["prefix"]}/lambda-terminal/{request_id}.json', record)
    return {"recorded": True}
