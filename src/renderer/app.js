const $ = id => document.getElementById(id);

let profile = null;
let launching = false;
let gameRunning = false;
let packs = [];
let versions = [];
let modsPackId = null; // which pack the Mods tab installs into

// ---------- helpers ----------

function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 4000);
}

async function call(fn, ...args) {
  const res = await window.daylight[fn](...args);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

// Log lines stream in fast during a modded launch; writing the DOM per line
// causes a reflow each time. Buffer and flush at most every 150ms, and cap
// the kept text so a long session can't grow memory forever.
let logBuffer = '';
let logFlushTimer = null;
function flushLog() {
  logFlushTimer = null;
  const log = $('log');
  let text = log.textContent + logBuffer;
  logBuffer = '';
  if (text.length > 120000) text = text.slice(-90000);
  log.textContent = text;
  log.scrollTop = log.scrollHeight;
}
function appendLog(line) {
  logBuffer += line.endsWith('\n') ? line : line + '\n';
  if (!logFlushTimer) logFlushTimer = setTimeout(flushLog, 150);
}

function selectedPack() {
  return packs.find(p => p.selected);
}

// ---------- tabs ----------

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'mods') refreshModsTab();
    if (btn.dataset.tab === 'packs') renderPackGrid();
  });
});

// ---------- account switcher ----------

let accounts = [];

function renderAccount() {
  $('acct-avatar').src = profile
    ? `https://mc-heads.net/avatar/${profile.uuid}/28`
    : '';
  $('acct-name').textContent = profile ? profile.name : 'Not logged in';
  updatePlayButton();
}

function renderAccountMenu() {
  const listEl = $('acct-list');
  listEl.innerHTML = '';
  for (const acc of accounts) {
    const row = document.createElement('div');
    row.className = 'acct-row' + (acc.active ? ' active' : '');

    const img = document.createElement('img');
    img.src = `https://mc-heads.net/avatar/${acc.uuid}/24`;
    const name = document.createElement('span');
    name.className = 'acct-row-name';
    name.textContent = acc.name;
    row.append(img, name);

    if (acc.active) {
      const dot = document.createElement('span');
      dot.className = 'acct-active-dot';
      row.append(dot);
    }

    const remove = document.createElement('button');
    remove.className = 'acct-remove';
    remove.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
    remove.title = 'Remove account';
    remove.addEventListener('click', async e => {
      e.stopPropagation();
      accounts = await call('removeAccount', acc.uuid);
      if (acc.active) {
        // switched-away or none left
        const next = accounts.find(a => a.active);
        profile = next ? await call('switchAccount', next.uuid).catch(() => null) : null;
      }
      renderAccount();
      renderAccountMenu();
    });
    row.append(remove);

    if (!acc.active) {
      row.addEventListener('click', async () => {
        try {
          profile = await call('switchAccount', acc.uuid);
          accounts = await call('listAccounts');
          renderAccount();
          renderAccountMenu();
          closeAccountMenu();
          toast(`Switched to ${profile.name}`);
        } catch (err) {
          toast('Switch failed: ' + err.message, true);
        }
      });
    }
    listEl.append(row);
  }
}

function openAccountMenu() {
  renderAccountMenu();
  $('acct-menu').classList.remove('hidden');
}
function closeAccountMenu() {
  $('acct-menu').classList.add('hidden');
}

$('acct-current').addEventListener('click', e => {
  e.stopPropagation();
  $('acct-menu').classList.contains('hidden') ? openAccountMenu() : closeAccountMenu();
});
document.addEventListener('click', e => {
  if (!e.target.closest('.acct-switcher')) closeAccountMenu();
});

$('acct-add').addEventListener('click', async () => {
  try {
    $('acct-add').textContent = 'Signing in…';
    profile = await call('addAccount');
    accounts = await call('listAccounts');
    renderAccount();
    renderAccountMenu();
    toast(`Signed in as ${profile.name}`);
  } catch (err) {
    toast('Login failed: ' + err.message, true);
  } finally {
    $('acct-add').textContent = '+ Add account';
  }
});

function updatePlayButton() {
  const btn = $('play-btn');
  if (gameRunning) {
    btn.disabled = true;
    btn.textContent = 'RUNNING…';
  } else if (launching) {
    btn.disabled = true;
    btn.textContent = 'LAUNCHING…';
  } else if (!profile) {
    btn.disabled = true;
    btn.textContent = 'LOG IN TO PLAY';
  } else {
    btn.disabled = false;
    btn.textContent = 'LAUNCH';
  }
}

