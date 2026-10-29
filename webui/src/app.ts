import { buildManagedArgs, getArgValue, getBooleanArg, preserveUnmanagedArgs, splitArgs } from './up-args';
import { isVisiblePeer, peerDisplayName, peerPath, peerProbeIsStale, peerStableKey, type PeerView, type StoredPeerProbe } from './peers';
import { formatNetcheckSummary, parseRuntimeConfigImport, RuntimeClient, type ActionName, type HealthReport, type NetcheckResult, type RuntimeConfig, type Snapshot, type TailscaleStatus } from './runtime';

const client = new RuntimeClient();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $(id) as HTMLInputElement;
const select = (id: string) => $(id) as HTMLSelectElement;

let configDirty = false;
let refreshInFlight: Promise<void> | null = null;
let latestSnapshot: Snapshot | null = null;
let latestHealth: HealthReport | null = null;
let latestNetcheck: NetcheckResult | null = null;
let preservedUpArgs: string[] = [];
let runtimeReady = false;
let operationBusy = false;
let saveInFlight = false;
let diagnosticBusy = false;
let peerTestingIp = '';
let refreshTimer = 0;
let lastStatusSignature = '';
let lastConfigSignature = '';
let exitNodesSignature = '';
let lastSuccessfulRefreshAt = 0;
const peerProbes = new Map<string, StoredPeerProbe>();
const peerCards = new Map<string, HTMLElement>();
const peerModels = new Map<string, string>();

function removeArgs(args: string[], prefixes: string[], consumeValueFor: string[] = []) {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const matched = prefixes.find(prefix => args[index] === prefix || args[index].startsWith(`${prefix}=`));
    if (!matched) kept.push(args[index]);
    else if (consumeValueFor.includes(matched) && args[index] === matched && args[index + 1] && !args[index + 1].startsWith('-')) index += 1;
  }
  return kept;
}

function setDirty(dirty = true) {
  configDirty = dirty;
  $('dirty').textContent = dirty ? 'Unsaved changes' : 'Saved';
  $('dirty').classList.toggle('dirty', dirty);
  $('saveBar').classList.toggle('clean', !dirty);
  $('saveBar').setAttribute('aria-hidden', String(!dirty));
}

function setOutput(text: string) {
  const element = $('output');
  element.replaceChildren();
  const value = text || 'OK';
  const urlPattern = /(https?:\/\/[^\s<]+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(value))) {
    element.append(document.createTextNode(value.slice(lastIndex, match.index)));
    const displayUrl = match[1].replace(/[),.;]+$/, '');
    try {
      const url = new URL(displayUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported URL scheme');
      const link = document.createElement('a');
      link.href = url.toString();
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = displayUrl;
      element.append(link);
    } catch {
      element.append(document.createTextNode(displayUrl));
    }
    lastIndex = match.index + match[1].length;
  }
  element.append(document.createTextNode(value.slice(lastIndex)));
}

function setLoginUrl(value = '') {
  const box = $('loginUrlBox');
  const link = $('loginUrl') as HTMLAnchorElement;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported URL scheme');
    link.href = url.toString();
    link.textContent = url.toString();
    box.classList.remove('hidden');
  } catch {
    link.removeAttribute('href');
    link.textContent = '';
    box.classList.add('hidden');
  }
}

function updateActionAvailability() {
  document.querySelectorAll<HTMLButtonElement>('.action-grid .btn').forEach(button => {
    button.disabled = operationBusy || saveInFlight || diagnosticBusy || !runtimeReady;
  });
  ($('save') as HTMLButtonElement).disabled = operationBusy || saveInFlight || diagnosticBusy || !runtimeReady;
  ['netcheck', 'healthCheck', 'copyReport', 'exportConfig', 'importConfig'].forEach(id => {
    const button = $(id) as HTMLButtonElement;
    button.disabled = operationBusy || saveInFlight || diagnosticBusy || (!runtimeReady && id !== 'importConfig');
  });
  document.querySelectorAll<HTMLButtonElement>('.peer-test').forEach(button => {
    button.disabled = operationBusy || saveInFlight || diagnosticBusy || !runtimeReady || button.dataset.available !== 'true';
  });
  ($('refresh') as HTMLButtonElement).disabled = diagnosticBusy || refreshInFlight !== null;
}

