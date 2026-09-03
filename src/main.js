const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { Client } = require('minecraft-launcher-core');
const { Auth, lexicon } = require('msmc');
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
// True when this process runs inside a Windows AppContainer sandbox (e.g. a
// dev-tool test launch): %APPDATA% is then silently redirected into the
// container's LocalCache, so packs/config written here never reach the user's
// normal install. The UI shows a warning badge so such a launch is unmistakable.
const IS_SANDBOXED = /\\Packages\\/i.test(GAME_ROOT);
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

// Mod loaders a pack can run on. Fabric is the default and the only one the
// bundled Daylight mod is built for; Forge/NeoForge packs launch and manage
// mods normally, they just don't get the in-game module GUI.
const LOADERS = ['fabric', 'forge', 'neoforge'];
const LOADER_LABEL = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' };

// Client-side performance mods (Modrinth slugs) per loader — Sodium & friends
// are where the real FPS gains come from. Anything with no build for the
// pack's version is skipped rather than failing the launch.
const PERF_MODS = {
  fabric: ['fabric-api', 'sodium', 'lithium', 'ferrite-core', 'entityculling', 'immediatelyfast', 'krypton', 'badoptimizations'],
  forge: ['embeddium', 'ferrite-core', 'entityculling', 'immediatelyfast', 'modernfix'],
  neoforge: ['sodium', 'ferrite-core', 'entityculling', 'immediatelyfast', 'modernfix']
};

// Tuned G1GC flags for smoother frametimes than JVM defaults.
const JVM_FLAGS = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=50',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:G1NewSizePercent=20',
  '-XX:G1ReservePercent=20',
  '-XX:G1HeapRegionSize=32M',
  '-XX:+UseStringDeduplication'
];

// Heap sized to the machine: an undersized heap on a big modpack means
// constant GC stutter, the most common "modded Minecraft is laggy" cause.
function defaultRam() {
  const gb = require('os').totalmem() / (1024 ** 3);
  if (gb >= 24) return { min: 4, max: 8 };
  if (gb >= 12) return { min: 3, max: 6 };
  return { min: 2, max: 4 };
}
const RAM = defaultRam();

// Every pack — built-in and custom — includes the Daylight mod and the
// performance mod set as a baseline.
const BUILTIN_PACKS = {
  daylight: {
    name: 'Daylight',
    desc: 'Daylight modules, HUD & FPS boost'
  }
};

let win = null;
let minecraftToken = null;
let tokenTime = 0; // when minecraftToken was minted — stale tokens cause "Invalid session"
let gameRunning = false;

// ---------- config ----------

const defaultConfig = {
  selectedPack: 'daylight',
  packs: {},            // per-pack state: { version, name?, custom? }
  minRam: RAM.min,
  maxRam: RAM.max,
  javaPath: '',
  azureClientId: '',
  daylightMod: true,    // the mod is opt-out, not compulsory
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

  // Pre-2.1 single-account field, superseded by accounts[] once activeUuid is
  // set — drop it so a long-dead token can't linger in the config forever.
  let removedLegacy = false;
  if (cfg.activeUuid && cfg.refreshToken) {
    delete cfg.refreshToken;
    removedLegacy = true;
  }

  const recovered = recoverOrphanPacks(cfg);

  // Configs still on the old universal default (2/4 GB) get upgraded to the
  // machine-sized heap — an undersized heap causes GC lag on big packs.
  if (cfg.minRam === 2 && cfg.maxRam === 4 && RAM.max > 4) {
    cfg.minRam = RAM.min;
    cfg.maxRam = RAM.max;
  }

  // selected pack may be gone (removed builtin or deleted custom pack)
  if (!BUILTIN_PACKS[cfg.selectedPack] && !cfg.packs[cfg.selectedPack]?.custom) {
    cfg.selectedPack = 'daylight';
  }

  // Repair the live config file whenever we recovered packs, fell back to the
  // backup, or had nothing readable at all.
  if (recovered > 0 || usedBackup || parsed === null || removedLegacy) {
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

// Per-OS specifics. The launcher targets Windows and Linux (macOS is best-
// effort via the managed download path). Everything below keys off these.
const IS_WIN = process.platform === 'win32';
// The launcher binary: on Windows javaw.exe (no console window); on Unix
// there's no separate "w" binary, plain `java` is used.
const JAVA_BIN = IS_WIN ? 'javaw.exe' : 'java';
// Adoptium API path components + the archive format it hands back per OS.
const ADOPT_OS = IS_WIN ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
const ADOPT_ARCH = process.arch === 'arm64' ? 'aarch64' : 'x64';
const JRE_ARCHIVE_EXT = IS_WIN ? 'zip' : 'tar.gz';

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

// Directories that hold one JDK/JRE per subfolder, per OS. Each subfolder name
// carries its major version (jdk-21, temurin-17-jre, zulu21.*, etc.).
function javaSearchRoots() {
  const home = require('os').homedir();
  // JetBrains IDEs and Toolbox install JDKs here on every platform, and it is
  // often the only place a developer machine has the older JDK a given
  // Minecraft version needs.
  const jetbrains = path.join(home, '.jdks');
  if (IS_WIN) {
    return [jetbrains, 'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Java',
      'C:\\Program Files\\Microsoft', 'C:\\Program Files\\Zulu'];
  }
  if (process.platform === 'darwin') {
    return ['/Library/Java/JavaVirtualMachines', path.join(home, 'Library/Java/JavaVirtualMachines')];
  }
  // Linux — distro packages, Adoptium's apt repo, SDKMAN, manual /opt installs.
  return ['/usr/lib/jvm', '/usr/lib64/jvm', '/opt/java', '/opt',
    path.join(home, '.sdkman/candidates/java')];
}

// javaw.exe on Windows; on macOS the runtime is nested under Contents/Home.
function javaBinIn(dir) {
  if (process.platform === 'darwin') {
    const nested = path.join(dir, 'Contents', 'Home', 'bin', JAVA_BIN);
    if (fs.existsSync(nested)) return nested;
  }
  return path.join(dir, 'bin', JAVA_BIN);
}

// Newest system JDK that satisfies the requirement. Old MC (Java 8 era)
// breaks on modern JVMs, so for those only an exact major counts.
// Minecraft bundles its own LWJGL, and LWJGL 3.3.3 and older abort with
// "Unsupported JNI version detected" on Java 24+ and then die in native code
// during render init (exit 0xC0000005). Every 1.x release ships such an LWJGL,
// so they must stay below that line; the year-based versions carry a newer
// LWJGL and want Java 25. A newer JDK is emphatically not always better.
function maxJavaFor(mcVersion) {
  return Number(mcVersion.split('.')[0]) >= 26 ? 99 : 23;
}

function findSystemJava(need, max) {
  let best = null;
  let bestVer = 0;
  for (const root of javaSearchRoots()) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      const m = dir.match(/jdk-?(\d+)|jre-?(\d+)|[a-z]+[-_]?(\d+)/i);
      if (!m) continue;
      const ver = Number(m[1] || m[2] || m[3]);
      const ok = need >= 17 ? (ver >= need && ver <= max) : ver === need;
      if (!ok) continue;
      const exe = javaBinIn(path.join(root, dir));
      // Prefer the version closest to what this Minecraft actually asks for,
      // so an exact match always beats a merely-allowed newer one.
      if (fs.existsSync(exe) && (best === null || (ver - need) < (bestVer - need))) {
        bestVer = ver;
        best = exe;
      }
    }
  }
  return best;
}

