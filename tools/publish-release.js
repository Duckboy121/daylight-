// Publishes the draft release electron-builder just created.
// Handles the electron-builder quirk of creating duplicate drafts for one tag:
// consolidates assets onto the complete draft, deletes the rest, publishes.
//
// Usage:  set GH_TOKEN, then:  node tools/publish-release.js
const fs = require('fs');
const path = require('path');

const OWNER = 'Duckboy121';
const REPO = 'daylight-';
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) { console.error('GH_TOKEN not set'); process.exit(1); }

const version = require('../package.json').version;
const tag = 'v' + version;

const gh = async (url, opts = {}) => {
  const res = await fetch(url.startsWith('http') ? url : `https://api.github.com/repos/${OWNER}/${REPO}${url}`, {
    ...opts,
    headers: {
      Authorization: `token ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      ...(opts.headers || {})
    }
  });
  if (opts.method === 'DELETE') return null;
  return res.json();
};

async function main() {
  const releases = await gh('/releases');
  const drafts = releases.filter(r => r.tag_name === tag && r.draft);
  if (!drafts.length) { console.log(`no draft found for ${tag} — nothing to do`); return; }

  // the "complete" draft is the one carrying latest.yml
  let main = drafts.find(r => r.assets.some(a => a.name === 'latest.yml'));
  if (!main) { console.error('no draft has latest.yml — aborting'); process.exit(1); }

  // move any assets that only exist on duplicate drafts (e.g. the blockmap)
  for (const dup of drafts.filter(r => r.id !== main.id)) {
    for (const asset of dup.assets) {
      if (main.assets.some(a => a.name === asset.name)) continue;
      const local = path.join(__dirname, '..', 'dist', asset.name.replace(/-/g, ' ').replace(' Setup ', ' Setup '));
      // prefer the local dist copy (identical bytes) for re-upload
      const distFile = fs.readdirSync(path.join(__dirname, '..', 'dist'))
        .find(f => f.replace(/\s/g, '-') === asset.name || f === asset.name);
      if (!distFile) { console.log(`  ! ${asset.name} not in dist, skipping`); continue; }
      const data = fs.readFileSync(path.join(__dirname, '..', 'dist', distFile));
      await fetch(`https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${main.id}/assets?name=${encodeURIComponent(asset.name)}`, {
        method: 'POST',
        headers: { Authorization: `token ${TOKEN}`, 'Content-Type': 'application/octet-stream' },
        body: data
      });
      console.log(`  moved ${asset.name} -> main draft`);
    }
    await gh(`/releases/${dup.id}`, { method: 'DELETE' });
    console.log(`  deleted duplicate draft ${dup.id}`);
  }

  const published = await gh(`/releases/${main.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft: false, name: `Daylight ${version}` })
  });
  console.log(`published ${published.tag_name} at ${published.html_url}`);
}

main().catch(e => { console.error(e); process.exit(1); });
