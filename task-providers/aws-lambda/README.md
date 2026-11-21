# AWS Lambda task-provider realization notes

This realization requires a numeric published task-function version and a numeric published destination-adapter version. Configuration pins both functions' code, revision, role, complete behavior-affecting configuration, task environment, no-VPC network posture, native timeout, architecture, memory, ephemeral storage, protocol, async event age, retry count, and success/failure destination.

The relationship identity needs Lambda reads and invocation plus immutable S3 read, list, and conditional-write access for its configured carriage prefix. The task and adapter execution roles separately need only the S3 access required by their transport protocols; relationship credentials are never delivered to either function.

Admission is finite: timeout absence is refused, and a requested timeout must fit the qualified native timeout minus the explicit bootstrap reserve. Cancellation is cooperative and is confirmed only by a runner acknowledgement. Pause and resume are unsupported. A live or silent invocation cannot be forcibly retired through the Lambda Invoke API. Only a correlated immutable destination record establishes that the Lambda environment is gone; absent or uncorrelated destination evidence is not death.

Legacy Lambda provider removal and consolidation into the shared provider claim owners remain final fan-in responsibilities. This leaf retains the legacy implementation and exports `registerAwsLambdaClaims` for exactly-once import by those owners.
