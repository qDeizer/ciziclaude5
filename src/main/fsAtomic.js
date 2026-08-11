// Write-and-replace for files whose loss would cost the user something.
//
// Cizi Code edits configuration files that belong to other applications, and it
// stores the only copy of what those files looked like before. A plain
// writeFileSync truncates the target first: a process that dies mid-write leaves
// a half file, and if that file is the backup, the user's original settings are
// gone for good. Writing to a sibling temporary file and renaming it over the
// target makes the replacement a single filesystem operation - readers see
// either the old bytes or the new ones, never half of either.
const fs = require("fs");
const path = require("path");

function temporaryPathFor(filePath) {
  // Same directory, so the rename never crosses a volume boundary (which would
  // silently degrade into a copy and lose atomicity).
  return `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
}

function writeFileAtomic(filePath, data, encoding = "utf8") {
  const target = String(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = temporaryPathFor(target);
  try {
    fs.writeFileSync(temporary, data, Buffer.isBuffer(data) ? undefined : encoding);
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* the partial file is already unreachable */ }
    throw error;
  }
  return target;
}

function writeJsonAtomic(filePath, value) {
  return writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

module.exports = { writeFileAtomic, writeJsonAtomic };