function setOperation(text = '', busy = false) {
  operationBusy = busy;
  $('operation').textContent = text;
  updateActionAvailability();
}

function normalizeLoginServer(value: string) {
  let url = value.trim().replace(/\/+$/, '');
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const parsed = new URL(url);
    const plainOrigin = !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname === '/';
    return ['http:', 'https:'].includes(parsed.protocol) && plainOrigin ? parsed.origin : '';
  } catch {
    return '';
  }
}

function buildArgsFromUi(markDirty = true) {
  const exitNode = select('exitNode').value;
  const args = buildManagedArgs({
    disableDns: input('acceptDns').checked,
    acceptRoutes: input('acceptRoutes').checked,
    advertiseExitNode: input('advertiseExitNode').checked,
    shieldsUp: input('shieldsUp').checked,
    exitNode,
    allowLan: input('allowLan').checked,
    ssh: input('tailscaleSsh').checked,
  }, preservedUpArgs);
  input('allowLan').disabled = !exitNode;
  input('upArgs').value = args.join(' ');
  if (markDirty) setDirty(true);
  return input('upArgs').value;
}

function populateArgsUi(upArgs: string) {
  const args = splitArgs(upArgs);
  input('acceptDns').checked = getBooleanArg(args, '--accept-dns') === false;
  input('acceptRoutes').checked = getBooleanArg(args, '--accept-routes') === true;
  input('advertiseExitNode').checked = getBooleanArg(args, '--advertise-exit-node') === true;
  input('allowLan').checked = getBooleanArg(args, '--exit-node-allow-lan-access') === true;
  input('shieldsUp').checked = getBooleanArg(args, '--shields-up') === true;
  input('tailscaleSsh').checked = getBooleanArg(args, '--ssh') === true;
  const exitNode = getArgValue(args, '--exit-node');
  if (exitNode) select('exitNode').value = exitNode;
  preservedUpArgs = preserveUnmanagedArgs(args);
  buildArgsFromUi(false);
}

function loadExitNodes(status: TailscaleStatus, selected?: string) {
  const current = selected ?? select('exitNode').value;
  const peers = status.Peer ? Object.values(status.Peer) : [];
  const values = peers.filter(item => item.ExitNodeOption).map(peer => {
    const value = peer.TailscaleIPs?.[0] || peer.DNSName || peer.HostName || '';
    return value ? { value, label: `${peer.HostName || peer.DNSName || value}${peer.Online ? '' : ' (offline)'} — ${value}` } : null;
  }).filter((value): value is { value: string; label: string } => Boolean(value));
  if (current && !values.some(option => option.value === current)) values.push({ value: current, label: `${current} (current config, currently unavailable)` });
  const signature = JSON.stringify({ current, values });
  if (signature !== exitNodesSignature) {
    select('exitNode').replaceChildren(new Option('None / clear', ''), ...values.map(option => new Option(option.label, option.value)));
    exitNodesSignature = signature;
  }
  select('exitNode').value = current;
  input('allowLan').disabled = !current;
}

function formatLastSeen(value?: string) {
  if (!value) return '';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time) || time <= 0) return '';
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function createPeerCard(key: string) {
  const card = document.createElement('article');
  card.className = 'peer-card';
  card.dataset.peerKey = key;
  card.innerHTML = '<div class="peer-header"><div class="peer-identity"><span class="peer-dot"></span><div><strong class="peer-name"></strong><small class="peer-meta"></small></div></div><button class="text-btn peer-test">Probe</button></div><div class="peer-details"><code class="peer-address"></code><span class="route-badge"></span></div><div class="peer-result hidden"></div>';
  peerCards.set(key, card);
  return card;
}

function probeText(probe: StoredPeerProbe, peer: PeerView) {
  const stale = peerProbeIsStale(probe, peer);
  const replies = `${probe.samples.length}/5 replies`;
  const average = probe.averageMs === undefined ? '' : ` · avg ${probe.averageMs.toFixed(probe.averageMs < 10 ? 1 : 0)} ms`;
  const tested = new Date(probe.testedAt).toLocaleTimeString();
  return `This probe: ${probe.sequence.join(' → ') || 'No reply'}\nLast probed path: ${probe.lastPath}\n${replies}${average} · ${tested}${stale ? ' · stale' : ''}`;
}

