// 8b leaderboard gate (server side of DL-021 / DL-045).
//
// The effectiveness leaderboard stays behind the feature flag until the fleet
// crosses FLEET_INSTALL_THRESHOLD cumulative installs. "Installs" here is the
// admitted-sync count (each sync comes from one install; the server never
// learns which). The client and the site build read the same frozen constant.

import { FLEET_INSTALL_THRESHOLD } from "./thresholds.mjs";

export function computeLeaderboardStatus(snapshot, { threshold = FLEET_INSTALL_THRESHOLD } = {}) {
  const installs = snapshot.admitted_syncs ?? 0;
  return {
    enabled: installs >= threshold,
    installs,
    threshold,
  };
}
