const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, dialog, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { loadJsonFile, saveJsonFileAtomic } = require('./main/atomic-json-store');
const {
  GROUP_COLORS,
  createEmptyAliasStore,
  createEmptyGroupStore,
  normalizeAlias,
  normalizeAliasStore,
  normalizeGroupColor,
  normalizeGroupName,
  normalizeGroupStore
} = require('./main/config-schema');
const { DEFAULT_EVENT_DEDUPE_MS, DEFAULT_EVENT_LIMIT, addPortEvent, clearEventHistory, createEventHistory } = require('./main/port-event-history');
const { createEventBubbleContent } = require('./main/event-bubble-content');
const { registerSerialIpcHandlers, registerWindowIpcHandlers } = require('./main/serial-ipc');
const { queryFastPortNames, querySerialPorts } = require('./main/serial-scanner');
const { sortPorts } = require('./main/serial-utils');
const { createTrayMenuTemplate } = require('./main/tray-menu');
const { createTrayTooltip } = require('./main/tray-tooltip');
const { getCloseResponseAction, showWindowIfAvailable } = require('./main/window-lifecycle');

const FAST_POLL_INTERVAL_MS = 500;
const FULL_REFRESH_INTERVAL_MS = 5000;
const REMOVAL_CONFIRM_POLLS = 2;
const DEFAULT_WINDOW_WIDTH = 1180;
const DEFAULT_WINDOW_HEIGHT = 760;
const EVENT_BUBBLE_WIDTH = 364;
const EVENT_BUBBLE_HEIGHT = 124;
const EVENT_BUBBLE_MARGIN = 16;
const EVENT_BUBBLE_COALESCE_MS = 180;
const EVENT_BUBBLE_DISMISS_MS = 5000;
const ICON_PATH = path.join(__dirname, '..', 'assets', 'app.ico');

let mainWindow;
let tray;
let eventBubbleWindow;
let aliases = {};
let groupStore = createEmptyGroupStore();
let ports = [];
let eventHistory = createEventHistory({ limit: DEFAULT_EVENT_LIMIT, dedupeMs: DEFAULT_EVENT_DEDUPE_MS });
let portInfoCache = new Map();
let pendingBubbleEvents = [];
let fastKnownPortNames = new Set();
let missingPortCounts = new Map();
let presenceInitialized = false;
let isReadyForEventBubbles = false;
let fastPollTimer;
let fullRefreshTimer;
let bubbleBatchTimer;
let bubbleDismissTimer;
let queryInFlight = false;
let fastQueryInFlight = false;

function getDataDir() {
  if (app.isPackaged && process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data');
  }

  if (app.isPackaged) {
    return path.join(path.dirname(app.getPath('exe')), 'data');
  }

  return path.join(app.getAppPath(), 'data');
}

function getAliasesFile() {
  return path.join(getDataDir(), 'port-aliases.json');
}

function getGroupsFile() {
  return path.join(getDataDir(), 'port-groups.json');
}

function ensureDataDir() {
  fs.mkdirSync(getDataDir(), { recursive: true });
}

function loadAliases() {
  ensureDataDir();
  aliases = normalizeAliasStore(loadJsonFile(getAliasesFile(), createEmptyAliasStore())).aliases;
}

function saveAliases() {
  saveJsonFileAtomic(getAliasesFile(), normalizeAliasStore(aliases));
}

function loadGroups() {
  ensureDataDir();
  groupStore = normalizeGroupStore(loadJsonFile(getGroupsFile(), createEmptyGroupStore()));
}

function saveGroups() {
  saveJsonFileAtomic(getGroupsFile(), normalizeGroupStore(groupStore));
}