// A runtime we downloaded ourselves lives under runtime/jdk-<major>/…/bin/<java>
function findManagedJava(need) {
  const base = path.join(RUNTIME_DIR, `jdk-${need}`);
  if (!fs.existsSync(base)) return null;
  const direct = javaBinIn(base);
  if (fs.existsSync(direct)) return direct;
  for (const dir of fs.readdirSync(base)) {
    const nested = javaBinIn(path.join(base, dir));
    if (fs.existsSync(nested)) return nested;
  }
  return null;
}

// Unpacks the Adoptium archive: a .tar.gz on Linux/macOS, a .zip on Windows.
// GNU tar auto-detects gzip with -xf; Windows' bsdtar reads zips the same way,
// so `tar -xf` covers both. PowerShell's Expand-Archive is a Windows-only
// fallback for the rare box without tar.
function extractArchive(archive, dest) {
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xf', archive, '-C', dest], err => {
      if (!err) return resolve();
      if (!IS_WIN) return reject(new Error('Could not extract Java runtime (tar failed): ' + err.message));
      execFile('powershell', ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath "${archive}" -DestinationPath "${dest}" -Force`],
        err2 => err2 ? reject(new Error('Could not extract Java runtime: ' + err2.message)) : resolve());
    });
  });
}

// Returns a java binary suitable for the given MC version, downloading a JRE
// from Adoptium if the machine has nothing suitable — so a fresh PC (Windows
// or Linux) can install, log in and play with zero setup.
async function ensureJava(mcVersion, progress) {
  if (config.javaPath) return config.javaPath;
  const need = requiredJavaFor(mcVersion);
  const found = findSystemJava(need, maxJavaFor(mcVersion)) || findManagedJava(need);
  if (found) return found;

  progress(`Downloading Java ${need}`, 0, 1);
  const url = `https://api.adoptium.net/v3/binary/latest/${need}/ga/${ADOPT_OS}/${ADOPT_ARCH}/jre/hotspot/normal/eclipse`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Java ${need} download failed (HTTP ${res.status}) — set a Java path in Settings`);
  const total = Number(res.headers.get('content-length')) || 0;

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const archivePath = path.join(RUNTIME_DIR, `jre-${need}.${JRE_ARCHIVE_EXT}`);
  const out = fs.createWriteStream(archivePath);
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
  await extractArchive(archivePath, destDir);
  fs.rmSync(archivePath, { force: true });

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
  tokenTime = Date.now();
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
  tokenTime = Date.now();
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
      tokenTime = Date.now();
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

// Repairs a stale login ("Invalid session" in game): silently re-refresh the
// active account's token; if the refresh token itself is dead, fall back to a
// full Microsoft re-login popup. Either way the stored account is updated.
async function fixSession() {
  if (config.activeUuid) {
    try {
      return await switchAccount(config.activeUuid);
    } catch { /* refresh token dead — needs interactive login */ }
  }
  return addAccount();
}

// ---------- in-game session bridge ----------
//
// A running Minecraft client can't refresh its own Microsoft token (the refresh
// token lives here in the launcher). This tiny loopback server lets the in-game
// Daylight mod ask the launcher — which stays alive in the tray — to mint a
// fresh Minecraft access token so its title-screen "Fix session" button can
// swap it into the live session and cure "Invalid session" without a restart.
//
// Bound to 127.0.0.1 and gated by a per-run secret handed to the game as a JVM
// -D property. The MC access token is already on the game's own command line
// (MCLC passes --accessToken), so this exposes nothing a local process couldn't
// already read.
let bridgePort = 0;
const bridgeSecret = crypto.randomBytes(24).toString('hex');

function startSessionBridge() {
  const server = http.createServer((req, res) => {
    const reply = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method !== 'POST' || req.url !== '/refresh-session'
        || req.headers['x-daylight-secret'] !== bridgeSecret) {
      res.writeHead(403);
      res.end();
      return;
    }
    (async () => {
      if (!config.activeUuid) throw new Error('No account is signed in');
      await switchAccount(config.activeUuid); // refresh + persist
      const t = minecraftToken.mclc();
      return { accessToken: t.access_token, uuid: t.uuid, name: t.name };
    })()
      .then(data => reply({ ok: true, ...data }))
      .catch(err => reply({ ok: false, error: err.message || String(err) }));
  });
  server.on('error', () => { bridgePort = 0; }); // bridge is best-effort
  server.listen(0, '127.0.0.1', () => { bridgePort = server.address().port; });
}

// ---------- fabric / versions ----------

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

const VERSIONS_CACHE = path.join(GAME_ROOT, 'versions-cache.json');

async function getGameVersions() {
  try {
    const versions = await fetchJson(`${FABRIC_META}/versions/game`);
    const stable = versions.filter(v => v.stable).map(v => v.version);
    try {
      fs.mkdirSync(GAME_ROOT, { recursive: true });
      fs.writeFileSync(VERSIONS_CACHE, JSON.stringify(stable));
    } catch { /* cache is best-effort */ }
    return stable;
  } catch (err) {
    // Offline (e.g. cold boot): fall back to the last cached list so the
    // version pickers still work.
    try {
      return JSON.parse(fs.readFileSync(VERSIONS_CACHE, 'utf8'));
    } catch {
      throw err;
    }
  }
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

// ---------- forge / neoforge ----------
//
// Forge and NeoForge can't be described by a downloadable profile JSON the way
// Fabric can: their client install binary-patches the vanilla jar and unpacks a
// tree of libraries. The official installers do exactly that in headless mode
// (`--installClient <dir>`), and leave behind a versions/<id>/<id>.json that
// MCLC can then launch through `version.custom`, identically to Fabric.
//
// We deliberately do NOT use MCLC's own `forge:` option: it drives the legacy
// ForgeWrapper path, which only recognises net.minecraftforge coordinates and
// so cannot install NeoForge at all.

const FORGE_PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
const LOADERS_INDEX = path.join(GAME_ROOT, 'loaders.json');

function readLoadersIndex() {
  try {
    return JSON.parse(fs.readFileSync(LOADERS_INDEX, 'utf8'));
  } catch {
    return {};
  }
}

function writeLoadersIndex(index) {
  try {
    fs.writeFileSync(LOADERS_INDEX, JSON.stringify(index, null, 2));
  } catch { /* index is a cache; a failed write only costs a re-install */ }
}

// Newest Forge build for a game version. Forge publishes a "recommended" and a
// "latest" per version; recommended is the safer default when it exists.
async function resolveForgeVersion(mcVersion) {
  const promos = await fetchJson(FORGE_PROMOS);
  const v = promos?.promos?.[`${mcVersion}-recommended`] || promos?.promos?.[`${mcVersion}-latest`];
  if (!v) throw new Error(`Forge has no build for Minecraft ${mcVersion}`);
  return v;
}

// NeoForge versions encode the game version: MC 1.21.1 -> 21.1.x, MC 1.21 -> 21.0.x.
async function resolveNeoForgeVersion(mcVersion) {
  const parts = mcVersion.split('.');
  if (parts[0] !== '1' || parts.length < 2) throw new Error(`NeoForge has no build for Minecraft ${mcVersion}`);
  const prefix = `${parts[1]}.${parts[2] || '0'}.`;

  const res = await fetch(`${NEOFORGE_MAVEN}/maven-metadata.xml`);
  if (!res.ok) throw new Error(`NeoForge version list unavailable (HTTP ${res.status})`);
  const xml = await res.text();
  const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]);

  const stable = all.filter(v => v.startsWith(prefix) && !v.includes('beta'));
  const usable = stable.length ? stable : all.filter(v => v.startsWith(prefix));
  if (!usable.length) throw new Error(`NeoForge has no build for Minecraft ${mcVersion}`);

  // Maven metadata is oldest-first, but sort by build number so we don't rely on it.
  usable.sort((a, b) => (parseInt(a.slice(prefix.length), 10) || 0) - (parseInt(b.slice(prefix.length), 10) || 0));
  return usable[usable.length - 1];
}

