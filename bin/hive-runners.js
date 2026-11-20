#!/usr/bin/env node

import { runHiveCli } from '../src/cli.js';

process.exitCode = await runHiveCli(process.argv.slice(2));