function updatePeerCard(card: HTMLElement, peer: PeerView, ip: string) {
  const path = peerPath(peer);
  const dnsName = peer.DNSName?.replace(/\.$/, '');
  const lastSeen = !peer.Online ? formatLastSeen(peer.LastSeen) : '';
  card.querySelector<HTMLElement>('.peer-dot')!.className = `peer-dot ${peer.Online ? peer.Active ? 'active' : 'online' : 'offline'}`;
  card.querySelector<HTMLElement>('.peer-name')!.textContent = peerDisplayName(peer);
  card.querySelector<HTMLElement>('.peer-meta')!.textContent = [peer.OS, dnsName !== peer.HostName ? dnsName : '', lastSeen].filter(Boolean).join(' · ') || 'Peer';
  card.querySelector<HTMLElement>('.peer-address')!.textContent = peer.TailscaleIPs?.join(', ') || '-';
  const route = card.querySelector<HTMLElement>('.route-badge')!;
  route.className = `route-badge ${path.kind}`;
  route.textContent = `Status path (recent activity): ${path.label}${peer.ExitNode ? ' · current exit node' : peer.ExitNodeOption ? ' · exit node option' : ''}`;
  const button = card.querySelector<HTMLButtonElement>('.peer-test')!;
  button.textContent = peerTestingIp === ip ? 'Probing…' : 'Probe';
  button.dataset.peerIp = ip;
  button.dataset.available = String(Boolean(peer.Online && ip));
  const result = card.querySelector<HTMLElement>('.peer-result')!;
  const probe = ip ? peerProbes.get(ip) : undefined;
  result.textContent = peerTestingIp === ip ? 'Running 5 on-demand probes…' : probe ? probeText(probe, peer) : '';
  result.classList.toggle('hidden', !result.textContent);
}

function peerEntries(status: TailscaleStatus) {
  return Object.entries(status.Peer || {}).filter(([, peer]) => isVisiblePeer(peer)).sort(([, left], [, right]) =>
    Number(Boolean(right.Online)) - Number(Boolean(left.Online)) || Number(Boolean(right.Active)) - Number(Boolean(left.Active)) || peerDisplayName(left).localeCompare(peerDisplayName(right)));
}

function peerViewModel(peer: PeerView) {
  return {
    ID: peer.ID,
    HostName: peer.HostName,
    DNSName: peer.DNSName,
    TailscaleIPs: peer.TailscaleIPs,
    CurAddr: peer.CurAddr,
    Relay: peer.Relay,
    PeerRelay: peer.PeerRelay,
    Online: peer.Online,
    Active: peer.Active,
    ExitNode: peer.ExitNode,
    ExitNodeOption: peer.ExitNodeOption,
    OS: peer.OS,
    LastSeen: peer.LastSeen,
    LastSeenLabel: peer.Online ? '' : formatLastSeen(peer.LastSeen),
  };
}

function renderPeers(status: TailscaleStatus) {
  const entries = peerEntries(status);
  $('peerCount').textContent = entries.length ? `${entries.filter(([, peer]) => peer.Online).length} online / ${entries.length}` : 'No Peers';
  const activeKeys = new Set<string>();
  const orderedCards: HTMLElement[] = [];
  for (const [statusKey, peer] of entries) {
    const key = peerStableKey(statusKey, peer);
    const ip = peer.TailscaleIPs?.[0] || '';
    const probe = ip ? peerProbes.get(ip) : undefined;
    const model = JSON.stringify({ peer: peerViewModel(peer), testing: peerTestingIp === ip, probe: probe ? { ...probe, raw: undefined } : null, stale: probe ? peerProbeIsStale(probe, peer) : false });
    const card = peerCards.get(key) || createPeerCard(key);
    if (peerModels.get(key) !== model) {
      updatePeerCard(card, peer, ip);
      peerModels.set(key, model);
    }
    activeKeys.add(key);
    orderedCards.push(card);
  }
  for (const [key, card] of peerCards) {
    if (!activeKeys.has(key)) {
      card.remove();
      peerCards.delete(key);
      peerModels.delete(key);
    }
  }
  if (!orderedCards.length) {
    $('peerList').replaceChildren(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'No Peers.' }));
  } else {
    const current = Array.from($('peerList').children);
    if (current.length !== orderedCards.length || current.some((card, index) => card !== orderedCards[index])) {
      if (current.some(card => !card.classList.contains('peer-card'))) $('peerList').replaceChildren(...orderedCards);
      else $('peerList').append(...orderedCards);
    }
  }
  updateActionAvailability();
}

