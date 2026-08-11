// Anything Cizi Code fetches or hands to the shell is executable code or a
// download target, so the scheme is asserted rather than assumed. Two callers
// need this - the updater and the Claude Code installer - which is exactly why
// it lives in one place instead of being re-written in each.
function assertHttpsUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error(`${label} is not valid.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS.`);
  }
  return parsed.toString();
}

module.exports = { assertHttpsUrl };
