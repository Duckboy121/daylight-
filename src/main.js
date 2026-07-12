const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const { autoUpdater } = require('electron-updater');

// Canonicalize the game root to its real on-disk path. Under a Windows
// AppContainer, %APPDATA% is redirected (e.g. to LocalCache\Roaming); if we
// hand MCLC the un-redirected path, the classpath strings won't match the
// paths the JVM actually loads jars from, and Fabric Loader 0.16+ then fails
// to recognize its own libraries (sponge-mixin etc.) — every mod's mixin
// plugin dies with a "loader 'knot' vs 'app'" ClassCastException. realpath
// is a harmless no-op when there's no redirection.
function resolveGameRoot() {
  const raw = path.join(app.getPath('appData'), '.daylight');
  try {
    fs.mkdirSync(raw, { recursive: true });
    // Under AppContainer redirection, realpath of a *directory* returns the
    // un-redirected path, but realpath of a *file* returns the real location
    // the JVM will actually load from. Probe with a file and take its dirname.
    const probe = path.join(raw, '.pathprobe');
    fs.writeFileSync(probe, '');
    const real = path.dirname(fs.realpathSync.native(probe));
    fs.rmSync(probe, { force: true });
    return real;
  } catch {
    return raw;
  }
}

const GAME_ROOT = resolveGameRoot();
const PACKS_ROOT = path.join(GAME_ROOT, 'packs');
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const BUNDLED_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'bundled')
  : path.join(__dirname, '..', 'bundled');

const FABRIC_META = 'https://meta.fabricmc.net/v2';
const MODRINTH_API = 'https://api.modrinth.com/v2';

// Default MC version for packs (matches the user's server).
const DEFAULT_MC_VERSION = '1.21.11';

// The built-in Daylight mod's filename in a pack's mods folder. It is
// protected from deletion in the UI.
const DAYLIGHT_JAR = 'daylight-mod.jar';

// The Daylight mod is compiled per MC version. Any `daylight-mod-<version>.jar`
// present in the bundled folder is automatically available, so adding a new
// version build needs no code change here.
function modBuildFor(version) {
  const jar = `daylight-mod-${version}.jar`;
  return fs.existsSync(path.join(BUNDLED_DIR, jar)) ? jar : null;
}

// Client-side performance mods (Modrinth slugs) — Sodium & friends are where
// the real FPS gains come from.
const PERF_MODS = ['fabric-api', 'sodium', 'lithium', 'ferrite-core', 'entityculling', 'immediatelyfast', 'krypton'];

// Tuned G1GC flags for smoother frametimes than JVM defaults.
const JVM_FLAGS = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=50',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:G1NewSizePercent=20',
  '-XX:G1ReservePercent=20',
  '-XX:G1HeapRegionSize=32M',
  '-XX:+AlwaysPreTouch'
];

// Every pack — built-in and custom — includes the Daylight mod and the
// performance mod set as a baseline.
const BUILTIN_PACKS = {
  daylight: {
    name: 'Daylight',
    desc: 'Daylight modules, emotes & FPS boost'
  }
};

let win = null;
let minecraftToken = null;
let gameRunning = false;

// ---------- config ----------

const defaultConfig = {
  selectedPack: 'daylight',
  packs: {},            // per-pack state: { version, name?, custom? }
  minRam: 2,
  maxRam: 4,
  javaPath: '',
  azureClientId: '',
  accounts: [],         // [{ uuid, name, refreshToken }]
  activeUuid: ''
};

function readConfigFile(p) {
  const raw = fs.readFileSync(p, 'utf8');
  if (!raw.trim()) throw new Error('empty config');
  return JSON.parse(raw);
}

// Re-registers any custom pack whose folder exists on disk but is missing
// from config — so packs survive even if the config is ever lost/reset.
function recoverOrphanPacks(cfg) {
  let recovered = 0;
  try {
    if (!fs.existsSync(PACKS_ROOT)) return 0;
    for (const dir of fs.readdirSync(PACKS_ROOT)) {
      if (!dir.startsWith('custom-')) continue;
      if (cfg.packs[dir]?.custom) continue;
      const full = path.join(PACKS_ROOT, dir);
      if (!fs.statSync(full).isDirectory()) continue;
      let version = DEFAULT_MC_VERSION;
      try {
        const man = JSON.parse(fs.readFileSync(path.join(full, 'installed.json'), 'utf8'));
        if (man.mcVersion) version = man.mcVersion;
      } catch { /* no manifest — use default version */ }
      cfg.packs[dir] = { custom: true, name: dir.replace(/^custom-/, ''), version };
      recovered++;
    }
  } catch { /* ignore */ }
  return recovered;
}