function renderStatus(snapshot: Snapshot) {
  const backend = snapshot.status.BackendState || '-';
  const online = backend === 'Running';
  const daemonRunning = snapshot.daemon === 'running';
  $('statusLabel').textContent = online ? 'Connected' : daemonRunning ? 'Daemon running' : 'Stopped';
  $('statusDetail').textContent = online ? 'Tailscale backend OK' : daemonRunning ? `Backend: ${backend}` : 'Service not running';
  $('statusDot').className = `status-dot ${online ? 'online' : daemonRunning ? 'busy' : 'error'}`;
  $('ip').textContent = (snapshot.status.Self?.TailscaleIPs || []).join(', ') || snapshot.ip || '-';
  const peers = peerEntries(snapshot.status);
  $('peers').textContent = peers.length ? `${peers.filter(([, peer]) => peer.Online).length} online / ${peers.length}` : '-';
  $('relay').textContent = snapshot.status.Self?.Relay || '-';
  renderPeers(snapshot.status);
}

function populateConfig(config: RuntimeConfig) {
  const upArgs = String(config.upArgs || '');
  const extraArgs = String(config.extraUpArgs || '');
  input('startOnBoot').checked = ['1', 'true'].includes(config.startOnBoot || '');
  input('watchdogEnabled').checked = ['1', 'true'].includes(config.watchdogEnabled || '');
  input('loginServer').value = config.loginServer || getArgValue(splitArgs(`${upArgs} ${extraArgs}`), '--login-server');
  input('hostname').value = config.hostname || '';
  input('daemonArgs').value = config.daemonArgs || '';
  input('logMaxKb').value = config.logMaxKb || '1024';
  populateArgsUi(removeArgs(splitArgs(upArgs), ['--login-server'], ['--login-server']).join(' '));
  input('tailscaleSsh').checked = ['1', 'true'].includes(config.enableSsh || '') || input('tailscaleSsh').checked;
  input('extraUpArgs').value = removeArgs(splitArgs(extraArgs), ['--login-server'], ['--login-server']).join(' ');
  buildArgsFromUi(false);
}

function uiConfig(): RuntimeConfig | null {
  buildArgsFromUi(false);
  const loginServer = normalizeLoginServer(input('loginServer').value);
  if (input('loginServer').value.trim() && !loginServer) {
    setOutput('Invalid control server URL.');
    return null;
  }
  const logMaxKb = input('logMaxKb').value.trim();
  if (!/^\d+$/.test(logMaxKb) || Number(logMaxKb) < 128 || Number(logMaxKb) > 10240) {
    setOutput('Log size limit must be between 128 and 10240 KB.');
    return null;
  }
  return {
    startOnBoot: input('startOnBoot').checked ? '1' : '0',
    enableSsh: input('tailscaleSsh').checked ? '1' : '0',
    loginServer,
    hostname: input('hostname').value,
    upArgs: input('upArgs').value,
    extraUpArgs: input('extraUpArgs').value,
    daemonArgs: input('daemonArgs').value,
    watchdogEnabled: input('watchdogEnabled').checked ? '1' : '0',
    logMaxKb,
  };
}

function renderLog(log: string) {
  if ($('log').textContent !== (log || 'No log yet')) $('log').textContent = log || 'No log yet';
  if (latestSnapshot) latestSnapshot.log = log;
}

function clearRefreshTimer() {
  if (refreshTimer) window.clearTimeout(refreshTimer);
  refreshTimer = 0;
}

function scheduleRefresh(delay: number) {
  clearRefreshTimer();
  if (document.hidden || diagnosticBusy) return;
  refreshTimer = window.setTimeout(() => { void refresh(); }, delay);
}

function snapshotSignature(snapshot: Snapshot) {
  return JSON.stringify({
    daemon: snapshot.daemon,
    backend: snapshot.status.BackendState,
    self: {
      TailscaleIPs: snapshot.status.Self?.TailscaleIPs,
      Relay: snapshot.status.Self?.Relay,
    },
    peers: peerEntries(snapshot.status).map(([key, peer]) => [peerStableKey(key, peer), peerViewModel(peer)]),
  });
}