// ---------- packs ----------

async function refreshPacks() {
  packs = await call('listPacks');
  const select = $('pack-select');
  select.innerHTML = '';
  for (const p of packs) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    select.append(opt);
  }
  const sel = selectedPack();
  if (sel) {
    select.value = sel.id;
    $('pack-version').textContent = `Minecraft ${sel.version}, Fabric, ${sel.modCount} mods`;
  }
}

$('pack-select').addEventListener('change', async e => {
  await call('selectPack', e.target.value);
  await refreshPacks();
});

function packCard(p) {
  const card = document.createElement('div');
  card.className = 'pack-card' + (p.selected ? ' selected' : '');

  const head = document.createElement('div');
  head.style.display = 'flex';
  head.style.justifyContent = 'space-between';
  head.style.alignItems = 'center';
  const h3 = document.createElement('h3');
  h3.textContent = p.name;
  head.append(h3);
  if (p.selected) {
    const badge = document.createElement('span');
    badge.className = 'pack-badge';
    badge.textContent = 'SELECTED';
    head.append(badge);
  }

  const desc = document.createElement('div');
  desc.className = 'pack-desc';
  desc.textContent = p.desc;

  const meta = document.createElement('div');
  meta.className = 'pack-meta';
  if (p.pinned) {
    meta.textContent = `Minecraft ${p.version} · ${p.modCount} mods`;
  } else {
    const label = document.createElement('span');
    label.textContent = 'MC';
    const verSel = document.createElement('select');
    for (const v of versions) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      verSel.append(opt);
    }
    verSel.value = p.version;
    verSel.addEventListener('click', e => e.stopPropagation());
    verSel.addEventListener('change', async e => {
      try {
        await call('setPackVersion', { id: p.id, version: e.target.value });
        await refreshPacks();
        renderPackGrid();
      } catch (err) {
        toast(err.message, true);
      }
    });
    const count = document.createElement('span');
    count.textContent = `· ${p.modCount} mods`;
    meta.append(label, verSel, count);
  }

  card.append(head, desc, meta);

  if (!p.builtin) {
    const actions = document.createElement('div');
    actions.className = 'pack-actions';
    const del = document.createElement('button');
    del.className = 'btn btn-small btn-danger';
    del.textContent = 'Delete';
    del.addEventListener('click', async e => {
      e.stopPropagation();
      try {
        await call('deletePack', p.id);
        await refreshPacks();
        renderPackGrid();
      } catch (err) {
        toast(err.message, true);
      }
    });
    actions.append(del);
    card.append(actions);
  }

  card.addEventListener('click', async () => {
    await call('selectPack', p.id);
    await refreshPacks();
    renderPackGrid();
  });

  return card;
}

function renderPackGrid() {
  const grid = $('pack-grid');
  grid.innerHTML = '';
  for (const p of packs) grid.append(packCard(p));

  const add = document.createElement('div');
  add.className = 'pack-card new-pack';
  add.textContent = '+ New pack';
  add.addEventListener('click', () => {
    const verSel = $('new-pack-version');
    verSel.innerHTML = '';
    for (const v of versions) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      verSel.append(opt);
    }
    if (versions.includes('1.21.11')) verSel.value = '1.21.11';
    $('new-pack-name').value = '';
    $('pack-dialog').showModal();
  });
  grid.append(add);
}

