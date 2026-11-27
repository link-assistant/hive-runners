# Hive Runners operator guide

For workstation jobs, see [local private workers and live resource admission](hive-runners-local.md).

## Choose what to deploy

| Mode                    | Configure                                                                  | Where jobs run                                     |
| ----------------------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| Existing private runner | SSH inventory and a private repository or organization pool                | Your existing machine                              |
| Private fleet           | One or more private pools, provider credentials and CI webhooks            | Terraform and API-managed machines                 |
| Seller                  | A private pool and account key per customer, with optional Stripe Checkout | Dedicated or shared contributed Linux machines     |
| Hub                     | Customer accounts with upstream offers and optional local provider         | A local dedicated machine or the selected supplier |

Use an Ubuntu 24.04 or Debian host with Docker-compatible virtualization, IPv4, Python 3 for Ansible, and SSH. For a Contabo Cloud VPS 6 profile start with the recommended 6 vCPU, 12 GB memory and 200 GB SSD tier. The example Hetzner CX23 profile has fewer resources and needs the smaller runner sizing. Look up the current plan, image, location, SSH key IDs, recurring cost, IP costs, tax and provisioning terms in the provider account. [Contabo API](https://api.contabo.com/) · [Hetzner Cloud pricing](https://www.hetzner.com/cloud/)

## Bootstrap and configure

1. Run `hive-runners init` or copy the [fleet example](../examples/hive-runners/fleet.lino). Use distinct fleet prefixes for independent deployments in the same cloud account.
2. Set pool `scope` to `owner/private-repo` for one cluster. For a fleet spanning clusters, set the scope to the organization and list private repositories in `selectedRepositories`. Hive Runners creates a distinct selected-repository runner group per machine. Each pool’s `label` is the ARC runner scale set name and the workflow’s `runs-on` value. [GitHub ARC scale sets](https://docs.github.com/en/actions/how-tos/manage-runners/use-actions-runner-controller/deploy-runner-scale-sets)
3. For the GitHub App path, put the credentials below in `HIVE_ARC_CREDENTIALS` or the environment variable named by `credentialsEnv`. Hive Runners uses an installation token for its API preflight. Set `HIVE_GITHUB_TOKEN` or configure `groupTokenEnv` to use a separate administrative credential. For the PAT or `gh` path, leave `HIVE_ARC_CREDENTIALS` unset. Hive Runners checks `HIVE_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` and `gh auth token --hostname github.com` in that order. The token must have the ARC operations for your scope and access to each private project. Classic PATs require `repo` for repository runners and `admin:org` for organization administration. Check the documented permissions when using a fine-grained PAT. The ARC secret may also be a Links Notation or JSON object with a `github_token` field. [ARC authentication](https://docs.github.com/en/enterprise-cloud%40latest/actions/how-tos/manage-runners/use-actions-runner-controller/authenticate-to-the-api) · [Runner group administration](https://docs.github.com/en/rest/actions/self-hosted-runner-groups) · [gh authentication](https://cli.github.com/manual/gh_auth_token)
4. Set GitHub’s webhook URL to `https://your-host/webhooks/github`, subscribe to **Workflow jobs**, use JSON, and set its shared secret in the environment named by `webhookSecretEnv`, which defaults to `HIVE_WEBHOOK_SECRET`. Give each paid pool a distinct secret. For federation, deliver the same repository job events to both systems with their respective webhook secrets. [Workflow job events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#workflow_job)

```text
(
  github_app_id "APP_ID"
  github_app_installation_id "INSTALLATION_ID"
  github_app_private_key "PEM CONTENT"
)
```

GitHub’s job workflow needs the exact configured scale set name, for example `runs-on: private-builds`. Set `runnerImage` to configure tools and architecture. Prefer a digest for production. The pool’s `containerMode` determines how ARC starts workflow code. [ARC container modes](https://docs.github.com/en/actions/how-tos/manage-runners/use-actions-runner-controller/deploy-runner-scale-sets#configuring-container-mode)

| `containerMode`       | Workload                                                                   | Boundary                                                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `process` (default)   | Shell, composite and JavaScript actions                                    | Non-root runner pod with no Kubernetes token or Docker socket                                                                                                                          |
| `kubernetes-novolume` | Job containers, prebuilt container actions and job service containers      | Requires `jobs.<job_id>.container`. ARC’s runner pod can call the Kubernetes API to create job pods. Job pods have no service account token and private-network egress is restricted.  |
| `dind`                | Workflows requiring Docker, including Dockerfile actions and Docker builds | Privileged Docker sidecar on a dedicated private, trusted host. Paid pools reject this mode. Drain and reimage a host before moving it from this mode into a different trust boundary. |

The Kubernetes hook copies the workspace. Use a job container image with a Linux shell and `tar`. Container actions use separate pods, which cannot share service containers or propagate workspace writes back into the job pod. The hook supports prebuilt action images and ignores Docker create flags. [ARC Kubernetes no-volume hook](https://github.com/actions/runner-container-hooks/tree/main/packages/k8s-novolume)

## Connect GitLab

1. Create a tag-only runner for a private GitLab project or group. Run `hive-runners gitlab-create --scope engineering/private-builds --name gitlab-build` using `HIVE_GITLAB_TOKEN` with the `create_runner` scope and the required role. Store the returned `token` in `HIVE_GITLAB_RUNNER_TOKEN`. Keep command output out of CI logs. Use `gitlab-runners` to list configured runners and `gitlab-tag` to change the tag and turn off untagged jobs. [GitLab runner management](https://docs.gitlab.com/ci/runners/runners_scope/) · [GitLab Runners API](https://docs.gitlab.com/api/runners/)
2. Set the pool’s `platform` to `gitlab`, `scope` to the full project path, `gitlabRunnerId` to the returned numeric ID, and `label` to the configured tag. GitLab jobs select the pool with `tags: [gitlab-build]`. The administrative token used by deployment and webhook verification needs `manage_runner` and read access to project and job data, such as `read_api`. It is stored under `groupTokenEnv`. GitLab private project runners must be locked to that project. For groups, use `gitlabScopeType "group"` and list every private project under the group in `selectedRepositories`, including subgroup-relative paths. GitLab inherits group runners into subgroups. Use a dedicated group and control additions to its membership, or create individual project pools for a narrower boundary. Paid pools use project runners. [GitLab Jobs API](https://docs.gitlab.com/api/jobs/)
3. For autoscaling or metering, point a project or group webhook to `https://your-host/webhooks/gitlab` and enable **Job events**. Put the webhook signing token from GitLab in `HIVE_GITLAB_WEBHOOK_SECRET` or the pool’s `webhookSecretEnv`. GitLab versions without webhook signing use a distinct randomly generated shared secret of at least 32 characters. The control plane verifies signatures and looks up the job’s tag, assigned runner and timestamps before using it for capacity or billing. Jobs targeting Hive use the pool tag as their sole tag. [Job Hook payload](https://docs.gitlab.com/user/project/integrations/webhook_events/) · [GitLab webhook signing](https://docs.gitlab.com/user/project/integrations/webhooks/)
4. For GitLab Self-Managed, set `gitlabUrl` and use the same origin in CLI calls with `--origin`. Set `gitlabEgressIPv4` to the exact reachable addresses when the URL uses a private network or custom HTTPS port. These addresses become reachable from the job pods, so point them at a dedicated GitLab endpoint. For a private CA, make it trusted by the control-plane runtime, for example with `NODE_EXTRA_CA_CERTS`. Set `gitlabCAEnv` to a variable containing the PEM certificate chain for the runner chart. [Configure the GitLab Runner chart](https://docs.gitlab.com/runner/install/kubernetes_helm_chart_configuration/)

The GitLab manager uses the official Helm chart and the Kubernetes executor. It creates a pod per job, with a build container and a helper. The manager remains warm while the pool’s host serves jobs. When draining, the reconciler scales down the manager and waits for the manager to finish active jobs and their pods to disappear. Tokenless job pods have scoped network access and resource quotas. Select `dind` only for trusted single-tenant pools whose scripts set up privileged Docker services themselves. [GitLab Kubernetes executor](https://docs.gitlab.com/runner/executors/kubernetes/) · [GitLab Runner shutdown signals](https://docs.gitlab.com/runner/commands/)

## Size and isolate hosts

`hive-runners capacity` reports the selected job CPU, RAM, ephemeral disk, and exclusive GPU count. CPU uses millicores, RAM and disk use MiB, and GPUs are whole NVIDIA devices. Cluster budgets reserve capacity for Kubernetes, runner managers, helpers and services. The host minimum adds one vCPU, 1 GiB RAM and 4 GiB disk for the host. Recommended capacity adds spare CPU, memory and disk above the minimum and starts at six vCPU, 12 GiB RAM and 200 GiB disk for a single host. Compare the calculated numbers to the plan’s actual units and the free space in its Docker data filesystem.

`isolation "machine"` is the default and the recommended option for third-party code or different customers. Give each customer a dedicated machine, and reimage it before assigning it to a different customer. To share one machine across GitHub and GitLab or multiple pools, choose `isolation "job"` and an unprivileged Kubernetes mode for each pool. Each pool has a separate Minikube profile and cluster credentials, and its jobs run in ephemeral pods with resource requests and limits. Profiles share the host kernel, Docker and physical hardware. Kubernetes ephemeral storage accounts for writable layers, logs and ephemeral volumes. Leave extra filesystem space for image caches and Kubernetes itself. [Kubernetes local ephemeral storage](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/#local-ephemeral-storage)

List co-located pools at the same host address with the same verified SSH trust and `hardware` inventory. Use `hive-runners capacity --shared private-gpu,gitlab-build --config examples/hive-runners/mixed-gpu.lino` to calculate their combined needs. Ansible checks physical CPU, RAM and free Docker filesystem space before installing the cluster. Mix static inventory and contributed profiles in the same fleet configuration and include all static entries in the deployment inventory. Use a single operator and inventory for each physical host so its pools are budgeted together. [Mixed CPU/GPU pools](../examples/hive-runners/mixed-gpu.lino) · [Shared host inventory](../examples/hive-runners/mixed-inventory.example.lino)

### Use a local or VPS GPU

Use a Linux workstation or GPU VPS with functional NVIDIA drivers and the NVIDIA Container Toolkit configured for Docker. Verify `nvidia-smi -L`, then add the host to SSH inventory or set it up as a paid pool’s `spareHost`. Select the job’s GPU count in `job.gpus`, and use `hive-runners capacity` to check that the machine can allocate that count for every concurrent job. Declare a provider plan’s verified hardware if an API-managed pool requires GPUs. The default budget VPS plans are CPU plans. Static inventory and contributed hosts can come from any compatible hosting provider. To avoid exposing the same device to independent schedulers, one profile per machine may own the GPU allocation. [Minikube NVIDIA GPU setup](https://minikube.sigs.k8s.io/docs/tutorials/nvidia/) · [NVIDIA Container Toolkit installation](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)

Ansible starts GPU-enabled Minikube and checks its advertised device capacity. GitHub process runners request GPUs in the runner pod. For GitHub workflows with job containers and for GitLab, select a CUDA-compatible image and the configured pool label or tag. Container images must be compatible with the host driver. The example jobs run `nvidia-smi -L` inside the job container. [GitHub GPU workflow](../examples/hive-runners/gpu.workflow.yml) · [GitLab pipeline](../examples/hive-runners/gitlab-ci.yml)

## Generate, review and deploy

```bash
hive-runners render --config hive-runners.lino
hive-runners proposal --config hive-runners.lino --base main
hive-runners deploy --config hive-managed/config.lino --inventory inventory.lino
```

The generated subtree contains the normalized configuration, Terraform, Ansible playbooks and chart values for GitHub and GitLab. Adjacent Terraform and Ansible trees remain in place. The CLI reads the package’s playbooks. The exported `deploy` and `runnerHost` functions support existing playbooks and scripts. Inspect the Terraform plan in `hive-managed/` and keep its state in protected storage. Run deployments from a protected CI environment after configuration review, with an inventory assembled from trusted provider IPs and SSH fingerprints. The CLI can run `terraform apply` with the explicit `deploy --apply-infra` option. Terraform needs trusted SSH fingerprints when Ansible connects to the new hosts. [Deployment workflow](../examples/hive-runners/deploy.workflow.yml) · [SSH inventory example](../examples/hive-runners/inventory.example.lino)

Terraform manages `terraformMachines`, the baseline. API machines are managed by the reconciler and count against `maxMachines` and the provider cap. Provider API credentials use each provider’s configured `tokenPrefix`.

| Provider      | Environments                                                                         | Example profile                                                                            |
| ------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Contabo       | `CONTABO_CLIENT_ID`, `CONTABO_CLIENT_SECRET`, `CONTABO_USERNAME`, `CONTABO_PASSWORD` | Cloud VPS 6 with the account’s actual product, Ubuntu image IDs and numeric SSH secret IDs |
| Hetzner Cloud | `HETZNER_TOKEN`                                                                      | CX23 with the correct zone, Ubuntu image and SSH key references                            |

Terraform uses the corresponding `TF_VAR_` prefixed values. Contabo cancellation can leave a machine billable for the remainder of its term. The reconcile loop counts such a machine while it remains listed. Configure an appropriate idle window and fleet cap. [Contabo API](https://api.contabo.com/) · [Hetzner Cloud API](https://docs.hetzner.cloud/reference/cloud)

## Run and monitor the control plane

For a local operator deployment, set the environment values in `.env` and run `docker compose up --build`. The service binds to loopback. For Kubernetes, build and publish the image to a registry you control and pass its repository and tag to the chart.

```bash
helm upgrade --install hive charts/hive-runners \
  --set image.repository=registry.example.com/hive-runners \
  --set image.tag=YOUR_IMAGE_TAG \
  --set existingSecret=hive-environment \
  --set sshSecret=hive-ssh \
  --set-file configLino=hive-runners.lino
```

The chart runs one replica and stores the Link CLI ledger on its persistent volume. Configure `HIVE_STATE` with a directory. Stop the instance before restoring or migrating. Set up HTTPS for public webhooks and customers. `HIVE_METRICS_KEY` enables authenticated Prometheus output at `/metrics`. It reports queued and active jobs, baseline and managed machine counts, runner pod counts, memory, free Docker filesystem disk, load, and reconciliation status. GitHub ARC and GitLab Runner manage job pods. The reconciler accounts for pending orders and reserves each private pool’s minimum and one available slot per admitted local paid activation before allocating shared provider quota. It waits for repeated empty observations before retiring a machine and includes unfinished job and action pods in drain checks. [Kubernetes network policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)

### Optional Prometheus and Grafana

Set `HIVE_METRICS_KEY` and `HIVE_GRAFANA_ADMIN_PASSWORD` in the Compose `.env`, then run `docker compose --profile monitoring up --build`. Compose exposes Prometheus on `127.0.0.1:9090` and Grafana on `127.0.0.1:3000`. Grafana provisions the `Hive Runners` dashboard and Prometheus data source. The Compose source includes the scrape interval, retention, dashboard and port configuration.

With Helm and an existing Prometheus Operator, set `monitoring.serviceMonitor.enabled=true`, `monitoring.serviceMonitor.secretName` to a Secret in the release namespace, and `monitoring.serviceMonitor.labels` to match your Prometheus selector. The key defaults to `HIVE_METRICS_KEY` and must contain the same value as the control plane. Enable `monitoring.grafanaDashboard.enabled` to render a dashboard ConfigMap, then configure your Grafana dashboard sidecar to watch its namespace and label. `monitoring.grafanaDashboard.labels` defaults to `grafana_dashboard: '1'`.

Set `HIVE_SSH_PRIVATE_KEY_FILE` to a protected private key, or use an SSH agent. The chart’s optional SSH Secret expects an `identity` key. The API provisions each host with a fresh host key and checks it during SSH. Supply an independently verified `knownHosts` value or an SSH known-hosts file for pre-existing inventory. An ambiguous purchase is retained in state while the reconciler looks for it by its generated name. Inspect the provider account before resolving an indefinitely pending order.

### Upgrade the ledger

For an existing SQLite deployment, stop the old instance cleanly and back up the volume, including any SQLite write-ahead log. Run the migration once with read access to the source and write access to its parent directory. For the container and chart defaults use the following command on the mounted volume.

```bash
hive-runners migrate-state --from /var/lib/hive/runner.sqlite --state /var/lib/hive/ledger
```

The command creates a new destination and preserves the original database. The service detects a legacy file in the previous default location and reports the migration command before serving. Preserve the full ledger directory and its permissions in backups. Following a forced stop, retained `*.writer` markers can prevent reopening. Confirm no old process or pod can access the volume before removing its three writer markers from the ledger directory. Durable data files use the `.links` extension.

### Configure the UI and API clients

Copy any of the packaged `index.lino`, `portal.lino`, `guide.lino`, and `hive.css` assets into a directory and set `HIVE_UI_DIR` to its path. Mount the directory read-only for a container, or set `uiConfigMap` to a Helm release namespace ConfigMap holding those files. Restart to load changes. The pages use link-foundation/ui. Preserve the portal form and element IDs used by its signed-in interactions. The service validates templates at startup and supplies the built-in file for each omitted override. [Default templates and styles](../src/assets/web/)

The CLI writes Links Notation by default. Use `--json` for JSON command output. The account client and portal use `text/vnd.links-notation` for `/v1/` requests. Existing JSON configuration files and JSON clients remain supported. Set a supplier’s `notation` to `json` if it uses JSON. Both sides of a wholesale connection must support resource quotes. GitHub, GitLab, Stripe, Terraform and Grafana use their own required formats.

## Sell runner minutes or procure capacity

Create a dedicated repository pool and account for each customer. Start it at zero baseline machines and zero warm runners. Issue a unique account key at least 32 characters long, and distribute it to the customer privately. Set the rate in integer USD cents per runner minute. The portal accepts the key and lets customers buy credit, start an activation for up to an hour, and end it. The CLI supports the same operations through the `account-*` commands with `HIVE_ACCOUNT_KEY` set. Scripts can use the `runnerAccount` library client.

Credit decreases when a matching GitHub or GitLab job that started during the activation completes. The duration rounds up to the next minute with a one-minute minimum. Idle time carries no execution charge. The selected rate and profile stay fixed for the activation. Include `--max-cents` with `account-activate`, set a spending limit in the portal, or let the available prepaid credit cap the activation. Concurrent and late completions settle atomically against the cap and remaining credit. When the funds are exhausted, the controller stops admitting work and drains running jobs. Supplier webhooks arriving outside the activation window and repeated deliveries cannot charge for the same job.

Set `HIVE_STRIPE_SECRET_KEY`, `HIVE_STRIPE_WEBHOOK_SECRET` and `HIVE_PUBLIC_ORIGIN` to enable credit purchases. Subscribe Stripe to Checkout completion, asynchronous payment success, `charge.refunded`, `charge.dispute.created`, `charge.dispute.funds_withdrawn` and `charge.dispute.funds_reinstated` at `/webhooks/stripe`. Stripe hosts the payment form. Keep the account identity and ledger across upgrades. A refund or chargeback can leave a balance negative after previously purchased credits have been spent. [Stripe Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment) · [Stripe event types](https://docs.stripe.com/api/events/types)

A seller can share provider quota or contribute a Linux host to a prepaid pool. Put its IPv4 address, SSH user and verified Ed25519 public host key in `spareHost` as `ip`, `user`, and `hostKey`, and leave the provider unset. Contributed hardware starts serving on paid demand. After withdrawal, the reconciler drains and parks that pool. With job isolation, it removes only that pool’s profile. Use the same `hardware` inventory across pools sharing the host.

A hub configures upstream HTTPS origins, account keys and wholesale rate ceilings. The supplier must match the platform, origin, repository, tag or label, isolation, execution mode, concurrent runners per machine, and per-job CPU, RAM, disk, and GPUs. GitLab peers also use the same runner ID so the same completed job can settle at each rate. The hub picks the cheapest matching offer and pins that quote through activation, ambiguous requests and drain. It may select another peer after definitive rejection. Authorize peer access and pre-fund the supplier’s account separately from the customer’s retail account.
