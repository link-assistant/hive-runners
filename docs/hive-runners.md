# Hive Runners operator guide

## Choose what to deploy

| Mode                    | Configure                                                                   | Where jobs run                                              |
| ----------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Existing private runner | SSH inventory and a private repository or organization pool                 | Your existing machine                                       |
| Private fleet           | One or more private pools, provider credentials and a GitHub webhook        | Terraform and API-managed machines                          |
| Seller                  | A private pool and bearers for each customer, plus optional Stripe Checkout | A dedicated API-managed or contributed machine per customer |
| Hub                     | Customer accounts with upstream offers and optional local provider          | A local dedicated machine or the selected supplier          |

Use an Ubuntu 24.04 or Debian host with Docker-compatible virtualization, IPv4, Python 3 for Ansible, and SSH. For a Contabo Cloud VPS 6 profile start with the recommended 6 vCPU, 12 GB memory and 200 GB SSD tier. The example Hetzner CX23 profile has fewer resources and needs the smaller runner sizing. Look up the current plan, image, location, SSH key IDs, recurring cost, IP costs, tax and provisioning terms in the provider account. [Contabo API](https://api.contabo.com/) · [Hetzner Cloud pricing](https://www.hetzner.com/cloud/)

## Bootstrap and configure

1. Run `hive-runners init` or copy the [fleet example](../examples/hive-runners/fleet.lino). Use distinct fleet prefixes for independent deployments in the same cloud account.
2. Set pool `scope` to `owner/private-repo` for one cluster. For a fleet spanning clusters, set the scope to the organization and list private repositories in `selectedRepositories`. Hive Runners creates a distinct selected-repository runner group per machine. Each pool’s `label` is the ARC runner scale set name and the workflow’s `runs-on` value. [GitHub ARC scale sets](https://docs.github.com/en/actions/how-tos/manage-runners/use-actions-runner-controller/deploy-runner-scale-sets)
3. Give each pool a GitHub App confined to its intended scope and store the App credentials in the environment named by `credentialsEnv`. Supply the administrative API token in the environment named by `groupTokenEnv`. Follow GitHub’s installation and permission requirements for the selected scope. The credential object can also contain a single `github_token` field. [ARC authentication](https://docs.github.com/en/enterprise-cloud%40latest/actions/how-tos/manage-runners/use-actions-runner-controller/authenticate-to-the-api) · [Runner group administration](https://docs.github.com/en/rest/actions/self-hosted-runner-groups)
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

## Generate, review and deploy

```bash
hive-runners render --config hive-runners.lino
hive-runners proposal --config hive-runners.lino --base main
hive-runners deploy --config hive-managed/config.lino --inventory inventory.lino
```

The generated subtree contains the normalized configuration, Terraform, Ansible playbook and ARC values. Adjacent Terraform and Ansible trees remain in place. The CLI reads the package’s playbook. The exported `deploy` and `arcHost` functions support integration with existing playbooks and scripts. Inspect the Terraform plan in `hive-managed/` and keep its state in protected storage. Run a deployment from a protected CI environment after the configuration review, with an inventory assembled from trusted provider IPs and SSH fingerprints. The [example Actions workflow](../examples/hive-runners/deploy.workflow.yml) deploys a reviewed change after it reaches the default branch. Copy it into the deployment repository after creating the protected environment, package version variable, inventory and secrets. The CLI can run `terraform apply` with the explicit `deploy --apply-infra` option. Terraform needs trusted SSH fingerprints available when Ansible connects to the new hosts. [SSH inventory example](../examples/hive-runners/inventory.example.lino)

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

The chart runs one replica and stores the Link CLI ledger on its persistent volume. Configure `HIVE_STATE` with a directory. Stop the instance before restoring or migrating. Set up HTTPS for public webhooks and customers. `HIVE_METRICS_KEY` enables authenticated Prometheus output at `/metrics`. It reports queued and active jobs, baseline and managed machine counts, runner pod counts, memory, load, and reconciliation status. ARC controls runner pods on each machine. The reconciler waits for repeated empty observations before retiring a machine. In Kubernetes mode it also checks unfinished job and action pods. [Kubernetes network policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)

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

The CLI writes Links Notation by default. Use `--json` for JSON command output. The account client and portal use `text/vnd.links-notation` for `/v1/` requests. Existing JSON configuration files and JSON clients remain supported. Set a supplier’s `notation` to `json` when it runs the previous API. GitHub, Stripe, Terraform, and the Grafana dashboard keep the formats those systems require.

## Sell runner minutes or procure capacity

Create a dedicated repository pool and account for each customer. Start it at zero baseline machines and zero warm runners. Issue a unique account key at least 32 characters long, and distribute it to the customer privately. Set the rate in integer USD cents per runner minute. The portal accepts the key and lets customers buy credit, start an activation for up to an hour, and end it. The CLI supports the same operations through the `account-*` commands with `HIVE_ACCOUNT_KEY` set. Scripts can use the `runnerAccount` library client.

Credit decreases when a matching ARC job that started during the customer's activation completes. The duration rounds up to the next minute with a one-minute minimum. An idle supplier ignores job usage during gaps in its activations, even when it receives the same webhook as the selected supplier. Repeated webhook deliveries and unsettled payments leave the ledger unchanged. An in-progress job can finish after its activation ends or credit is depleted, so the account can have a negative balance.

Set `HIVE_STRIPE_SECRET_KEY`, `HIVE_STRIPE_WEBHOOK_SECRET` and `HIVE_PUBLIC_ORIGIN` to enable credit purchases. Subscribe Stripe to Checkout completion, asynchronous payment success, charge refunds and dispute creation at `/webhooks/stripe`. Stripe hosts the payment form. Keep the same account identity and persistent ledger across upgrades. [Stripe Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment) · [Stripe webhooks](https://docs.stripe.com/webhooks)

A seller can share available fleet quota or contribute an idle machine to a prepaid pool. To contribute an existing dedicated Ubuntu host, put its IPv4 address, SSH user and verified Ed25519 host public key in the paid repository pool’s `spareHost` object as `ip`, `user`, and `hostKey`. Leave the provider unset. The host starts serving only after paid job demand, then the reconciler drains ARC and removes its runner set and credential secret when the activation ends. Keep a contributed host dedicated to one tenant for its lifetime, or reimage it before assigning it to another tenant. A hub adds upstream HTTPS origins, keys and wholesale rate ceilings to customer accounts. The supplier needs the same repository and runner label, its own account key, prepaid credit and permission to deploy ARC. The hub checks offers from configured peers, tries the cheapest match first and can switch suppliers after a definitive rejection. It holds the selected peer through an accepted activation, an ambiguous request or withdrawal. Upstream capacity requires bilateral configuration. Suppliers settle through prepaid accounts, and operators authorize peers before automatic selection. Concurrent jobs from separate tenants require separate hosts.