$('pack-create-cancel').addEventListener('click', () => $('pack-dialog').close());
$('pack-create-ok').addEventListener('click', async () => {
  const name = $('new-pack-name').value.trim();
  if (!name) return toast('Give the pack a name', true);
  try {
    await call('createPack', { name, version: $('new-pack-version').value });
    $('pack-dialog').close();
    await refreshPacks();
    renderPackGrid();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- launch ----------

$('play-btn').addEventListener('click', async () => {
  launching = true;
  updatePlayButton();
  $('progress-wrap').classList.remove('hidden');
  logBuffer = '';
  $('log').textContent = '';
  $('log-card').classList.add('open');
  try {
    await call('launch');
  } catch (err) {
    toast('Launch failed: ' + err.message, true);
    appendLog('Launch failed: ' + err.message);
    launching = false;
    updatePlayButton();
  }
});

// ---------- game log card ----------

$('log-head').addEventListener('click', () => $('log-card').classList.toggle('open'));
$('log-clear').addEventListener('click', e => {
  e.stopPropagation();
  logBuffer = '';
  $('log').textContent = '';
});
$('log-settings').addEventListener('click', e => {
  e.stopPropagation();
  document.querySelector('.nav-btn[data-tab="settings"]').click();
});

window.daylight.onProgress(p => {
  const pct = p.total ? Math.min(100, Math.round((p.current / p.total) * 100)) : 0;
  $('progress-bar').style.width = pct + '%';
  $('progress-label').textContent = `${p.label} (${pct}%)`;
});

window.daylight.onGameLog(appendLog);

window.daylight.onGameState(state => {
  gameRunning = state === 'running';
  if (gameRunning) {
    launching = false;
    $('progress-bar').style.width = '100%';
    $('progress-label').textContent = 'Game running';
  } else {
    $('progress-wrap').classList.add('hidden');
  }
  updatePlayButton();
});

// ---------- mods ----------

function modItem(children) {
  const li = document.createElement('li');
  li.className = 'mod-item';
  li.append(...children);
  return li;
}

function currentModsPack() {
  return packs.find(p => p.id === modsPackId) || selectedPack();
}

function refreshModsTab() {
  const select = $('mods-pack-select');
  if (!modsPackId || !packs.some(p => p.id === modsPackId)) {
    modsPackId = (selectedPack() || packs[0]).id;
  }
  select.innerHTML = '';
  for (const p of packs) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    select.append(opt);
  }
  select.value = modsPackId;
  const pack = currentModsPack();
  $('mods-pack-version').textContent = pack ? `Minecraft ${pack.version}` : '';
  refreshInstalledMods();
}

$('mods-pack-select').addEventListener('change', e => {
  modsPackId = e.target.value;
  const pack = currentModsPack();
  $('mods-pack-version').textContent = pack ? `Minecraft ${pack.version}` : '';
  $('mod-results').innerHTML = '';
  refreshInstalledMods();
});

$('add-mod-btn').addEventListener('click', async () => {
  try {
    const added = await call('importMods', modsPackId);
    if (added.length) {
      toast(`Added ${added.length} mod${added.length > 1 ? 's' : ''} to ${currentModsPack().name}`);
      refreshInstalledMods();
      refreshPacks();
    }
  } catch (err) {
    toast(err.message, true);
  }
});

async function refreshInstalledMods() {
  const mods = await call('listMods', modsPackId);
  const list = $('mod-installed');
  list.innerHTML = '';
  if (!mods.length) {
    const li = document.createElement('li');
    li.className = 'mod-item';
    li.innerHTML = '<span class="mod-desc">No mods installed</span>';
    list.append(li);
    return;
  }
  // built-in mod first
  mods.sort((a, b) => (b.builtin ? 1 : 0) - (a.builtin ? 1 : 0));
  for (const mod of mods) {
    const name = document.createElement('span');
    name.className = 'mod-file';
    name.textContent = mod.builtin ? 'Daylight (modules, emotes, freelook)' : mod.file;
    name.title = mod.file;

    if (mod.builtin) {
      const badge = document.createElement('span');
      badge.className = 'builtin-badge';
      badge.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg><span>Built-in</span>';
      list.append(modItem([name, badge]));
      continue;
    }

    const del = document.createElement('button');
    del.className = 'btn btn-small btn-danger';
    del.textContent = 'Remove';
    del.addEventListener('click', async () => {
      await call('deleteMod', mod.file, modsPackId);
      refreshInstalledMods();
      refreshPacks();
    });

    list.append(modItem([name, del]));
  }
}

async function searchMods() {
  const query = $('mod-search').value.trim();
  if (!query) return;
  const list = $('mod-results');
  list.innerHTML = '<li class="mod-item"><span class="mod-desc">Searching…</span></li>';
  try {
    const hits = await call('searchMods', query, modsPackId);
    list.innerHTML = '';
    if (!hits.length) {
      list.innerHTML = '<li class="mod-item"><span class="mod-desc">No results for this version</span></li>';
      return;
    }
    for (const hit of hits) {
      const icon = document.createElement('img');
      icon.src = hit.icon || '';
      icon.alt = '';

      const meta = document.createElement('div');
      meta.className = 'mod-meta';
      const title = document.createElement('div');
      title.className = 'mod-title';
      title.textContent = hit.title;
      const desc = document.createElement('div');
      desc.className = 'mod-desc';
      desc.textContent = hit.description.length > 90
        ? hit.description.slice(0, 90).trimEnd() + '…'
        : hit.description;
      desc.title = hit.description;
      meta.append(title, desc);

      const install = document.createElement('button');
      install.className = 'btn btn-small';
      install.textContent = 'Install';
      install.addEventListener('click', async () => {
        install.disabled = true;
        install.textContent = '…';
        try {
          const file = await call('installMod', hit.id, modsPackId);
          toast(`Installed ${file} → ${currentModsPack().name}`);
          refreshInstalledMods();
          refreshPacks();
          install.textContent = 'Installed';
        } catch (err) {
          toast(err.message, true);
          install.disabled = false;
          install.textContent = 'Install';
        }
      });

      list.append(modItem([icon, meta, install]));
    }
  } catch (err) {
    list.innerHTML = '';
    toast('Search failed: ' + err.message, true);
  }
}

$('mod-search-btn').addEventListener('click', searchMods);
$('mod-search').addEventListener('keydown', e => { if (e.key === 'Enter') searchMods(); });
$('open-mods-btn').addEventListener('click', () => call('openModsFolder', modsPackId));

// ---------- settings ----------

async function loadSettings() {
  const cfg = await call('getConfig');
  $('min-ram').value = cfg.minRam;
  $('max-ram').value = cfg.maxRam;
  $('java-path').value = cfg.javaPath;
  $('azure-id').value = cfg.azureClientId;
  const version = await call('getAppVersion');
  $('app-version').textContent = `(v${version})`;
}

$('save-settings').addEventListener('click', async () => {
  await call('setConfig', {
    minRam: Math.max(1, parseInt($('min-ram').value) || 2),
    maxRam: Math.max(1, parseInt($('max-ram').value) || 4),
    javaPath: $('java-path').value.trim(),
    azureClientId: $('azure-id').value.trim()
  });
  const note = $('settings-saved');
  note.classList.remove('hidden');
  setTimeout(() => note.classList.add('hidden'), 2000);
});

$('open-game-dir').addEventListener('click', () => call('openGameFolder'));

// ---------- updates ----------

$('check-update-btn').addEventListener('click', async () => {
  $('update-status').textContent = 'Checking…';
  try {
    await call('checkUpdates');
  } catch (err) {
    $('update-status').textContent = 'Check failed';
    toast(err.message, true);
  }
});

window.daylight.onUpdateAvailable(version => {
  $('update-status').textContent = `Downloading v${version}…`;
});

window.daylight.onUpdateNone(() => {
  $('update-status').textContent = 'Up to date';
});

window.daylight.onUpdateProgress(pct => {
  $('update-status').textContent = `Downloading update… ${pct}%`;
});

window.daylight.onUpdateReady(version => {
  $('update-status').textContent = `v${version} ready`;
  $('check-update-btn').textContent = 'Restart & update';
  $('check-update-btn').onclick = () => call('installUpdate');
  toast(`Update v${version} downloaded — restart to apply`);
});

window.daylight.onUpdateError(msg => {
  $('update-status').textContent = 'Update check failed';
});

// ---------- init ----------

// The version list needs the network; keep trying in the background so a
// cold boot (network not up yet) never blocks anything.
async function loadVersions(attempt = 0) {
  try {
    versions = await call('getVersions');
    if (versions.length) {
      if (document.getElementById('tab-packs').classList.contains('active')) renderPackGrid();
      return;
    }
  } catch { /* offline — retry below */ }
  if (attempt < 6) setTimeout(() => loadVersions(attempt + 1), 5000);
}

(async function init() {
  // 1. Local data first — this reads config on disk and must NEVER be blocked
  //    by the network, or a cold boot hides the user's packs.
  try {
    await loadSettings();
    await refreshPacks();
  } catch (err) {
    toast('Failed to load launcher data: ' + err.message, true);
  }

  // 2. Version list (network) — optional; failure must not hide packs.
  loadVersions();

  // 3. Account (network) — optional.
  try {
    profile = await call('silentLogin');
    accounts = await call('listAccounts');
  } catch { /* stay logged out */ }
  renderAccount();
})();
