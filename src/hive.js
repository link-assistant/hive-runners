export * from './index.js';
export { validateConfig, loadConfig } from './config.js';
export { githubClient } from './github.js';
export { providerClient } from './providers.js';
export { arcValues, arcHost } from './arc.js';
export {
  terraformPlan,
  renderInfrastructure,
  deploy,
} from './infrastructure.js';
export { propose } from './proposal.js';
export { runHiveCli, cliReference } from './cli.js';

export async function serve(config, options) {
  const control = await import('./control/server.js');
  return control.serve(config, options);
}
