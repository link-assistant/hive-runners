# Hive Runners operator guide

## Choose what to deploy

| Mode                    | Configure                                                                   | Where jobs run                                     |
| ----------------------- | --------------------------------------------------------------------------- | -------------------------------------------------- |
| Existing private runner | SSH inventory and a private repository or organization pool                 | Your existing machine                              |
| Private fleet           | One or more private pools, provider credentials and a GitHub webhook        | Terraform and API-managed machines                 |
| Seller                  | A private pool and bearers for each customer, plus optional Stripe Checkout | A dedicated API-managed machine per customer       |
| Hub                     | Customer accounts with upstream offers and optional local provider          | A local dedicated machine or the selected supplier |

Use an Ubuntu 24.04 or Debian host with Docker-compatible virtualization, IPv4, Python 3 for Ansible, and SSH. For a Contabo VPS 20 profile start with the recommended 6 vCPU, 12 GB memory and 200 GB SSD tier. The example Hetzner CX23 profile has fewer resources and needs the smaller runner sizing. Look up the current plan, image, location, SSH key IDs, recurring cost, IP costs, tax and provisioning terms in the provider account. [Contabo VPS specifications](https://docs.contabo.com/docs/products/cloud-vps/) · [Hetzner pricing changes](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)

## Bootstrap and configure

1. Run `hive-runners init` or copy the [fleet example](../examples/hive-runners/fleet.json). Use distinct fleet prefixes for independent deployments in the same cloud account.
2. Set pool `scope` to `owner/private-repo` for one cluster. For a fleet spanning clusters, set the scope to the organization and list private repositories in `selectedRepositories`. Hive Runners creates a distinct selected-repository runner group per machine. Each pool’s `label` is the ARC runner scale set name and the workflow’s `runs-on` value. [GitHub ARC scale sets](https://docs.github.com/en/actions/how-tos/manage-runners/use-actions-runner-controller/deploy-runner-scale-sets)
3. Give each pool a GitHub App confined to its intended scope and store the App credentials in the environment named by `credentialsEnv`. Supply the administrative API token in the environment named by `groupTokenEnv`. Follow GitHub’s installation and permission requirements for the selected scope. A JSON `github_token` is also supported. [ARC authentication](https://docs.github.com/en/enterprise-cloud%40latest/actions/how-tos/manage-runners/use-actions-runner-controller/authenticate-to-the-api) · [Runner group administration](https://docs.github.com/en/rest/actions/self-hosted-runner-groups)
4. Set GitHub’s webhook URL to `https://your-host/webhooks/github`, subscribe to **Workflow jobs**, use JSON, and set its shared secret in `HIVE_WEBHOOK_SECRET`. For federation, deliver the same repository job events to the hub and supplier. [Workflow job events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#workflow_job)

```json
{
  "github_app_id": "APP_ID",
  "github_app_installation_id": "INSTALLATION_ID",
  "github_app_private_key": "PEM CONTENT"
}
```

GitHub’s job workflow needs the exact configured scale set name, for example `runs-on: private-builds`. An ARC pool runs ordinary process-based Actions. Jobs that require container actions, service containers, Docker sockets, nested runners, or public fork code need a separate execution design.

## Generate, review and deploy

```bash
hive-runners render --config hive-runners.json
hive-runners proposal --config hive-runners.json --base main
hive-runners deploy --config hive-managed/config.json --inventory inventory.json
```

The generated subtree contains the normalized configuration, Terraform, Ansible playbook and ARC values. Adjacent Terraform and Ansible trees remain in place. The CLI reads the package’s playbook. The exported `deploy` and `arcHost` functions support integration with existing playbooks and scripts. Inspect the Terraform plan in `hive-managed/` and keep its state in protected storage. Run a deployment from a protected CI environment after the configuration review, with an inventory assembled from trusted provider IPs and SSH fingerprints. The [example Actions workflow](../examples/hive-runners/deploy.workflow.yml) deploys a reviewed change after it reaches the default branch. Copy it into the deployment repository after creating the protected environment, package version variable, inventory and secrets. The CLI can run `terraform apply` with the explicit `deploy --apply-infra` option. Terraform needs trusted SSH fingerprints available when Ansible connects to the new hosts. [SSH inventory example](../examples/hive-runners/inventory.example.json)

Terraform manages `terraformMachines`, the baseline. API machines are managed by the reconciler and count against `maxMachines` and the provider cap. Provider API credentials use each provider’s configured `tokenPrefix`.

| Provider      | Environments                                                                         | Example profile                                                                       |
| ------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Contabo       | `CONTABO_CLIENT_ID`, `CONTABO_CLIENT_SECRET`, `CONTABO_USERNAME`, `CONTABO_PASSWORD` | VPS 20 with the account’s actual product, Ubuntu image IDs and numeric SSH secret IDs |
| Hetzner Cloud | `HETZNER_TOKEN`                                                                      | CX23 with the correct zone, Ubuntu image and SSH key references                       |

Terraform uses the corresponding `TF_VAR_` prefixed values. Contabo cancellation can leave a machine billable for the remainder of its term. The reconcile loop counts such a machine while it remains listed. Configure an appropriate idle window and fleet cap. [Contabo API](https://api.contabo.com/) · [Hetzner Cloud API](https://docs.hetzner.cloud/reference/cloud)

## Run and monitor the control plane

For a local operator deployment, set the environment values in `.env` and run `docker compose up --build`. The service binds to loopback. For Kubernetes, build and publish the image to a registry you control and pass its repository and tag to the chart.

```bash
helm upgrade --install hive charts/hive-runners \
  --set image.repository=registry.example.com/hive-runners \
  --set image.tag=YOUR_IMAGE_TAG \
  --set existingSecret=hive-environment \
  --set sshSecret=hive-ssh \
  --set-file configJSON=hive-runners.json
```

The chart stores the SQLite ledger on a persistent volume and starts one replica. Preserve the database, protect its backups and stop the old instance before restoring or migrating it. Set up HTTPS for public webhooks and customers. Set `HIVE_METRICS_KEY` to expose authenticated Prometheus text at `/metrics`. It reports queued and active jobs, baseline and managed machine counts, runner pod counts, memory, load and the last reconciliation status. The scale-up calculation uses GitHub job demand and configured capacity. ARC controls runner pods on each machine. The reconciler leaves a drain window and waits for repeated empty observations before retiring a machine. [Kubernetes network policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)

Set `HIVE_SSH_PRIVATE_KEY_FILE` to a protected private key, or use an SSH agent. The chart’s optional SSH Secret expects an `identity` key. The API provisions each host with a fresh host key and checks it during SSH. Supply an independently verified `knownHosts` value or an SSH known-hosts file for pre-existing inventory. An ambiguous purchase is retained in state while the reconciler looks for it by its generated name. Inspect the provider account before resolving an indefinitely pending order.

## Sell runner minutes or procure capacity

Create a dedicated repository pool and account for each customer. Start it at zero baseline machines and zero warm runners. Issue a unique account key at least 32 characters long, and distribute it to the customer privately. Set the rate in integer USD cents per runner minute. The portal accepts the key and lets customers buy credit, start an activation for up to an hour, and end it. Credit decreases when a matching ARC job completes, rounded up to the next minute with a one-minute minimum. Repeated webhook deliveries and unsettled payments leave the ledger unchanged. An in-progress job can finish after an activation expires or credit is depleted, so the account can have a negative balance.

Set `HIVE_STRIPE_SECRET_KEY`, `HIVE_STRIPE_WEBHOOK_SECRET` and `HIVE_PUBLIC_ORIGIN` to enable credit purchases. Subscribe Stripe to Checkout completion, asynchronous payment success, charge refunds and dispute creation at `/webhooks/stripe`. Stripe hosts the payment form. Keep the same account identity and SQLite ledger across upgrades. [Stripe Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment) · [Stripe webhooks](https://docs.stripe.com/webhooks)

A seller shares available fleet quota with prepaid accounts while preserving machine and repository isolation. A hub adds upstream HTTPS origins, keys and wholesale rate ceilings to customer accounts. The supplier needs the same repository and runner label, its own account key, prepaid credit and permission to deploy ARC. The hub checks offers from configured peers, selects the cheapest match and holds the selected peer through activation and withdrawal. Upstream capacity requires bilateral configuration. Automatic supplier onboarding, payouts and cross-tenant reuse of running machines are open scope.
