// What the pipeline scripts share on the command line: `--name value` flags and timestamped progress on stderr.

// The value after `name`, or `fallback` when the flag is absent.
export const flag = (args, name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);

export const logStamped = (message) => console.error(`${new Date().toISOString()} ${message}`);
