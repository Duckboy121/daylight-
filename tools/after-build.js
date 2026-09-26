// electron-builder afterAllArtifactBuild hook: copy every Windows update
// deliverable to the user's share folder, ready for local testing or sharing.
const fs = require('fs');
const path = require('path');

const DEST = 'C:\\Users\\Alexj\\Documents\\day';

exports.default = function (buildResult) {
  // Windows-only convenience (copies the .exe to a local share folder). On the
  // Linux CI runner there's no such path and no .exe — skip entirely.
  if (process.platform !== 'win32') return [];
  fs.mkdirSync(DEST, { recursive: true });
  const copied = [];
  const copy = file => {
    const target = path.join(DEST, path.basename(file));
    fs.copyFileSync(file, target);
    copied.push(target);
  };
  for (const file of buildResult.artifactPaths) {
    if (/\.(exe|blockmap)$/i.test(file)) {
      copy(file);
      // electron-builder does not always list the update manifest as an
      // artifact, but it is emitted beside the Windows installer.
      const manifest = path.join(path.dirname(file), 'latest.yml');
      if (fs.existsSync(manifest) && !copied.some(p => path.basename(p) === 'latest.yml')) copy(manifest);
    }
  }
  if (copied.length) console.log('Copied update files to ' + DEST);
  return copied;
};
