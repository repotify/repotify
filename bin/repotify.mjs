#!/usr/bin/env node
import { main, quietPipes } from "../src/cli.mjs";

quietPipes(process.stdout, process.stderr);
process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
});
