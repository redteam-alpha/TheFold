// SPDX-License-Identifier: AGPL-3.0-or-later
import { runCli } from './cli.js';

process.exitCode = await runCli(process.argv.slice(2));