function loadConfig() {
  // Prefer the live config, fall back to the last-good backup if the live one
  // is corrupt/truncated (e.g. an unclean shutdown mid-write).
  let parsed = null;
  let usedBackup = false;
  try {
    parsed = readConfigFile(CONFIG_PATH);
  } catch {
    try { parsed = readConfigFile(CONFIG_PATH + '.bak'); usedBackup = true; } catch { /* both gone */ }
  }
  const cfg = { ...defaultConfig, ...(parsed || {}) };
  cfg.packs = cfg.packs || {};

  const recovered = recoverOrphanPacks(cfg);

  // selected pack may be gone (removed builtin or deleted custom pack)
  if (!BUILTIN_PACKS[cfg.selectedPack] && !cfg.packs[cfg.selectedPack]?.custom) {
    cfg.selectedPack = 'daylight';
  }

  // Repair the live config file whenever we recovered packs, fell back to the
  // backup, or had nothing readable at all.
  if (recovered > 0 || usedBackup || parsed === null) {
    try { saveConfig(cfg); } catch { /* ignore */ }
  }
  return cfg;
}

// Atomic write (temp + rename) with a rolling backup so a crash mid-write can
// never leave a truncated config.
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const data = JSON.stringify(cfg, null, 2);
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, data);
  try {
    if (fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak');
  } catch { /* backup is best-effort */ }
  fs.renameSync(tmp, CONFIG_PATH); // atomic replace on the same volume
}

let config = null;

// ---------- java provisioning ----------

const RUNTIME_DIR = path.join(GAME_ROOT, 'runtime');

// Which Java major an MC version needs.
function requiredJavaFor(mcVersion) {
  const head = Number(mcVersion.split('.')[0]);
  if (head >= 26) return 25;                    // year-based versions (26.x+)
  const m = mcVersion.match(/^1\.(\d+)(?:\.(\d+))?/);
  if (!m) return 21;
  const minor = Number(m[1]);
  const patch = Number(m[2] || 0);
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 17) return 17;
  return 8;
}

// Newest system JDK that satisfies the requirement. Old MC (Java 8 era)
// breaks on modern JVMs, so for those only an exact major counts.
function findSystemJava(need) {
  const roots = ['C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Java',
    'C:\\Program Files\\Microsoft', 'C:\\Program Files\\Zulu'];
  let best = null;
  let bestVer = 0;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      const m = dir.match(/jdk-?(\d+)|jre-?(\d+)/i);
      if (!m) continue;
      const ver = Number(m[1] || m[2]);
      const ok = need >= 17 ? ver >= need : ver === need;
      if (!ok) continue;
      const exe = path.join(root, dir, 'bin', 'javaw.exe');
      if (ver > bestVer && fs.existsSync(exe)) {
        bestVer = ver;
        best = exe;
      }
    }
  }
  return best;
}

// A runtime we downloaded ourselves lives under runtime/jdk-<major>/…/bin/javaw.exe
function findManagedJava(need) {
  const base = path.join(RUNTIME_DIR, `jdk-${need}`);
  if (!fs.existsSync(base)) return null;
  const direct = path.join(base, 'bin', 'javaw.exe');
  if (fs.existsSync(direct)) return direct;
  for (const dir of fs.readdirSync(base)) {
    const nested = path.join(base, dir, 'bin', 'javaw.exe');
    if (fs.existsSync(nested)) return nested;
  }
  return null;
}