async function refresh(forceFresh = false): Promise<void> {
  if ((document.hidden || diagnosticBusy) && !forceFresh) return;
  clearRefreshTimer();
  if (refreshInFlight) {
    const current = refreshInFlight;
    if (!forceFresh) return current;
    await current;
  }
  const button = $('refresh') as HTMLButtonElement;
  button.disabled = true;
  button.classList.add('busy');
  const request = (async () => {
    const snapshot = await client.snapshot();
    const signature = snapshotSignature(snapshot);
    const changed = signature !== lastStatusSignature;
    latestSnapshot = snapshot;
    renderStatus(snapshot);
    const selected = configDirty ? select('exitNode').value : getArgValue(splitArgs(String(snapshot.config.upArgs || '')), '--exit-node');
    loadExitNodes(snapshot.status, selected);
    renderLog(snapshot.log);
    const configSignature = JSON.stringify(snapshot.config);
    if (!configDirty && configSignature !== lastConfigSignature) populateConfig(snapshot.config);
    lastConfigSignature = configSignature;
    lastStatusSignature = signature;
    lastSuccessfulRefreshAt = Date.now();
    $('updated').textContent = `Last updated ${new Date(lastSuccessfulRefreshAt).toLocaleTimeString()}`;
    runtimeReady = true;
    const backend = snapshot.status.BackendState;
    scheduleRefresh(backend !== 'Running' ? 10000 : changed ? 15000 : 30000);
  })().catch(error => {
    runtimeReady = latestSnapshot !== null;
    $('updated').textContent = lastSuccessfulRefreshAt
      ? `Data may be stale · last success ${new Date(lastSuccessfulRefreshAt).toLocaleTimeString()}`
      : 'Status read failed · retrying automatically';
    if (!latestSnapshot) {
      $('statusLabel').textContent = 'Read failed';
      $('statusDetail').textContent = error instanceof Error ? error.message : String(error);
      $('statusDot').className = 'status-dot error';
    }
    scheduleRefresh(60000);
  }).finally(() => {
    refreshInFlight = null;
    button.disabled = false;
    button.classList.remove('busy');
    updateActionAvailability();
  });
  refreshInFlight = request;
  updateActionAvailability();
  return request;
}

async function refreshLog() {
  const button = $('refreshLog') as HTMLButtonElement;
  button.disabled = true;
  button.textContent = 'Refreshing…';
  try { renderLog(await client.log()); }
  catch (error) { setOutput(`Failed to read log: ${error instanceof Error ? error.message : String(error)}`); }
  finally { button.disabled = false; button.textContent = 'Refresh log'; }
}

