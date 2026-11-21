# Kubernetes task provider

This realization runs one task as one deterministic Pod in an existing namespace. Every relationship field is required: namespace, complete raw Pod template, runner and workspace names, workspace capacity, delivery and status bounds, carriage paths and in-cluster identity parameters, deletion behavior, API timing, and field manager.

The authored Pod is preserved except for the reserved `sdlc.dev/*` ownership labels, deterministic name and namespace, service account, workspace and delivery/identity volumes and mounts, and runner command. The runner container, reserved metadata, environment, volume, and mount locations may not be pre-authored. The namespace must already exist. Existing, CSI, projected, ephemeral, and generic ephemeral volumes in the Pod remain supported; namespace and separately managed PVC lifecycle are not provided.

Host credentials are either an explicit bearer token or explicit client certificate and private key, with an explicit CA and TLS server name. Kubeconfig, exec plugins, proxy variables, and ambient credentials are not used. Pause and resume are unsupported.

Before persistent creation, the complete Pod is submitted with server-side dry-run. Any admission or API-server behavior-bearing change is refused with changed JSON pointers. Distributions and admission chains that mutate Pods require the author to state the resulting fields explicitly or the launch is refused.

Provider testimony includes the exact Pod status, UID, resource version, and deletion timestamp. Runner delivery/start/exit and command acknowledgements remain separate environment testimony. Pod termination or disappearance never invents a successful runner exit.