function createGroupId() {
  return `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function createTrayImage() {
  return nativeImage.createFromPath(ICON_PATH);
}

function getAliasForPort(port) {
  return aliases[port.deviceKey] || aliases[`port:${port.portName}`] || '';
}

function getGroupIdForPort(port) {
  const groupId = groupStore.assignments[port.deviceKey] || groupStore.assignments[`port:${port.portName}`] || '';
  return groupStore.groups.some((group) => group.id === groupId) ? groupId : '';
}

function getGroupForPort(port) {
  const groupId = getGroupIdForPort(port);
  return groupStore.groups.find((group) => group.id === groupId) || null;
}

function decoratePort(port) {
  const group = getGroupForPort(port);
  return {
    ...port,
    alias: getAliasForPort(port),
    groupId: group ? group.id : '',
    groupName: group ? group.name : '',
    groupColor: group ? group.color : ''
  };
}

function getDisplayLabel(port) {
  const alias = getAliasForPort(port);
  return alias ? `${alias} (${port.portName})` : port.portName;
}

function cachePortInfo(list) {
  for (const port of list) {
    if (port.portName && port.deviceKey && !String(port.deviceKey).startsWith('port:')) {
      portInfoCache.set(port.portName, { ...port });
    }
  }
}

function getBestKnownPort(portName) {
  const current = ports.find((port) => port.portName === portName);
  const cached = portInfoCache.get(portName);
  return cached || current || createPlaceholderPort(portName);
}

function createPlaceholderPort(portName) {
  const cached = portInfoCache.get(portName);
  if (cached) {
    return { ...cached, alias: getAliasForPort(cached) };
  }

  return {
    portName,
    deviceKey: `port:${portName}`,
    name: '',
    caption: '',
    description: '',
    manufacturer: '',
    status: 'OK',
    openState: 'unknown',
    service: '',
    alias: aliases[`port:${portName}`] || ''
  };
}

function createSnapshot() {
  return {
    ports: ports.map(decoratePort),
    groups: groupStore.groups.map((group) => ({ ...group })),
    orders: Object.fromEntries(Object.entries(groupStore.orders).map(([key, value]) => [key, [...value]])),
    events: eventHistory.events,
    updatedAt: new Date().toISOString()
  };
}

function sendSnapshot() {
  const snapshot = createSnapshot();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('serial:snapshot', snapshot);
  }
}

function shouldShowBackgroundBubble() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return true;
  }

  return !mainWindow.isVisible() || !mainWindow.isFocused();
}

function createEventBubbleWindow() {
  if (eventBubbleWindow && !eventBubbleWindow.isDestroyed()) {
    return eventBubbleWindow;
  }

  eventBubbleWindow = new BrowserWindow({
    width: EVENT_BUBBLE_WIDTH,
    height: EVENT_BUBBLE_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: '串口事件',
    webPreferences: {
      preload: path.join(__dirname, 'event-bubble-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  eventBubbleWindow.setAlwaysOnTop(true, 'floating');
  eventBubbleWindow.loadFile(path.join(__dirname, 'event-bubble.html'));
  eventBubbleWindow.on('closed', () => {
    eventBubbleWindow = null;
  });

  return eventBubbleWindow;
}

function positionEventBubble(window) {
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const { x, y, width, height } = display.workArea;
  window.setPosition(
    x + width - EVENT_BUBBLE_WIDTH - EVENT_BUBBLE_MARGIN,
    y + height - EVENT_BUBBLE_HEIGHT - EVENT_BUBBLE_MARGIN,
    false
  );
}

function clearEventBubbleTimers({ clearBatch = false } = {}) {
  clearTimeout(bubbleDismissTimer);
  bubbleDismissTimer = undefined;
  if (clearBatch) {
    clearTimeout(bubbleBatchTimer);
    bubbleBatchTimer = undefined;
    pendingBubbleEvents = [];
  }
}

function hideEventBubble({ clearPending = true } = {}) {
  clearEventBubbleTimers({ clearBatch: clearPending });
  if (eventBubbleWindow && !eventBubbleWindow.isDestroyed()) {
    eventBubbleWindow.hide();
  }
}

function showEventBubble(content) {
  const bubbleWindow = createEventBubbleWindow();
  positionEventBubble(bubbleWindow);

  const render = () => {
    if (!eventBubbleWindow || eventBubbleWindow.isDestroyed()) {
      return;
    }

    eventBubbleWindow.webContents.send('event-bubble:update', content);
    eventBubbleWindow.showInactive();
  };

  if (bubbleWindow.webContents.isLoading()) {
    bubbleWindow.webContents.once('did-finish-load', render);
  } else {
    render();
  }

  clearEventBubbleTimers();
  bubbleDismissTimer = setTimeout(() => hideEventBubble(), EVENT_BUBBLE_DISMISS_MS);
}

function flushEventBubbleQueue() {
  bubbleBatchTimer = undefined;
  const queuedEvents = pendingBubbleEvents;
  pendingBubbleEvents = [];
  if (!shouldShowBackgroundBubble()) {
    return;
  }

  const content = createEventBubbleContent(queuedEvents);
  if (content) {
    showEventBubble(content);
  }
}

function queueEventBubble(event) {
  if (!isReadyForEventBubbles || !shouldShowBackgroundBubble()) {
    return;
  }

  pendingBubbleEvents.push(event);
  clearTimeout(bubbleDismissTimer);
  bubbleDismissTimer = undefined;
  if (!bubbleBatchTimer) {
    bubbleBatchTimer = setTimeout(flushEventBubbleQueue, EVENT_BUBBLE_COALESCE_MS);
  }
}

function addEvent(type, port) {
  const event = addPortEvent(eventHistory, {
    type,
    port,
    label: getDisplayLabel(port)
  });

  if (!event) {
    return;
  }

  updateTrayTooltip();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('serial:event', event);
  }

  queueEventBubble(event);
}

async function refreshFastPortNames() {
  if (fastQueryInFlight) {
    return;
  }

  fastQueryInFlight = true;
  try {
    const nextNames = await queryFastPortNames();
    if (!nextNames) {
      return;
    }

    const nextSet = new Set(nextNames);
    if (!presenceInitialized) {
      fastKnownPortNames = nextSet;
      presenceInitialized = true;
      return;
    }

    const added = nextNames.filter((name) => !fastKnownPortNames.has(name));
    const removed = [];

    for (const portName of nextNames) {
      missingPortCounts.delete(portName);
    }

    for (const portName of fastKnownPortNames) {
      if (nextSet.has(portName)) {
        continue;
      }

      const missCount = (missingPortCounts.get(portName) || 0) + 1;
      missingPortCounts.set(portName, missCount);
      if (missCount >= REMOVAL_CONFIRM_POLLS) {
        removed.push(portName);
      }
    }

    if (added.length === 0 && removed.length === 0) {
      return;
    }

    for (const portName of removed) {
      fastKnownPortNames.delete(portName);
      missingPortCounts.delete(portName);
    }

    for (const portName of added) {
      fastKnownPortNames.add(portName);
      missingPortCounts.delete(portName);
    }

    for (const portName of removed) {
      addEvent('detached', getBestKnownPort(portName));
    }

    ports = ports.filter((port) => !removed.includes(port.portName));

    for (const portName of added) {
      const port = getBestKnownPort(portName);
      if (!ports.some((item) => item.portName === portName)) {
        ports.push(port);
      }
      addEvent('attached', port);
    }

    ports = sortPorts(ports);
    sendSnapshot();
    refreshPorts({ notifyDiff: false });
  } finally {
    fastQueryInFlight = false;
  }
}

async function refreshPorts({ notifyDiff = false } = {}) {
  if (queryInFlight) {
    return createSnapshot();
  }

  queryInFlight = true;
  try {
    const nextPorts = await querySerialPorts(aliases);
    if (nextPorts.length === 0 && (ports.length > 0 || fastKnownPortNames.size > 0)) {
      sendSnapshot();
      return createSnapshot();
    }

    cachePortInfo(nextPorts);
    if (notifyDiff) {
      diffAndApply(nextPorts);
    } else {
      const nextMap = new Map(nextPorts.map((port) => [port.portName, port]));
      const knownNames = presenceInitialized
        ? new Set(fastKnownPortNames)
        : new Set(nextPorts.map((port) => port.portName));

      ports = sortPorts([...knownNames].map((portName) => nextMap.get(portName) || getBestKnownPort(portName)));
      fastKnownPortNames = new Set(ports.map((port) => port.portName));
      presenceInitialized = true;
      for (const portName of fastKnownPortNames) {
        missingPortCounts.delete(portName);
      }
      sendSnapshot();
    }
  } finally {
    queryInFlight = false;
  }

  return createSnapshot();
}

function diffAndApply(nextPorts) {
  const previousMap = new Map(ports.map((port) => [port.portName, port]));
  const nextMap = new Map(nextPorts.map((port) => [port.portName, port]));

  for (const port of nextPorts) {
    if (!previousMap.has(port.portName)) {
      addEvent('attached', port);
    }
  }

  for (const port of ports) {
    if (!nextMap.has(port.portName)) {
      addEvent('detached', getBestKnownPort(port.portName));
    }
  }

  ports = nextPorts;
  cachePortInfo(nextPorts);
  fastKnownPortNames = new Set(nextPorts.map((port) => port.portName));
  sendSnapshot();
}

function startPolling() {
  clearInterval(fastPollTimer);
  clearInterval(fullRefreshTimer);
  fastPollTimer = setInterval(refreshFastPortNames, FAST_POLL_INTERVAL_MS);
  fullRefreshTimer = setInterval(() => {
    refreshPorts({ notifyDiff: false });
  }, FULL_REFRESH_INTERVAL_MS);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    minWidth: DEFAULT_WINDOW_WIDTH,
    minHeight: DEFAULT_WINDOW_HEIGHT,
    title: '串口管理工具',
    backgroundColor: '#f5f1e7',
    icon: ICON_PATH,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('focus', () => hideEventBubble());

  mainWindow.on('close', (event) => {
    if (app.isQuitting) {
      return;
    }

    event.preventDefault();
    promptCloseAction();
  });
}

async function promptCloseAction() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: '关闭窗口',
    message: '要退出程序，还是最小化到托盘继续监听？',
    detail: '最小化到托盘后，后台检测到串口插拔时会显示应用内气泡提示。',
    buttons: ['最小化到托盘', '退出程序', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  });

  const action = getCloseResponseAction(result.response);
  if (action === 'hide') {
    mainWindow.hide();
    return;
  }

  if (action === 'quit') {
    app.isQuitting = true;
    app.quit();
  }
}

function createTray() {
  tray = new Tray(createTrayImage());
  updateTrayTooltip();
  tray.setContextMenu(Menu.buildFromTemplate(createTrayMenuTemplate({
    showWindow,
    refresh: () => refreshPorts({ notifyDiff: false }),
    quit: quitApp
  })));
  tray.on('click', showWindow);
}

function updateTrayTooltip() {
  if (!tray) {
    return;
  }

  tray.setToolTip(createTrayTooltip(eventHistory.events));
}

function quitApp() {
  app.isQuitting = true;
  app.quit();
}

function showWindow() {
  hideEventBubble();
  showWindowIfAvailable(mainWindow);
}

function minimizeToTray() {
  if (mainWindow) {
    mainWindow.hide();
  }
}

function saveAliasHandler(deviceKey, alias) {
  const key = String(deviceKey || '').trim();
  if (!key) {
    return createSnapshot();
  }

  const normalized = normalizeAlias(alias);
  if (normalized) {
    aliases[key] = normalized;
  } else {
    delete aliases[key];
  }

  saveAliases();
  ports = ports.map((port) => ({ ...port, alias: getAliasForPort(port) }));
  sendSnapshot();
  return createSnapshot();
}

function saveGroupHandler(group) {
  const id = String(group && group.id ? group.id : '').trim() || createGroupId();
  const name = normalizeGroupName(group && group.name);
  const color = normalizeGroupColor(group && group.color);
  if (!name) {
    return createSnapshot();
  }

  const index = groupStore.groups.findIndex((item) => item.id === id);
  if (index >= 0) {
    groupStore.groups[index] = { id, name, color };
  } else {
    groupStore.groups.push({ id, name, color });
  }

  saveGroups();
  sendSnapshot();
  return createSnapshot();
}

function deleteGroupHandler(groupId) {
  const id = String(groupId || '').trim();
  if (!id) {
    return createSnapshot();
  }

  groupStore.groups = groupStore.groups.filter((group) => group.id !== id);
  delete groupStore.orders[id];
  for (const [key, value] of Object.entries(groupStore.assignments)) {
    if (value === id) {
      delete groupStore.assignments[key];
    }
  }

  saveGroups();
  sendSnapshot();
  return createSnapshot();
}

function saveGroupOrderHandler(groupIds) {
  if (!Array.isArray(groupIds)) {
    return createSnapshot();
  }

  const byId = new Map(groupStore.groups.map((group) => [group.id, group]));
  const nextGroups = [];
  const seen = new Set();
  for (const rawId of groupIds) {
    const id = String(rawId || '').trim();
    if (!id || seen.has(id) || !byId.has(id)) {
      continue;
    }

    nextGroups.push(byId.get(id));
    seen.add(id);
  }

  for (const group of groupStore.groups) {
    if (!seen.has(group.id)) {
      nextGroups.push(group);
    }
  }

  groupStore.groups = nextGroups;
  saveGroups();
  sendSnapshot();
  return createSnapshot();
}

function assignGroupHandler(deviceKey, portName, groupId) {
  const key = String(deviceKey || '').trim() || `port:${String(portName || '').trim()}`;
  const portKey = String(portName || '').trim() ? `port:${String(portName || '').trim()}` : '';
  const id = String(groupId || '').trim();
  if (!key) {
    return createSnapshot();
  }

  if (id && groupStore.groups.some((group) => group.id === id)) {
    groupStore.assignments[key] = id;
  } else {
    delete groupStore.assignments[key];
    if (portKey) {
      delete groupStore.assignments[portKey];
    }
  }

  saveGroups();
  sendSnapshot();
  return createSnapshot();
}

function saveOrderHandler(groupId, portKeys) {
  const key = String(groupId || 'all').trim() || 'all';
  const allowedKeys = new Set(['all', 'ungrouped', ...groupStore.groups.map((group) => group.id)]);
  if (!allowedKeys.has(key) || !Array.isArray(portKeys)) {
    return createSnapshot();
  }

  groupStore.orders[key] = [...new Set(portKeys.map((item) => String(item || '').trim()).filter(Boolean))];
  saveGroups();
  sendSnapshot();
  return createSnapshot();
}

function clearEventsHandler() {
  clearEventHistory(eventHistory);
  updateTrayTooltip();
  sendSnapshot();
  return createSnapshot();
}

registerSerialIpcHandlers(ipcMain, {
  createSnapshot,
  refreshPorts,
  saveAlias: saveAliasHandler,
  saveGroup: saveGroupHandler,
  deleteGroup: deleteGroupHandler,
  saveGroupOrder: saveGroupOrderHandler,
  assignGroup: assignGroupHandler,
  saveOrder: saveOrderHandler,
  clearEvents: clearEventsHandler
});
registerWindowIpcHandlers(ipcMain, {
  showWindow,
  minimizeToTray
});
ipcMain.handle('event-bubble:show-main-window', () => {
  showWindow();
  return true;
});
ipcMain.handle('event-bubble:hide', () => {
  hideEventBubble();
  return true;
});

app.whenReady().then(async () => {
  app.setAppUserModelId('SerialManager.PortWatcher');
  loadAliases();
  loadGroups();
  createWindow();
  createTray();
  const initialFastNames = await queryFastPortNames();
  if (initialFastNames) {
    fastKnownPortNames = new Set(initialFastNames);
    presenceInitialized = true;
    ports = sortPorts(initialFastNames.map(createPlaceholderPort));
    sendSnapshot();
  }
  await refreshPorts({ notifyDiff: false });
  isReadyForEventBubbles = true;
  startPolling();
});

app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  app.isQuitting = true;
  clearInterval(fastPollTimer);
  clearInterval(fullRefreshTimer);
  hideEventBubble();
  if (eventBubbleWindow && !eventBubbleWindow.isDestroyed()) {
    eventBubbleWindow.destroy();
  }
});