// The installers refuse to run against a folder that doesn't look like an
// official-launcher install, and a missing profiles file is the usual reason.
function ensureLauncherProfiles() {
  const p = path.join(GAME_ROOT, 'launcher_profiles.json');
  if (!fs.existsSync(p)) {
    fs.mkdirSync(GAME_ROOT, { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2));
  }
}

function listVersionIds() {
  const dir = path.join(GAME_ROOT, 'versions');
  try {
    return fs.readdirSync(dir).filter(f => fs.existsSync(path.join(dir, f, `${f}.json`)));
  } catch {
    return [];
  }
}

// javaw has no console and swallows the installer's output; the installer is a
// headless CLI here, so use the plain java binary next to it.
function consoleJava(javaPath) {
  const alt = javaPath.replace(/javaw\.exe$/i, 'java.exe');
  return fs.existsSync(alt) ? alt : javaPath;
}

function runInstaller(javaPath, installerPath) {
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {
    execFile(
      consoleJava(javaPath),
      ['-jar', installerPath, '--installClient', GAME_ROOT],
      { cwd: GAME_ROOT, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const tail = String(stderr || stdout || '').trim().split('\n').slice(-6).join('\n');
          return reject(new Error(`Loader install failed:\n${tail || err.message}`));
        }
        resolve(String(stdout || ''));
      }
    );
  });
}