async function saveConfig(refreshAfterSave = true) {
  if (saveInFlight || operationBusy || diagnosticBusy) return false;
  const config = uiConfig();
  if (!config) return false;
  saveInFlight = true;
  updateActionAvailability();
  const button = $('save') as HTMLButtonElement;
  button.textContent = 'Saving…';
  setOutput('Saving config…');
  try {
    await client.saveConfig(config);
    setDirty(false);
    lastConfigSignature = JSON.stringify(config);
    setOutput('Config saved. Click "Apply and connect" to apply the up arguments.');
    if (refreshAfterSave) await refresh(true);
    return true;
  } catch (error) {
    setOutput(`Save failed:\n${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    saveInFlight = false;
    button.textContent = 'Save config';
    updateActionAvailability();
  }
}

async function runAction(action: ActionName, message: string) {
  if (operationBusy || saveInFlight || diagnosticBusy) return false;
  setOperation(message, true);
  setOutput(message);
  if (action === 'login') setLoginUrl();
  clearRefreshTimer();
  const button = $(action) as HTMLButtonElement;
  const buttonText = button.textContent || '';
  const busyText = action === 'login' ? 'Waiting for URL…' : action === 'up' ? 'Connecting…' : action === 'down' ? 'Disconnecting…' : 'Restarting…';
  button.textContent = busyText;
  try {
    const result = await client.action(action, {
      onProgress: progress => {
        renderLog(progress.log);
        if (progress.url) setLoginUrl(progress.url);
      },
    });
    if (result.log) renderLog(result.log);
    if (result.url) setLoginUrl(result.url);
    setOutput(result.message);
    if (result.background) scheduleRefresh(1500);
    else await refresh(true);
    return true;
  } catch (error) {
    setOutput(`Operation failed:\n${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    button.textContent = buttonText;
    setOperation('', false);
    scheduleRefresh(1000);
  }
}

async function runPeerTest(ip: string) {
  if (!ip || diagnosticBusy || operationBusy || saveInFlight || !latestSnapshot) return;
  diagnosticBusy = true;
  peerTestingIp = ip;
  clearRefreshTimer();
  renderPeers(latestSnapshot.status);
  updateActionAvailability();
  try {
    const probe = await client.peerProbe(ip);
    await refresh(true);
    const peer = Object.values(latestSnapshot?.status.Peer || {}).find(item => item.TailscaleIPs?.includes(ip));
    peerProbes.set(ip, { ...probe, statusPathAtTest: peer ? peerPath(peer).label : '' });
    const average = probe.averageMs === undefined ? '' : `, avg ${probe.averageMs.toFixed(1)} ms`;
    setOutput(`Peer ${ip}: ${probe.samples.length}/5 replies${average}\nPath: ${probe.sequence.join(' → ') || 'No reply'}\nLast probed path: ${probe.lastPath}`);
  } catch (error) {
    setOutput(`Peer probe failed:\n${error instanceof Error ? error.message : String(error)}`);
  } finally {
    peerTestingIp = '';
    diagnosticBusy = false;
    if (latestSnapshot) renderPeers(latestSnapshot.status);
    updateActionAvailability();
    scheduleRefresh(1000);
  }
}

async function runNetcheck() {
  if (diagnosticBusy || operationBusy || saveInFlight) return;
  diagnosticBusy = true;
  clearRefreshTimer();
  updateActionAvailability();
  const button = $('netcheck') as HTMLButtonElement;
  button.textContent = 'Checking…';
  $('netcheckSummary').textContent = 'Probing UDP, IPv4/IPv6, port mapping, and DERP latency…';
  $('netcheckRaw').textContent = '';
  try {
    latestNetcheck = await client.netcheck();
    $('netcheckSummary').textContent = formatNetcheckSummary(latestNetcheck);
    $('netcheckRaw').textContent = `${JSON.stringify(latestNetcheck.report, null, 2)}${latestNetcheck.warnings ? `\n\nWarnings:\n${latestNetcheck.warnings}` : ''}`;
    setOutput('Netcheck completed.');
  } catch (error) {
    $('netcheckSummary').textContent = `Netcheck failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    diagnosticBusy = false;
    button.textContent = 'Run Netcheck';
    updateActionAvailability();
    scheduleRefresh(1000);
  }
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1048576).toFixed(1)} MB`;
}

function renderHealth(report: HealthReport) {
  const items = [
    ['Daemon', report.daemonRunning ? 'Running' : 'Stopped'],
    ['Backend / TUN', `${report.backend} / ${report.tun ? 'on' : 'off'}`],
    ['Module / CLI', `${report.moduleVersion || '-'} / ${report.cliVersion || '-'}`],
    ['SELinux', report.selinux],
    ['Config', `${report.config.valid && report.config.readable ? 'OK' : 'Error'} · ${report.config.mode}`],
    ['Watchdog', `${report.watchdog.enabled ? report.watchdog.running ? 'Running' : 'Enabled but not running' : 'Off'} · restarts ${report.watchdog.restarts}`],
    ['Logs', `daemon ${formatBytes(report.logs.daemonBytes)} · operations ${formatBytes(report.logs.runBytes)}`],
    ['Tailscale Health', report.health.length ? report.health.join('; ') : 'No warnings'],
  ];
  $('healthGrid').replaceChildren(...items.map(([label, value]) => {
    const item = document.createElement('div');
    const name = document.createElement('span');
    const result = document.createElement('strong');
    name.textContent = label;
    result.textContent = value;
    item.append(name, result);
    return item;
  }));
}

async function runHealth() {
  if (diagnosticBusy || operationBusy || saveInFlight) return;
  diagnosticBusy = true;
  clearRefreshTimer();
  updateActionAvailability();
  const button = $('healthCheck') as HTMLButtonElement;
  button.textContent = 'Checking…';
  try {
    latestHealth = await client.health();
    renderHealth(latestHealth);
    setOutput('Health check completed.');
  } catch (error) {
    setOutput(`Health check failed:\n${error instanceof Error ? error.message : String(error)}`);
  } finally {
    diagnosticBusy = false;
    button.textContent = 'Run health check';
    updateActionAvailability();
    scheduleRefresh(1000);
  }
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const area = document.createElement('textarea');
  area.value = value;
  document.body.append(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

function redactedReport() {
  if (!latestHealth) return '';
  const netcheck = latestNetcheck?.report;
  return JSON.stringify({
    moduleVersion: latestHealth.moduleVersion,
    cliVersion: latestHealth.cliVersion,
    daemonRunning: latestHealth.daemonRunning,
    backend: latestHealth.backend,
    tun: latestHealth.tun,
    healthIssueCount: latestHealth.health.length,
    selinux: latestHealth.selinux,
    config: latestHealth.config,
    watchdog: latestHealth.watchdog,
    logs: latestHealth.logs,
    netcheck: netcheck ? {
      UDP: netcheck.UDP,
      IPv4: netcheck.IPv4,
      IPv6: netcheck.IPv6,
      MappingVariesByDestIP: netcheck.MappingVariesByDestIP,
      UPnP: netcheck.UPnP,
      PMP: netcheck.PMP,
      PCP: netcheck.PCP,
      PreferredDERP: netcheck.PreferredDERP,
    } : null,
  }, null, 2);
}

async function copyReport() {
  if (!latestHealth) await runHealth();
  const report = redactedReport();
  if (!report) return;
  try { await copyText(report); setOutput('Redacted diagnostic report copied.'); }
  catch (error) { setOutput(`Copy failed: ${error instanceof Error ? error.message : String(error)}`); }
}

async function exportConfig() {
  const config = latestSnapshot?.config;
  if (!config) { setOutput('Runtime config has not been read yet.'); return; }
  const text = JSON.stringify(config, null, 2);
  input('configTransfer').value = text;
  try { await copyText(text); setOutput('Config JSON copied; it contains no node state or keys.'); }
  catch { setOutput('Config JSON placed in the text box.'); }
}

function importConfig() {
  try {
    if (!latestSnapshot) throw new Error('Runtime config has not been read yet; cannot import');
    const imported = parseRuntimeConfigImport(input('configTransfer').value);
    populateConfig({ ...latestSnapshot.config, ...imported });
    setDirty(true);
    setOutput('Config imported into the form but not saved. Review it, then click "Save config".');
  } catch (error) {
    setOutput(`Config import failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function init() {
  updateActionAvailability();
  $('refresh').addEventListener('click', () => refresh(true));
  $('refreshLog').addEventListener('click', refreshLog);
  $('netcheck').addEventListener('click', runNetcheck);
  $('healthCheck').addEventListener('click', runHealth);
  $('copyReport').addEventListener('click', copyReport);
  $('copyLoginUrl').addEventListener('click', async () => {
    const url = ($('loginUrl') as HTMLAnchorElement).href;
    if (!url) return;
    try { await copyText(url); setOutput('Login URL copied.'); }
    catch (error) { setOutput(`Copy failed: ${error instanceof Error ? error.message : String(error)}`); }
  });
  $('exportConfig').addEventListener('click', exportConfig);
  $('importConfig').addEventListener('click', importConfig);
  $('peerList').addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.peer-test');
    if (button?.dataset.peerIp) void runPeerTest(button.dataset.peerIp);
  });
  $('login').addEventListener('click', () => runAction('login', 'Starting login and waiting for URL…'));
  $('up').addEventListener('click', async () => { if (await saveConfig(false)) await runAction('up', 'Applying config…'); });
  $('down').addEventListener('click', () => runAction('down', 'Disconnecting…'));
  $('restart').addEventListener('click', () => runAction('restart', 'Restarting daemon…'));
  $('save').addEventListener('click', () => saveConfig());
  ['startOnBoot', 'watchdogEnabled', 'acceptDns', 'acceptRoutes', 'tailscaleSsh', 'advertiseExitNode', 'allowLan', 'shieldsUp', 'exitNode']
    .forEach(id => $(id).addEventListener('change', () => buildArgsFromUi(true)));
  ['loginServer', 'hostname', 'extraUpArgs', 'daemonArgs', 'logMaxKb']
    .forEach(id => $(id).addEventListener('input', () => setDirty(true)));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearRefreshTimer();
    else void refresh(true);
  });
  void refresh(true);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
