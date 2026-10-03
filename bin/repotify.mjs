#!/usr/bin/env node
import { main, quietPipes } from "../src/cli.mjs";

quietPipes(process.stdout, process.stderr);
const code = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
});
process.exitCode = code;
// The command is done. Connections the catalog or a download left open (kept alive by the HTTP client, longer behind
// a proxy) would hold the process for seconds to minutes after its output was complete. Exit once both streams have
// taken everything written to them; an empty write's callback runs after the data queued before it.
const flushed = (stream) => new Promise((done) => {
  if (stream.destroyed || stream.writableEnded) done();
  else stream.write("", () => done());
});
await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
process.exit(code);