function extractZip(zip, dest) {
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {
    // Windows 10+ ships bsdtar, which reads zips; PowerShell is the fallback.
    execFile('tar', ['-xf', zip, '-C', dest], err => {
      if (!err) return resolve();
      execFile('powershell', ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath "${zip}" -DestinationPath "${dest}" -Force`],
        err2 => err2 ? reject(new Error('Could not extract Java runtime: ' + err2.message)) : resolve());
    });
  });
}

// Returns a javaw.exe suitable for the given MC version, downloading a JRE
// from Adoptium if the machine has nothing suitable — so a fresh PC can
// install, log in and play with zero setup.
async function ensureJava(mcVersion, progress) {
  if (config.javaPath) return config.javaPath;
  const need = requiredJavaFor(mcVersion);
  const found = findSystemJava(need) || findManagedJava(need);
  if (found) return found;

  progress(`Downloading Java ${need}`, 0, 1);
  const url = `https://api.adoptium.net/v3/binary/latest/${need}/ga/windows/x64/jre/hotspot/normal/eclipse`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Java ${need} download failed (HTTP ${res.status}) — set a Java path in Settings`);
  const total = Number(res.headers.get('content-length')) || 0;

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const zipPath = path.join(RUNTIME_DIR, `jre-${need}.zip`);
  const out = fs.createWriteStream(zipPath);
  let got = 0;
  for await (const chunk of res.body) {
    got += chunk.length;
    out.write(chunk);
    if (total) progress(`Downloading Java ${need}`, got, total);
  }
  await new Promise(r => out.end(r));

  progress(`Installing Java ${need}`, 1, 1);
  const destDir = path.join(RUNTIME_DIR, `jdk-${need}`);
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  await extractZip(zipPath, destDir);
  fs.rmSync(zipPath, { force: true });

  const exe = findManagedJava(need);
  if (!exe) throw new Error('Java install failed — set a Java path in Settings');
  return exe;
}

// ---------- auth ----------

function makeAuthManager() {
  if (config.azureClientId) {
    return new Auth({
      client_id: config.azureClientId,
      redirect: 'http://localhost',
      prompt: 'select_account'
    });
  }
  return new Auth('select_account');
}

function profileFromToken(token) {
  return { name: token.profile.name, uuid: token.profile.id };
}

function accountByUuid(uuid) {
  return config.accounts.find(a => a.uuid === uuid);
}

// Accounts shown to the renderer never include the refresh token.
function listAccounts() {
  return config.accounts.map(a => ({
    uuid: a.uuid,
    name: a.name,
    active: a.uuid === config.activeUuid
  }));
}

// Opens the Microsoft login popup and stores the account (or updates it if the
// same account logs in again), making it the active one.
async function addAccount() {
  const authManager = makeAuthManager();
  const xboxManager = await authManager.launch('electron');
  minecraftToken = await xboxManager.getMinecraft();
  const profile = profileFromToken(minecraftToken);
  const refreshToken = xboxManager.save();
  const existing = accountByUuid(profile.uuid);
  if (existing) {
    existing.name = profile.name;
    existing.refreshToken = refreshToken;
  } else {
    config.accounts.push({ uuid: profile.uuid, name: profile.name, refreshToken });
  }
  config.activeUuid = profile.uuid;
  saveConfig(config);
  return profile;
}

// Silently re-authenticates a stored account and makes it active.
async function switchAccount(uuid) {
  const acc = accountByUuid(uuid);
  if (!acc) throw new Error('Unknown account');
  const authManager = makeAuthManager();
  const xboxManager = await authManager.refresh(acc.refreshToken);
  minecraftToken = await xboxManager.getMinecraft();
  acc.refreshToken = xboxManager.save();
  acc.name = minecraftToken.profile.name;
  config.activeUuid = uuid;
  saveConfig(config);
  return profileFromToken(minecraftToken);
}

function removeAccount(uuid) {
  config.accounts = config.accounts.filter(a => a.uuid !== uuid);
  if (config.activeUuid === uuid) {
    config.activeUuid = config.accounts[0]?.uuid || '';
    minecraftToken = null;
  }
  saveConfig(config);
}

async function trySilentLogin() {
  // Migrate a pre-2.1 single-account config (refreshToken field) into the
  // accounts list, so updating the app never logs anyone out.
  if (!config.activeUuid && config.refreshToken) {
    try {
      const xboxManager = await makeAuthManager().refresh(config.refreshToken);
      minecraftToken = await xboxManager.getMinecraft();
      const profile = profileFromToken(minecraftToken);
      config.accounts.push({
        uuid: profile.uuid,
        name: profile.name,
        refreshToken: xboxManager.save()
      });
      config.activeUuid = profile.uuid;
      delete config.refreshToken;
      saveConfig(config);
      return profile;
    } catch {
      delete config.refreshToken;
      saveConfig(config);
      return null;
    }
  }

  if (!config.activeUuid) return null;
  try {
    return await switchAccount(config.activeUuid);
  } catch {
    return null; // token expired/revoked — user re-adds the account
  }
}

// ---------- fabric / versions ----------

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function getGameVersions() {
  const versions = await fetchJson(`${FABRIC_META}/versions/game`);
  return versions.filter(v => v.stable).map(v => v.version);
}

async function getLatestLoader() {
  const loaders = await fetchJson(`${FABRIC_META}/versions/loader`);
  const stable = loaders.find(l => l.stable) || loaders[0];
  return stable.version;
}

async function ensureFabricProfile(mcVersion) {
  const loaderVersion = await getLatestLoader();
  const id = `fabric-loader-${loaderVersion}-${mcVersion}`;
  const jsonPath = path.join(GAME_ROOT, 'versions', id, `${id}.json`);
  if (!fs.existsSync(jsonPath)) {
    const profile = await fetchJson(
      `${FABRIC_META}/versions/loader/${mcVersion}/${loaderVersion}/profile/json`
    );
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(profile, null, 2));
  }
  return id;
}

// ---------- packs ----------

function packDef(id) {
  const builtin = BUILTIN_PACKS[id];
  const state = config.packs[id] || {};
  if (!builtin && !state.custom) return null;
  return {
    id,
    name: builtin ? builtin.name : state.name,
    desc: builtin ? builtin.desc : 'Custom pack · Daylight + FPS mods included',
    version: builtin?.pinnedVersion || state.version || DEFAULT_MC_VERSION,
    pinned: !!builtin?.pinnedVersion,
    modrinth: PERF_MODS,
    bundled: true,
    builtin: !!builtin
  };
}

function packDir(id) {
  return path.join(PACKS_ROOT, id);
}

function packModsDir(id) {
  return path.join(packDir(id), 'mods');
}

function listPacks() {
  const ids = [...Object.keys(BUILTIN_PACKS), ...Object.keys(config.packs).filter(id => config.packs[id].custom)];
  return ids.map(id => {
    const def = packDef(id);
    const mods = listMods(id);
    return { ...def, modCount: mods.length, selected: config.selectedPack === id };
  });
}

function listMods(packId) {
  const dir = packModsDir(packId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.jar'))
    .map(f => ({ file: f, builtin: f === DAYLIGHT_JAR }));
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

// Tracks which file each Modrinth slug resolved to, so we don't re-download
// and can clean up on version change.
function loadManifest(packId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(packDir(packId), 'installed.json'), 'utf8'));
  } catch {
    return { mcVersion: null, files: {} };
  }
}

function saveManifest(packId, manifest) {
  fs.writeFileSync(path.join(packDir(packId), 'installed.json'), JSON.stringify(manifest, null, 2));
}

async function resolveModrinthFile(slug, mcVersion) {
  const versions = await fetchJson(
    `${MODRINTH_API}/project/${slug}/version?game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}&loaders=${encodeURIComponent(JSON.stringify(['fabric']))}`
  );
  if (!versions.length) return null;
  return versions[0].files.find(f => f.primary) || versions[0].files[0];
}

async function ensurePackReady(pack, progress) {
  const modsDir = packModsDir(pack.id);
  fs.mkdirSync(modsDir, { recursive: true });
  const manifest = loadManifest(pack.id);

  // Version changed since last launch: drop auto-installed mods, they're
  // compiled per-version. User-added mods are left alone.
  if (manifest.mcVersion && manifest.mcVersion !== pack.version) {
    for (const file of Object.values(manifest.files)) {
      const p = path.join(modsDir, file);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    manifest.files = {};
  }
  manifest.mcVersion = pack.version;

  const slugs = pack.modrinth;
  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i];
    const existing = manifest.files[slug];
    if (existing && fs.existsSync(path.join(modsDir, existing))) continue;
    progress(`Installing ${slug} (${i + 1}/${slugs.length})`, i, slugs.length);
    const file = await resolveModrinthFile(slug, pack.version);
    if (!file) continue; // mod not available for this version yet — skip
    await downloadFile(file.url, path.join(modsDir, file.filename));
    manifest.files[slug] = file.filename;
  }

  // Bundled Daylight mod jar — pick the build compiled for this pack's MC
  // version; if there is none, make sure the jar is absent so Fabric doesn't
  // refuse to launch over an unsatisfiable dependency. The mod is built-in:
  // it is always (re)copied so a user can't end up without it.
  const dest = path.join(modsDir, DAYLIGHT_JAR);
  const buildJar = modBuildFor(pack.version);
  if (pack.bundled && buildJar) {
    const src = path.join(BUNDLED_DIR, buildJar);
    if (fs.existsSync(src)
        && (!fs.existsSync(dest) || fs.statSync(src).size !== fs.statSync(dest).size)) {
      fs.copyFileSync(src, dest);
    }
  } else if (fs.existsSync(dest)) {
    fs.unlinkSync(dest);
  }

  saveManifest(pack.id, manifest);
}

// ---------- mods (Modrinth search) ----------

async function searchMods(query, packId) {
  const pack = packDef(packId || config.selectedPack);
  const facets = JSON.stringify([
    ['project_type:mod'],
    ['categories:fabric'],
    [`versions:${pack.version}`]
  ]);
  const data = await fetchJson(
    `${MODRINTH_API}/search?query=${encodeURIComponent(query)}&limit=20&facets=${encodeURIComponent(facets)}`
  );
  return data.hits.map(h => ({
    id: h.project_id,
    title: h.title,
    description: h.description,
    downloads: h.downloads,
    icon: h.icon_url
  }));
}

async function installMod(projectId, packId) {
  const pack = packDef(packId || config.selectedPack);
  const file = await resolveModrinthFile(projectId, pack.version);
  if (!file) throw new Error('No Fabric build of this mod for ' + pack.version);
  const modsDir = packModsDir(pack.id);
  fs.mkdirSync(modsDir, { recursive: true });
  await downloadFile(file.url, path.join(modsDir, file.filename));
  return file.filename;
}

// Copy user-picked .jar files into a pack's mods folder.
async function importMods(packId) {
  const pack = packDef(packId || config.selectedPack);
  if (!pack) throw new Error('Unknown pack');
  const { canceled, filePaths } = await require('electron').dialog.showOpenDialog(win, {
    title: `Add mods to ${pack.name}`,
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Fabric mods', extensions: ['jar'] }]
  });
  if (canceled) return [];
  const modsDir = packModsDir(pack.id);
  fs.mkdirSync(modsDir, { recursive: true });
  const added = [];
  for (const src of filePaths) {
    if (!src.toLowerCase().endsWith('.jar')) continue;
    fs.copyFileSync(src, path.join(modsDir, path.basename(src)));
    added.push(path.basename(src));
  }
  return added;
}

// ---------- launch ----------

async function launchGame() {
  if (!minecraftToken) throw new Error('Not logged in');
  if (gameRunning) throw new Error('Game is already running');

  const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);
  const pack = packDef(config.selectedPack);
  if (!pack) throw new Error('No pack selected');

  send('launch-progress', { label: 'Preparing pack…', current: 0, total: 1 });
  await ensurePackReady(pack, (label, current, total) =>
    send('launch-progress', { label, current, total })
  );

  const fabricId = await ensureFabricProfile(pack.version);

  const launcher = new Client();
  launcher.on('debug', m => send('game-log', String(m)));
  launcher.on('data', m => send('game-log', String(m)));
  launcher.on('progress', e =>
    send('launch-progress', { label: `Downloading ${e.type}`, current: e.task, total: e.total })
  );
  launcher.on('download-status', e =>
    send('launch-progress', { label: `Downloading ${e.type}: ${e.name}`, current: e.current, total: e.total })
  );

  const javaPath = await ensureJava(pack.version, (label, current, total) =>
    send('launch-progress', { label, current, total })
  );
  const proc = await launcher.launch({
    root: GAME_ROOT,
    authorization: minecraftToken.mclc(),
    version: { number: pack.version, type: 'release', custom: fabricId },
    memory: { min: `${config.minRam}G`, max: `${config.maxRam}G` },
    customArgs: JVM_FLAGS,
    overrides: { gameDirectory: packDir(pack.id) },
    ...(javaPath ? { javaPath } : {})
  });

  if (!proc) throw new Error('Failed to start Minecraft — check the log output');

  gameRunning = true;
  send('game-state', 'running');
  proc.on('close', code => {
    gameRunning = false;
    send('game-state', 'stopped');
    send('game-log', `Minecraft exited with code ${code}`);
  });
}