/**
 * Installs Forge/NeoForge for a game version if it isn't installed already, and
 * returns the version id to launch through (e.g. `1.20.1-forge-47.3.0` or
 * `neoforge-21.1.90`). Fabric packs take the profile-JSON path instead.
 */
async function ensureLoaderProfile(pack, javaPath, progress) {
  if (pack.loader === 'fabric') return ensureFabricProfile(pack.version);

  const label = LOADER_LABEL[pack.loader];
  const key = `${pack.loader}-${pack.version}`;
  const index = readLoadersIndex();
  const known = index[key];
  if (known && fs.existsSync(path.join(GAME_ROOT, 'versions', known, `${known}.json`))) return known;

  progress(`Finding ${label} for ${pack.version}…`, 0, 1);
  const isNeo = pack.loader === 'neoforge';
  const loaderVersion = isNeo
    ? await resolveNeoForgeVersion(pack.version)
    : await resolveForgeVersion(pack.version);
  const installerUrl = isNeo
    ? `${NEOFORGE_MAVEN}/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`
    : `${FORGE_MAVEN}/${pack.version}-${loaderVersion}/forge-${pack.version}-${loaderVersion}-installer.jar`;

  const cacheDir = path.join(GAME_ROOT, 'loader-installers');
  fs.mkdirSync(cacheDir, { recursive: true });
  const installerPath = path.join(cacheDir, path.basename(installerUrl));

  progress(`Downloading ${label} ${loaderVersion}…`, 0, 1);
  if (!fs.existsSync(installerPath)) await downloadFile(installerUrl, installerPath);

  progress(`Installing ${label} ${loaderVersion} (this takes a minute)…`, 0, 1);
  ensureLauncherProfiles();
  const before = new Set(listVersionIds());
  try {
    await runInstaller(javaPath, installerPath);
  } catch (err) {
    // A truncated or half-downloaded installer would fail the same way forever.
    fs.rmSync(installerPath, { force: true });
    throw err;
  }

  // The installer also drops the vanilla version folder, so match the loader's
  // own name rather than taking whatever is new — picking the vanilla id here
  // would launch an unmodded game that looks like it worked.
  const added = listVersionIds().filter(id => !before.has(id));
  const marker = isNeo ? 'neoforge' : 'forge';
  const expected = isNeo ? `neoforge-${loaderVersion}` : `${pack.version}-forge-${loaderVersion}`;
  const id = added.find(v => v.toLowerCase().includes(marker))
    // Re-install over an existing folder adds nothing new: fall back to the name
    // the installer documents.
    || (fs.existsSync(path.join(GAME_ROOT, 'versions', expected, `${expected}.json`)) ? expected : null);
  if (!id) throw new Error(`${label} installed but no version profile appeared — check the launcher log`);

  index[key] = id;
  writeLoadersIndex(index);
  return id;
}

// MCLC builds its own JVM arguments and never reads the ones in a version
// profile. Fabric needs none, but modern Forge/NeoForge do not boot without
// them: the module path, the --add-opens/--add-exports set and
// -DlibraryDirectory all live in arguments.jvm. Read them back out and pass
// them through customArgs, resolving the placeholders the vanilla launcher
// would have filled in.
function loaderJvmArgs(versionId, mcVersion) {
  const jsonPath = path.join(GAME_ROOT, 'versions', versionId, `${versionId}.json`);
  let profile;
  try {
    profile = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    return [];
  }
  const jvm = profile.arguments && profile.arguments.jvm;
  if (!Array.isArray(jvm)) return [];
  const libDir = path.resolve(path.join(GAME_ROOT, 'libraries'));
  return jvm
    // Rule-gated entries are the OS-specific vanilla ones; MCLC already covers those.
    .filter(arg => typeof arg === 'string')
    .map(arg => arg
      .split('${library_directory}').join(libDir)
      .split('${classpath_separator}').join(path.delimiter)
      .split('${version_name}').join(mcVersion));
}

// ---------- packs ----------

