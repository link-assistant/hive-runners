/**
 * Example module entry point
 * Replace this with your actual implementation
 */

/**
 * Example function that adds two numbers
 * @param {number} a - First number
 * @param {number} b - Second number
 * @returns {number} Sum of a and b
 */
export const add = (a, b) => a + b;

/**
 * Example function that multiplies two numbers
 * @param {number} a - First number
 * @param {number} b - Second number
 * @returns {number} Product of a and b
 */
export const multiply = (a, b) => a * b;

/**
 * Example async function
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
export const delay = (ms) =>
  new Promise((resolve) => globalThis.setTimeout(resolve, ms));

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
