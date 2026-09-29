// Feedback timing: weekly vote prompts and the "still installed after 7 days" signal.
const DAY = 86400000;

export function voteDue(config, now = new Date()) {
  if (!config.lastVoteAskAt) return true;
  return now - new Date(config.lastVoteAskAt) >= 7 * DAY;
}

export function keptEvents(lock, config, now = new Date()) {
  const reported = new Set(config.keptReported ?? []);
  const due = Object.entries(lock.items ?? {})
    .filter(([id, e]) => e.type !== "self" && e.installedAt && !reported.has(id) && now - new Date(e.installedAt) >= 7 * DAY)
    .map(([id]) => id)
    .sort();
  return { events: due.length ? [{ type: "kept7d", items: due }] : [], reported: [...reported, ...due] };
}