function packDef(id) {
  const builtin = BUILTIN_PACKS[id];
  const state = config.packs[id] || {};
  if (!builtin && !state.custom) return null;
  const version = builtin?.pinnedVersion || state.version || DEFAULT_MC_VERSION;
  // Built-in packs are always Fabric — that's what the bundled mod is built for.
  const loader = builtin ? 'fabric' : (LOADERS.includes(state.loader) ? state.loader : 'fabric');
  const fabric = loader === 'fabric';
  return {
    id,
    name: builtin ? builtin.name : state.name,
    desc: builtin
      ? builtin.desc
      : (fabric ? 'Custom pack · Daylight + FPS mods included' : `Custom ${LOADER_LABEL[loader]} pack · FPS mods included`),
    version,
    loader,
    loaderLabel: LOADER_LABEL[loader],
    pinned: !!builtin?.pinnedVersion,
    modrinth: PERF_MODS[loader],
    // Fabric-only, and only if the user still wants it. Turning it off is a
    // real removal: the launch path below deletes the jar rather than leaving
    // a disabled copy behind, so the pack runs genuinely without it.
    bundled: fabric && config.daylightMod !== false,
    builtin: !!builtin,
    // Whether a Daylight mod build exists for this pack's MC version — the UI
    // says so up front instead of the mod quietly not being there.
    hasMod: fabric && !!modBuildFor(version)
  };
}

function packDir(id) {
  return path.join(PACKS_ROOT, id);
}

function packModsDir(id) {
  return path.join(packDir(id), 'mods');
}

function packResourcePacksDir(id) {
  return path.join(packDir(id), 'resourcepacks');
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
    const m = JSON.parse(fs.readFileSync(path.join(packDir(packId), 'installed.json'), 'utf8'));
    m.files = m.files || {};
    m.removed = m.removed || []; // auto-installed mods the user deleted on purpose
    return m;
  } catch {
    return { mcVersion: null, files: {}, removed: [] };
  }
}

function saveManifest(packId, manifest) {
  fs.writeFileSync(path.join(packDir(packId), 'installed.json'), JSON.stringify(manifest, null, 2));
}

async function resolveModrinthFile(slug, mcVersion, loader = 'fabric') {
  const versions = await fetchJson(
    `${MODRINTH_API}/project/${slug}/version?game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}&loaders=${encodeURIComponent(JSON.stringify([loader]))}`
  );
  if (!versions.length) return null;
  return versions[0].files.find(f => f.primary) || versions[0].files[0];
}

// True when two files are byte-identical. Used for the built-in mod jar, where
// a same-size-but-different build must still be copied over.
function sameContents(a, b) {
  try {
    const ha = crypto.createHash('sha1').update(fs.readFileSync(a)).digest('hex');
    const hb = crypto.createHash('sha1').update(fs.readFileSync(b)).digest('hex');
    return ha === hb;
  } catch {
    return false;
  }
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
    if (manifest.removed.includes(slug)) continue; // user deleted it — respect that
    const existing = manifest.files[slug];
    if (existing && fs.existsSync(path.join(modsDir, existing))) continue;
    progress(`Installing ${slug} (${i + 1}/${slugs.length})`, i, slugs.length);
    const file = await resolveModrinthFile(slug, pack.version, pack.loader);
    if (!file) continue; // mod not available for this version yet — skip
    await downloadFile(file.url, path.join(modsDir, file.filename));
    manifest.files[slug] = file.filename;
  }

  // Bundled Daylight mod jar — pick the build compiled for this pack's MC
  // version; if there is none, make sure the jar is absent so Fabric doesn't
  // refuse to launch over an unsatisfiable dependency. While it is switched on
  // it is always (re)copied, so a stale build can't linger; switched off, the
  // jar is deleted rather than merely skipped, so turning it back on is the
  // only way it returns.
  const dest = path.join(modsDir, DAYLIGHT_JAR);
  const buildJar = modBuildFor(pack.version);
  if (pack.bundled && buildJar) {
    const src = path.join(BUNDLED_DIR, buildJar);
    // Compare contents, not size: a one-constant change (e.g. an FOV cap)
    // produces a jar of exactly the same length, and a size check would then
    // leave the stale jar in place forever.
    if (fs.existsSync(src) && (!fs.existsSync(dest) || !sameContents(src, dest))) {
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
    [`categories:${pack.loader}`],
    [`versions:${pack.version}`]
  ]);
  // Fetch a wide batch; the renderer paginates it 20 at a time.
  const data = await fetchJson(
    `${MODRINTH_API}/search?query=${encodeURIComponent(query)}&limit=60&facets=${encodeURIComponent(facets)}`
  );
  return data.hits.map(h => ({
    id: h.project_id,
    title: h.title,
    description: h.description,
    downloads: h.downloads,
    icon: h.icon_url
  }));
}

// ---------- resource packs (Modrinth) ----------
//
// Resource packs aren't loader-specific, so unlike mods they resolve by game
// version alone (no 'fabric' facet), and install into the pack's own
// resourcepacks/ folder rather than mods/.

async function searchResourcePacks(query, packId) {
  const pack = packDef(packId || config.selectedPack);
  const facets = JSON.stringify([
    ['project_type:resourcepack'],
    [`versions:${pack.version}`]
  ]);
  // Fetch a wide batch; the renderer paginates it 20 at a time.
  const data = await fetchJson(
    `${MODRINTH_API}/search?query=${encodeURIComponent(query)}&limit=60&facets=${encodeURIComponent(facets)}`
  );
  return data.hits.map(h => ({
    id: h.project_id,
    title: h.title,
    description: h.description,
    downloads: h.downloads,
    icon: h.icon_url
  }));
}

async function resolveResourcePackFile(projectId, mcVersion) {
  const versions = await fetchJson(
    `${MODRINTH_API}/project/${projectId}/version?game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`
  );
  if (!versions.length) return null;
  return versions[0].files.find(f => f.primary) || versions[0].files[0];
}

