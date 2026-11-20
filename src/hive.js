export * from './index.js';
export { runnerAccount } from './account.js';
export { validateConfig, loadConfig } from './config.js';
export { githubClient, githubToken } from './github.js';
export { gitlabClient, gitlabValues } from './gitlab.js';
export { providerClient } from './providers.js';
export { arcValues, arcHost, runnerHost } from './arc.js';
export {
  terraformPlan,
  capacityPlan,
  renderInfrastructure,
  deploy,
} from './infrastructure.js';
export { propose } from './proposal.js';
export { runHiveCli, cliReference } from './cli.js';

export async function serve(config, options) {
  const control = await import('./control/server.js');
  return control.serve(config, options);
}

export async function migrateState(source, destination) {
  const { migrateState: migrate } = await import('./control/migrate.js');
  return migrate(source, destination);
}
