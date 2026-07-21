// electron-builder afterAllArtifactBuild hook: copy the finished installer
// exe to the user's share folder so it's always ready to send to others.
const fs = require('fs');
const path = require('path');

const DEST = 'C:\\Users\\Alexj\\Documents\\day';

exports.default = function (buildResult) {
  // Windows-only convenience (copies the .exe to a local share folder). On the
  // Linux CI runner there's no such path and no .exe — skip entirely.
  if (process.platform !== 'win32') return [];
  fs.mkdirSync(DEST, { recursive: true });
  const copied = [];
  for (const file of buildResult.artifactPaths) {
    if (file.toLowerCase().endsWith('.exe')) {
      const target = path.join(DEST, path.basename(file));
      fs.copyFileSync(file, target);
      copied.push(target);
    }
  }
  if (copied.length) console.log('  • copied installer to ' + DEST);
  return copied;
};