async function installResourcePack(projectId, packId) {
  const pack = packDef(packId || config.selectedPack);
  const file = await resolveResourcePackFile(projectId, pack.version);
  if (!file) throw new Error('No build of this resource pack for ' + pack.version);
  const dir = packResourcePacksDir(pack.id);
  fs.mkdirSync(dir, { recursive: true });
  await downloadFile(file.url, path.join(dir, file.filename));
  return file.filename;
}

function listResourcePacks(packId) {
  const dir = packResourcePacksDir(packId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.zip') || fs.statSync(path.join(dir, f)).isDirectory())
    .map(f => ({ file: f }));
}

async function installMod(projectId, packId) {
  const pack = packDef(packId || config.selectedPack);
  const file = await resolveModrinthFile(projectId, pack.version, pack.loader);
  if (!file) throw new Error(`No ${pack.loaderLabel} build of this mod for ${pack.version}`);
  const modsDir = packModsDir(pack.id);
  fs.mkdirSync(modsDir, { recursive: true });
  await downloadFile(file.url, path.join(modsDir, file.filename));

  // Installing one of the auto-installed mods again clears its "removed" mark,
  // so it resumes being kept up to date on launch.
  const manifest = loadManifest(pack.id);
  if (manifest.removed.length) {
    try {
      const { slug } = await fetchJson(`${MODRINTH_API}/project/${projectId}`);
      const i = manifest.removed.indexOf(slug);
      if (i !== -1) {
        manifest.removed.splice(i, 1);
        manifest.files[slug] = file.filename;
        saveManifest(pack.id, manifest);
      }
    } catch { /* not one of ours, or offline — nothing to un-mark */ }
  }
  return file.filename;
}

// ---------- modpack import ----------

// Turns a name into a unique custom pack id.
function newPackId(name) {
  const base = 'custom-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  let id = base || 'custom-pack';
  let n = 2;
  while (packDef(id)) id = `${base}-${n++}`;
  return id;
}

// Some exports wrap everything in a single top-level folder; step into it so
// the mods/config folders land at the pack root rather than one level down.
function unwrapSingleFolder(dir) {
  const entries = fs.readdirSync(dir);
  if (entries.length === 1) {
    const inner = path.join(dir, entries[0]);
    if (fs.statSync(inner).isDirectory()) return inner;
  }
  return dir;
}

/**
 * Imports a modpack file into a new pack. Understands:
 *  - Modrinth `.mrpack` (modrinth.index.json: downloads every listed file and
 *    copies the overrides folder)
 *  - CurseForge-style exports (manifest.json — overrides are copied; its mods
 *    are project ids rather than URLs, so those are reported as not fetchable)
 *  - any plain `.zip` that contains a mods folder (Dawn and most hand-made
 *    packs) — the whole tree is copied in as-is
 */
async function importModpack(progress) {
  const { canceled, filePaths } = await require('electron').dialog.showOpenDialog(win, {
    title: 'Import a modpack',
    properties: ['openFile'],
    filters: [{ name: 'Modpacks', extensions: ['mrpack', 'zip'] }]
  });
  if (canceled) return null;

  const src = filePaths[0];
  const tmp = path.join(GAME_ROOT, 'import-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });

  try {
    progress('Reading pack…', 0, 1);
    await extractArchive(src, tmp);
    const root = unwrapSingleFolder(tmp);

    const mrIndex = path.join(root, 'modrinth.index.json');
    const cfManifest = path.join(root, 'manifest.json');

    let name = path.basename(src).replace(/\.(mrpack|zip)$/i, '');
    let version = DEFAULT_MC_VERSION;
    let loader = 'fabric';
    let files = [];
    let overrides = [];
    let note = '';

    if (fs.existsSync(mrIndex)) {
      const idx = JSON.parse(fs.readFileSync(mrIndex, 'utf8'));
      name = idx.name || name;
      version = idx.dependencies?.minecraft || version;
      // The index names its loader as a dependency key.
      if (idx.dependencies?.neoforge) loader = 'neoforge';
      else if (idx.dependencies?.forge) loader = 'forge';
      files = (idx.files || []).filter(f => f.downloads?.length);
      overrides = ['overrides', 'client-overrides'];
    } else if (fs.existsSync(cfManifest)) {
      const man = JSON.parse(fs.readFileSync(cfManifest, 'utf8'));
      name = man.name || name;
      version = man.minecraft?.version || version;
      // e.g. "neoforge-21.1.90", "forge-47.3.0", "fabric-0.16.5"
      const modLoader = man.minecraft?.modLoaders?.[0]?.id || '';
      if (modLoader.startsWith('neoforge')) loader = 'neoforge';
      else if (modLoader.startsWith('forge')) loader = 'forge';
      overrides = [man.overrides || 'overrides'];
      if (man.files?.length) {
        note = `${man.files.length} mods are listed by CurseForge project id, not a download URL — add them from the Mods tab.`;
      }
    } else {
      // plain zip: copy the tree in and hope it looks like a game folder
      overrides = ['.'];
      if (!fs.existsSync(path.join(root, 'mods'))) {
        note = 'No mods folder found in that zip — check the pack contents.';
      }
    }

    const id = newPackId(name);
    const dir = packDir(id);
    fs.mkdirSync(dir, { recursive: true });

    // copy overrides / raw contents
    for (const o of overrides) {
      const from = path.resolve(root, o);
      if (!fs.existsSync(from)) continue;
      for (const entry of fs.readdirSync(from)) {
        // never let a pack's own manifest land in the game folder
        if (['modrinth.index.json', 'manifest.json', 'modlist.html'].includes(entry)) continue;
        fs.cpSync(path.join(from, entry), path.join(dir, entry), { recursive: true });
      }
    }

    // download the Modrinth-listed files
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      progress(`Downloading ${path.basename(f.path)} (${i + 1}/${files.length})`, i, files.length);
      const dest = path.join(dir, f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try {
        await downloadFile(f.downloads[0], dest);
      } catch { /* one bad file shouldn't sink the whole import */ }
    }

    config.packs[id] = { custom: true, name, version, loader };
    config.selectedPack = id;
    saveConfig(config);

    return { id, name, version, loader: LOADER_LABEL[loader], mods: listMods(id).length, note };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- release notes ----------

let releasesCache = null;
let releasesCacheAt = 0;
const RELEASES_TTL = 10 * 60 * 1000; // a tray session can outlive a release

// The launcher's own changelog, straight from the published releases.
async function getReleases() {
  if (releasesCache && Date.now() - releasesCacheAt < RELEASES_TTL) return releasesCache;
  const data = await fetchJson('https://api.github.com/repos/Duckboy121/daylight-/releases?per_page=25');
  releasesCache = data
    .filter(r => !r.draft)
    .map(r => ({
      tag: r.tag_name,
      name: r.name || r.tag_name,
      date: r.published_at,
      body: (r.body || '').trim()
    }));
  releasesCacheAt = Date.now();
  return releasesCache;
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

// Lines in the game/launcher output that mean the account token has gone
// stale — the game then rejects server joins with "Invalid session".
const SESSION_ERROR_RE = /invalid session|invalidcredentialsexception|(status|http|error)\s*:?\s*401/i;

async function launchGame() {
  if (!minecraftToken) throw new Error('Not logged in');
  if (gameRunning) throw new Error('Game is already running');

  const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);
  const pack = packDef(config.selectedPack);
  if (!pack) throw new Error('No pack selected');

  // Minecraft session tokens expire after ~24h; an app left running in the
  // tray for days would launch the game with a dead token. Refresh silently
  // when the token is over an hour old; if that fails, keep the old token and
  // let the in-game detector below offer the one-click fix.
  if (config.activeUuid && Date.now() - tokenTime > 60 * 60 * 1000) {
    send('launch-progress', { label: 'Refreshing login…', current: 0, total: 1 });
    try {
      await switchAccount(config.activeUuid);
    } catch { /* offline or token dead — detector handles it */ }
  }

  send('launch-progress', { label: 'Preparing pack…', current: 0, total: 1 });
  await ensurePackReady(pack, (label, current, total) =>
    send('launch-progress', { label, current, total })
  );

  const javaPath = await ensureJava(pack.version, (label, current, total) =>
    send('launch-progress', { label, current, total })
  );

  // Fabric resolves to a downloadable profile JSON; Forge/NeoForge have to run
  // their official installer once, which needs the JVM resolved above.
  const versionId = await ensureLoaderProfile(pack, javaPath, (label, current, total) =>
    send('launch-progress', { label, current, total })
  );

  const launcher = new Client();
  // Watch the stream for stale-session symptoms and tell the renderer once,
  // so it can offer a one-click "fix login & relaunch".
  let sessionErrorSent = false;
  const forwardLog = m => {
    const line = String(m);
    send('game-log', line);
    if (!sessionErrorSent && SESSION_ERROR_RE.test(line)) {
      sessionErrorSent = true;
      send('session-invalid');
    }
  };
  launcher.on('debug', forwardLog);
  launcher.on('data', forwardLog);
  launcher.on('progress', e =>
    send('launch-progress', { label: `Downloading ${e.type}`, current: e.task, total: e.total })
  );
  launcher.on('download-status', e =>
    send('launch-progress', { label: `Downloading ${e.type}: ${e.name}`, current: e.current, total: e.total })
  );

  // Hand the in-game mod the loopback bridge coordinates so its "Fix session"
  // button can reach the launcher (see startSessionBridge). Only when the
  // bridge actually came up.
  const bridgeArgs = bridgePort
    ? [`-Ddaylight.session.port=${bridgePort}`, `-Ddaylight.session.secret=${bridgeSecret}`]
    : [];

  const proc = await launcher.launch({
    root: GAME_ROOT,
    authorization: minecraftToken.mclc(),
    version: { number: pack.version, type: 'release', custom: versionId },
    memory: { min: `${config.minRam}G`, max: `${config.maxRam}G` },
    customArgs: [...JVM_FLAGS, ...bridgeArgs, ...loaderJvmArgs(versionId, pack.version)],
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

// msmc reports a failure as a bare lexicon code, or as {response, ts} -- never
// as an Error. So the obvious `err.message || String(err)` turns every single
// auth failure into "[object Object]" and throws away the one thing the person
// staring at the toast actually needs: which step failed and why.
function describeError(err) {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string') return lexicon.getCode(err);
  if (err && typeof err === 'object') {
    if (typeof err.ts === 'string') {
      const status = err.response && err.response.status;
      return lexicon.getCode(err.ts) + (status ? ` (HTTP ${status})` : '');
    }
    if (typeof err.message === 'string') return err.message;
    try {
      return JSON.stringify(err);
    } catch { /* circular; fall through */ }
  }
  return String(err);
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      const message = describeError(err);
      // Also to disk: the toast is gone in seconds, and "it said login failed"
      // is not something anyone can act on when they report it.
      writeStartupLog(`error ${channel}: ${message}`);
      return { ok: false, error: message };
    }
  });
}

handle('silent-login', () => trySilentLogin());
handle('list-accounts', () => listAccounts());
handle('add-account', () => addAccount());
handle('fix-session', () => fixSession());
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
// Manual rescue: re-read the config from disk and re-register any pack whose
// folder exists but is missing from the list — same self-heal as startup, on
// demand. Safe to run any time; changes nothing when all packs are present.
handle('restore-packs', () => {
  config = loadConfig();
  writeStartupLog('restore-packs');
  return listPacks();
});
handle('select-pack', id => {
  if (!packDef(id)) throw new Error('Unknown pack');
  config.selectedPack = id;
  saveConfig(config);
});
handle('create-pack', ({ name, version, loader }) => {
  const id = 'custom-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!id || packDef(id)) throw new Error('A pack with that name already exists');
  config.packs[id] = { custom: true, name, version, loader: LOADERS.includes(loader) ? loader : 'fabric' };
  config.selectedPack = id;
  saveConfig(config);
  return id;
});
handle('import-modpack', () => {
  const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);
  return importModpack((label, current, total) =>
    send('launch-progress', { label, current, total })
  );
});
handle('get-releases', () => getReleases());
handle('delete-pack', id => {
  if (!config.packs[id]?.custom) throw new Error('Built-in packs cannot be deleted');
  delete config.packs[id];
  if (config.selectedPack === id) config.selectedPack = 'daylight';
  saveConfig(config);
  fs.rmSync(packDir(id), { recursive: true, force: true });
});
handle('get-loaders', () => LOADERS.map(id => ({ id, label: LOADER_LABEL[id] })));
handle('set-pack-loader', ({ id, loader }) => {
  const def = packDef(id);
  if (!def) throw new Error('Unknown pack');
  if (def.builtin) throw new Error('Built-in packs always run on Fabric');
  if (!LOADERS.includes(loader)) throw new Error('Unknown mod loader');
  config.packs[id] = { ...config.packs[id], loader };
  saveConfig(config);
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
  const id = packId || config.selectedPack;
  const target = path.join(packModsDir(id), base);
  if (fs.existsSync(target)) fs.unlinkSync(target);

  // If this was one of the auto-installed mods, remember that the user removed
  // it so the next launch doesn't silently download it again. Only the Daylight
  // mod itself is unconditionally restored.
  const manifest = loadManifest(id);
  const slug = Object.keys(manifest.files).find(s => manifest.files[s] === base);
  if (slug) {
    delete manifest.files[slug];
    if (!manifest.removed.includes(slug)) manifest.removed.push(slug);
    saveManifest(id, manifest);
  }
});
handle('open-mods-folder', packId => {
  const dir = packModsDir(packId || config.selectedPack);
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
});

handle('search-resourcepacks', ({ query, packId }) => searchResourcePacks(query, packId));
handle('install-resourcepack', ({ projectId, packId }) => installResourcePack(projectId, packId));
handle('list-resourcepacks', packId => listResourcePacks(packId || config.selectedPack));
handle('delete-resourcepack', ({ filename, packId }) => {
  const base = path.basename(filename);
  const target = path.join(packResourcePacksDir(packId || config.selectedPack), base);
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
});
handle('open-resourcepacks-folder', packId => {
  const dir = packResourcePacksDir(packId || config.selectedPack);
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
handle('get-env', () => ({
  version: app.getVersion(),
  sandboxed: IS_SANDBOXED,
  root: GAME_ROOT
}));

// ---------- window / tray ----------

let tray = null;
let quitting = false;

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  // If a first (possibly cold-boot) instance was left half-loaded in the tray,
  // reloading its data on focus guarantees packs/account are populated.
  if (!win.webContents.isLoading()) win.webContents.send('refresh-data');
}

// Records what loadConfig actually saw (at startup and on manual restores),
// so a recurrence of the "packs missing after restart" report is diagnosable
// from disk. Version + exe path + SANDBOXED flag identify exactly which
// install and data root produced each entry.
function writeStartupLog(event = 'startup') {
  try {
    const line = `[${new Date().toISOString()}] ${event} v${app.getVersion()} `
      + `exe=${process.execPath} root=${GAME_ROOT}${IS_SANDBOXED ? ' SANDBOXED' : ''} `
      + `packs=${Object.keys(config.packs || {}).join(',') || '(none)'} `
      + `accounts=${(config.accounts || []).length} selected=${config.selectedPack}\n`;
    fs.appendFileSync(path.join(app.getPath('userData'), 'startup.log'), line);
  } catch { /* non-fatal */ }
}

// Custom title-bar controls (the window is frameless).
ipcMain.on('window-control', (_e, action) => {
  if (!win || win.isDestroyed()) return;
  if (action === 'minimize') win.minimize();
  else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === 'close') win.close(); // hides to tray via the close handler
});

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 710,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#08090c',
    frame: false,            // custom title bar (see .topbar in the renderer)
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
    writeStartupLog();
    startSessionBridge();
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