// ---------- IPC ----------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

handle('silent-login', () => trySilentLogin());
handle('list-accounts', () => listAccounts());
handle('add-account', () => addAccount());
handle('switch-account', uuid => switchAccount(uuid));
handle('remove-account', uuid => {
  removeAccount(uuid);
  return listAccounts();
});

handle('get-config', () => {
  const { accounts, activeUuid, refreshToken, ...visible } = config;
  return visible;
});
handle('set-config', updates => {
  const { accounts, activeUuid, refreshToken, packs, selectedPack, ...allowed } = updates;
  config = { ...config, ...allowed };
  saveConfig(config);
});

handle('get-versions', () => getGameVersions());

handle('list-packs', () => listPacks());
handle('select-pack', id => {
  if (!packDef(id)) throw new Error('Unknown pack');
  config.selectedPack = id;
  saveConfig(config);
});
handle('create-pack', ({ name, version }) => {
  const id = 'custom-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!id || packDef(id)) throw new Error('A pack with that name already exists');
  config.packs[id] = { custom: true, name, version };
  config.selectedPack = id;
  saveConfig(config);
  return id;
});
handle('delete-pack', id => {
  if (!config.packs[id]?.custom) throw new Error('Built-in packs cannot be deleted');
  delete config.packs[id];
  if (config.selectedPack === id) config.selectedPack = 'daylight';
  saveConfig(config);
  fs.rmSync(packDir(id), { recursive: true, force: true });
});
handle('set-pack-version', ({ id, version }) => {
  const def = packDef(id);
  if (!def) throw new Error('Unknown pack');
  if (def.pinned) throw new Error('This pack is pinned to ' + def.version);
  config.packs[id] = { ...config.packs[id], version };
  saveConfig(config);
});

