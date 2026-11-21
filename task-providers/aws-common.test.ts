import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { awsNativeJSON, classifyAwsError } from "./aws-common";

describe("classifyAwsError", () => {
  test("preserves a generic runtime error's cause in read-failure detail", () => {
    assert.deepEqual(classifyAwsError("DescribeInstanceTypes", "read", new Error("XML parser unavailable")), {
      kind: "refusal",
      name: "aws-read-failed",
      detail: {
        code: "Error",
        requestId: null,
        message: "XML parser unavailable",
      },
    });
  });

  test("normalizes AWS SDK metadata into provider-safe JSON evidence", () => {
    assert.deepEqual(
      awsNativeJSON({
        InstanceTypes: [{ HibernationSupported: false }],
        $metadata: { httpStatusCode: 200, requestId: undefined, attempts: 1 },
      }),
      {
        InstanceTypes: [{ HibernationSupported: false }],
        $metadata: { httpStatusCode: 200, attempts: 1 },
      },
    );
  });
});