handle('launch', () => launchGame());
handle('search-mods', ({ query, packId }) => searchMods(query, packId));
handle('install-mod', ({ projectId, packId }) => installMod(projectId, packId));
handle('import-mods', packId => importMods(packId));
handle('list-mods', packId => listMods(packId || config.selectedPack));
handle('delete-mod', ({ filename, packId }) => {
  const base = path.basename(filename);
  if (base === DAYLIGHT_JAR) throw new Error('The Daylight mod is built-in and cannot be removed');
  const target = path.join(packModsDir(packId || config.selectedPack), base);
  if (fs.existsSync(target)) fs.unlinkSync(target);
});
handle('open-mods-folder', packId => {
  const dir = packModsDir(packId || config.selectedPack);
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
});
handle('open-game-folder', () => {
  fs.mkdirSync(GAME_ROOT, { recursive: true });
  shell.openPath(GAME_ROOT);
});

handle('check-updates', () => autoUpdater.checkForUpdates());
handle('install-update', () => autoUpdater.quitAndInstall());
handle('get-app-version', () => app.getVersion());

// ---------- window / tray ----------

let tray = null;
let quitting = false;

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 680,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0d13',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // closing hides to tray; Daylight keeps running in the background
  win.on('close', e => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('Daylight');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Daylight', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', showWindow);
}

// ---------- auto-update ----------

function initUpdater() {
  const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', info => send('update-available', info.version));
  autoUpdater.on('update-not-available', () => send('update-none'));
  autoUpdater.on('download-progress', p => send('update-progress', Math.round(p.percent)));
  autoUpdater.on('update-downloaded', info => send('update-ready', info.version));
  autoUpdater.on('error', err => send('update-error', String(err?.message || err)));
  autoUpdater.checkForUpdates().catch(() => {});
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    config = loadConfig();
    createWindow();
    createTray();
    if (app.isPackaged) initUpdater();
  });
}

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  if (quitting) app.quit();
  // otherwise stay alive in the tray
});
