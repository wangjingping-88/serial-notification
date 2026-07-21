const MIN_SCAN_MS = 650;
const EVENT_HISTORY_LIMIT = 80;
const GROUP_COLORS = ['#138a8a', '#1f9d55', '#c17900', '#ca3d32', '#4f6fbd', '#8a5fbf', '#ad5d20'];
const CUSTOM_COLOR_FALLBACK = '#4f7c52';

const state = {
  ports: [],
  groups: [],
  orders: {},
  events: [],
  updatedAt: null,
  activeGroupId: 'all',
  draggingKey: '',
  draggingGroupId: '',
  editingKey: null,
  aliasDraft: '',
  groupEditor: null,
  savingGroup: false,
  savingAliasKey: null,
  isScanning: true,
  scanStartedAt: performance.now(),
  portSignature: '',
  groupSignature: '',
  orderSignature: '',
  eventSignature: '',
  searchQuery: ''
};

const elements = {
  portCount: document.querySelector('#portCount'),
  aliasCount: document.querySelector('#aliasCount'),
  updatedAt: document.querySelector('#updatedAt'),
  groupsBar: document.querySelector('#groupsBar'),
  portsList: document.querySelector('#portsList'),
  eventsList: document.querySelector('#eventsList'),
  scanLoader: document.querySelector('#scanLoader'),
  emptyPorts: document.querySelector('#emptyPorts'),
  emptyEvents: document.querySelector('#emptyEvents'),
  portSearchInput: document.querySelector('#portSearchInput'),
  portSearchMeta: document.querySelector('#portSearchMeta'),
  eventCount: document.querySelector('#eventCount'),
  clearEventsButton: document.querySelector('#clearEventsButton'),
  scanStatus: document.querySelector('#scanStatus'),
  refreshButton: document.querySelector('#refreshButton'),
  trayButton: document.querySelector('#trayButton')
};

let activeConfirmCleanup = null;
let activeTooltipTarget = null;
let tooltipNode = null;

function formatTime(value) {
  if (!value) {
    return '--';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(value));
}

function receiveSnapshot(snapshot) {
  if (!state.isScanning) {
    applySnapshot(snapshot);
    return;
  }

  const elapsed = performance.now() - state.scanStartedAt;
  const delay = Math.max(0, MIN_SCAN_MS - elapsed);
  window.setTimeout(() => {
    state.isScanning = false;
    applySnapshot(snapshot);
  }, delay);
}

function applySnapshot(snapshot) {
  const nextPorts = snapshot.ports || [];
  const nextGroups = snapshot.groups || [];
  const nextOrders = snapshot.orders || {};
  const nextEvents = snapshot.events || [];
  const nextPortSignature = createPortSignature(nextPorts);
  const nextGroupSignature = createGroupSignature(nextGroups);
  const nextOrderSignature = createOrderSignature(nextOrders);
  const nextEventSignature = createEventSignature(nextEvents);
  const portsChanged = nextPortSignature !== state.portSignature;
  const groupsChanged = nextGroupSignature !== state.groupSignature;
  const orderChanged = nextOrderSignature !== state.orderSignature;
  const shouldRenderGroups = (portsChanged || groupsChanged) && !state.groupEditor;
  const shouldRenderPorts = (
    portsChanged ||
    groupsChanged ||
    orderChanged
  ) && !isAliasEditingActive();
  const shouldRenderEvents = nextEventSignature !== state.eventSignature;

  state.ports = nextPorts;
  state.groups = nextGroups;
  state.orders = nextOrders;
  state.events = nextEvents;
  state.updatedAt = snapshot.updatedAt;
  state.portSignature = nextPortSignature;
  state.groupSignature = nextGroupSignature;
  state.orderSignature = nextOrderSignature;
  state.eventSignature = nextEventSignature;
  ensureActiveGroupExists();

  renderSummary();
  updateVisibility();

  if (shouldRenderGroups || (!state.groupEditor && !elements.groupsBar.hasChildNodes() && (state.ports.length > 0 || state.groups.length > 0))) {
    renderGroups();
  }
  if (shouldRenderPorts) {
    renderPorts();
  }
  if (shouldRenderEvents) {
    renderEvents();
  }
}

function createPortSignature(ports) {
  return ports
    .map((port) => [
      port.deviceKey,
      port.portName,
      port.alias,
      port.groupId,
      port.name,
      port.manufacturer,
      port.status,
      port.openState,
      port.service
    ].join('|'))
    .join('\n');
}

function createGroupSignature(groups) {
  return groups.map((group) => [group.id, group.name, group.color].join('|')).join('\n');
}

function createOrderSignature(orders) {
  return Object.keys(orders)
    .sort()
    .map((key) => `${key}:${(orders[key] || []).join(',')}`)
    .join('|');
}

function createEventSignature(events) {
  return events.map((event) => event.id).join('|');
}

function ensureActiveGroupExists() {
  if (state.activeGroupId === 'ungrouped' && state.ports.every((port) => port.groupId)) {
    state.activeGroupId = 'all';
    return;
  }

  if (state.activeGroupId === 'all' || state.activeGroupId === 'ungrouped') {
    return;
  }

  if (!state.groups.some((group) => group.id === state.activeGroupId)) {
    state.activeGroupId = 'all';
  }
}

function getPortKey(port) {
  return port.deviceKey || `port:${port.portName}`;
}

function getActiveOrderKey() {
  return state.activeGroupId || 'all';
}

function getVisiblePorts() {
  let visible = state.ports;
  if (state.activeGroupId === 'ungrouped') {
    visible = state.ports.filter((port) => !port.groupId);
  } else if (state.activeGroupId !== 'all') {
    visible = state.ports.filter((port) => port.groupId === state.activeGroupId);
  }

  return window.PortFilter.filterPorts(sortPortsByOrder(visible, getActiveOrderKey()), state.searchQuery);
}

function getGroupedPortsBeforeSearch() {
  if (state.activeGroupId === 'ungrouped') {
    return state.ports.filter((port) => !port.groupId);
  }

  if (state.activeGroupId !== 'all') {
    return state.ports.filter((port) => port.groupId === state.activeGroupId);
  }

  return state.ports;
}

function sortPortsByOrder(ports, orderKey) {
  const order = state.orders[orderKey] || [];
  const indexByKey = new Map(order.map((key, index) => [key, index]));
  return [...ports].sort((left, right) => {
    const leftIndex = indexByKey.has(getPortKey(left)) ? indexByKey.get(getPortKey(left)) : Number.MAX_SAFE_INTEGER;
    const rightIndex = indexByKey.has(getPortKey(right)) ? indexByKey.get(getPortKey(right)) : Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }

    const a = Number(String(left.portName).replace(/\D+/g, '')) || 9999;
    const b = Number(String(right.portName).replace(/\D+/g, '')) || 9999;
    return a - b;
  });
}

function isAliasInputActive() {
  return document.activeElement && document.activeElement.classList.contains('alias-input');
}

function isAliasEditingActive() {
  return Boolean(state.editingKey && isAliasInputActive());
}

function renderSummary() {
  elements.portCount.textContent = state.ports.length;
  elements.aliasCount.textContent = state.ports.filter((port) => port.alias).length;
  elements.updatedAt.textContent = formatTime(state.updatedAt);
  elements.eventCount.textContent = `${state.events.length} 条`;
  renderSearchMeta();
}

function renderSearchMeta() {
  const visibleCount = getVisiblePorts().length;
  const totalCount = getGroupedPortsBeforeSearch().length;
  elements.portSearchMeta.textContent = window.PortFilter.createSearchSummary({
    visibleCount,
    totalCount,
    query: state.searchQuery
  });
}

function updateVisibility() {
  const visiblePorts = getVisiblePorts();
  const isSearching = Boolean(window.PortFilter.normalizeSearchTerm(state.searchQuery));
  elements.scanLoader.hidden = !state.isScanning;
  elements.portsList.hidden = state.isScanning || visiblePorts.length === 0;
  elements.emptyPorts.hidden = state.isScanning || visiblePorts.length > 0;
  elements.emptyEvents.hidden = state.events.length > 0;
  elements.clearEventsButton.disabled = state.events.length === 0;
  elements.emptyPorts.querySelector('strong').textContent = isSearching ? '没有匹配的串口' : '未发现串口';
  elements.emptyPorts.querySelector('span').textContent = isSearching ? '换个关键词或切换分组后再试。' : '插入 USB 串口设备后会自动显示。';
}

function renderGroups() {
  if (!elements.groupsBar) {
    return;
  }

  const nodes = [];

  if (state.groupEditor) {
    nodes.push(createGroupEditor());
  } else {
    nodes.push(createAddGroupButton());
  }

  const ungroupedCount = state.ports.filter((port) => !port.groupId).length;
  nodes.push(createSpecialGroupTab('all', '全部', state.ports.length));
  if (ungroupedCount > 0) {
    nodes.push(createSpecialGroupTab('ungrouped', '未分组', ungroupedCount));
  }

  for (const group of state.groups) {
    nodes.push(createGroupChip(group));
  }

  elements.groupsBar.replaceChildren(...nodes);
  updateGroupScrollState();
}

function createAddGroupButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'group-add-button';
  button.addEventListener('click', () => {
    state.groupEditor = { id: '', name: '', color: GROUP_COLORS[state.groups.length % GROUP_COLORS.length] };
    renderGroups();
    focusGroupNameInput();
  });

  const icon = document.createElement('span');
  icon.className = 'group-add-icon';
  icon.textContent = '+';

  const label = document.createElement('strong');
  label.textContent = '分组';

  const spacer = document.createElement('span');
  spacer.className = 'group-add-spacer';

  button.append(icon, label, spacer);
  return button;
}

function createSpecialGroupTab(id, name, countValue) {
  const item = document.createElement('div');
  item.className = `group-tab system-tab${state.activeGroupId === id ? ' is-active' : ''}`;
  item.role = 'button';
  item.tabIndex = 0;
  item.dataset.groupId = id;
  item.style.setProperty('--group-color', id === 'all' || id === 'ungrouped' ? '#6f716b' : GROUP_COLORS[0]);
  item.addEventListener('click', () => switchGroupTab(id));
  item.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }

    event.preventDefault();
    switchGroupTab(id);
  });

  const swatch = document.createElement('span');
  swatch.className = 'group-swatch';

  const title = document.createElement('strong');
  title.textContent = name;

  const count = document.createElement('span');
  count.className = 'group-count';
  count.textContent = String(countValue);

  item.append(swatch, title, count);
  return item;
}

function createGroupChip(group) {
  const item = document.createElement('div');
  item.className = `group-tab custom-tab${state.activeGroupId === group.id ? ' is-active' : ''}`;
  item.style.setProperty('--group-color', group.color || GROUP_COLORS[0]);
  item.role = 'button';
  item.tabIndex = 0;
  item.draggable = true;
  item.dataset.groupId = group.id;
  item.addEventListener('click', () => switchGroupTab(group.id));
  item.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }

    event.preventDefault();
    switchGroupTab(group.id);
  });
  item.addEventListener('dragstart', (event) => handleGroupDragStart(event, group));
  item.addEventListener('dragover', (event) => handleGroupDragOver(event, group));
  item.addEventListener('dragleave', handleGroupDragLeave);
  item.addEventListener('drop', (event) => handleGroupDrop(event, group));
  item.addEventListener('dragend', handleGroupDragEnd);

  const swatch = document.createElement('span');
  swatch.className = 'group-swatch';

  const name = document.createElement('strong');
  name.textContent = group.name;

  const count = document.createElement('span');
  count.className = 'group-count';
  count.textContent = String(state.ports.filter((port) => port.groupId === group.id).length);

  setTooltip(item, group.name);
  item.addEventListener('dblclick', () => editGroup(group));
  item.addEventListener('contextmenu', (event) => showGroupContextMenu(event, group));
  item.append(swatch, name, count);
  return item;
}

function handleGroupDragStart(event, group) {
  closeGroupContextMenu();
  state.draggingGroupId = group.id;
  event.currentTarget.classList.add('is-dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', group.id);
}

function handleGroupDragOver(event, group) {
  if (!state.draggingGroupId || state.draggingGroupId === group.id) {
    return;
  }

  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const rect = event.currentTarget.getBoundingClientRect();
  const isAfter = event.clientY > rect.top + rect.height / 2;
  event.currentTarget.classList.toggle('drop-before', !isAfter);
  event.currentTarget.classList.toggle('drop-after', isAfter);
}

function handleGroupDragLeave(event) {
  event.currentTarget.classList.remove('drop-before', 'drop-after');
}

function handleGroupDragEnd(event) {
  event.currentTarget.classList.remove('is-dragging', 'drop-before', 'drop-after');
  for (const tab of elements.groupsBar.querySelectorAll('.custom-tab')) {
    tab.classList.remove('is-dragging', 'drop-before', 'drop-after');
  }
  state.draggingGroupId = '';
}

async function handleGroupDrop(event, targetGroup) {
  if (!state.draggingGroupId || state.draggingGroupId === targetGroup.id) {
    return;
  }

  event.preventDefault();
  const draggedId = state.draggingGroupId;
  const nextGroups = state.groups.filter((group) => group.id !== draggedId);
  const targetIndex = nextGroups.findIndex((group) => group.id === targetGroup.id);
  if (targetIndex < 0) {
    return;
  }

  const rect = event.currentTarget.getBoundingClientRect();
  const insertAfter = event.clientY > rect.top + rect.height / 2;
  const draggedGroup = state.groups.find((group) => group.id === draggedId);
  if (!draggedGroup) {
    return;
  }
  nextGroups.splice(targetIndex + (insertAfter ? 1 : 0), 0, draggedGroup);

  state.groups = nextGroups;
  state.groupSignature = createGroupSignature(nextGroups);
  renderGroups();
  try {
    await window.serialApi.saveGroupOrder(nextGroups.map((group) => group.id));
  } finally {
    state.draggingGroupId = '';
  }
}

function switchGroupTab(groupId) {
  state.activeGroupId = groupId;
  updateVisibility();
  renderSearchMeta();
  updateActiveGroupTab();
  renderPorts();
  keepActiveGroupVisible();
}

function updateActiveGroupTab() {
  for (const tab of elements.groupsBar.querySelectorAll('.group-tab')) {
    tab.classList.toggle('is-active', tab.dataset.groupId === state.activeGroupId);
  }
}

function createGroupEditor() {
  const form = document.createElement('form');
  form.className = 'group-editor';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    commitGroupEdit();
  });

  const input = document.createElement('input');
  input.className = 'group-name-input';
  input.type = 'text';
  input.value = state.groupEditor.name;
  input.placeholder = '分组名称';
  input.maxLength = 24;
  input.addEventListener('input', () => {
    state.groupEditor.name = input.value;
  });

  const colors = document.createElement('div');
  colors.className = 'group-color-list';
  for (const color of GROUP_COLORS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `color-swatch${state.groupEditor.color === color ? ' is-selected' : ''}`;
    button.style.background = color;
    button.title = color;
    button.addEventListener('click', () => {
      state.groupEditor.color = color;
      renderGroups();
      focusGroupNameInput(false);
    });
    colors.append(button);
  }
  colors.append(createCustomColorPicker());

  const saveButton = document.createElement('button');
  saveButton.type = 'submit';
  saveButton.className = 'group-save-button';
  saveButton.textContent = '确认';
  saveButton.disabled = state.savingGroup;

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'group-cancel-button';
  cancelButton.textContent = '取消';
  cancelButton.addEventListener('click', () => {
    state.groupEditor = null;
    renderGroups();
  });

  form.append(input, colors, saveButton, cancelButton);
  return form;
}

function createCustomColorPicker() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `color-swatch custom-color-swatch${isCustomGroupColor(state.groupEditor.color) ? ' is-selected' : ''}`;
  button.style.background = normalizeColorValue(state.groupEditor.color);
  button.title = '自定义颜色';

  const input = document.createElement('input');
  input.type = 'color';
  input.className = 'custom-color-input';
  input.value = normalizeColorValue(state.groupEditor.color);

  button.addEventListener('click', () => {
    input.click();
  });
  input.addEventListener('input', () => {
    state.groupEditor.color = input.value;
    button.style.background = input.value;
    button.classList.add('is-selected');
  });
  input.addEventListener('change', () => {
    state.groupEditor.color = input.value;
    renderGroups();
    focusGroupNameInput(false);
  });

  button.append(input);
  return button;
}

function isCustomGroupColor(color) {
  return Boolean(color && !GROUP_COLORS.includes(color));
}

function normalizeColorValue(color) {
  return /^#[0-9a-fA-F]{6}$/.test(String(color || '')) ? color : CUSTOM_COLOR_FALLBACK;
}

function focusGroupNameInput(select = true) {
  window.setTimeout(() => {
    const input = document.querySelector('.group-name-input');
    if (!input) {
      return;
    }

    input.focus();
    if (select) {
      input.select();
    }
  }, 0);
}

function editGroup(group) {
  closeGroupContextMenu();
  state.groupEditor = { ...group };
  renderGroups();
  focusGroupNameInput();
}

function showGroupContextMenu(event, group) {
  event.preventDefault();
  event.stopPropagation();
  closeGroupContextMenu();

  const menu = document.createElement('div');
  menu.className = 'group-context-menu';

  const editButton = document.createElement('button');
  editButton.type = 'button';
  editButton.textContent = '编辑分组';
  editButton.addEventListener('click', () => editGroup(group));

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'danger';
  deleteButton.textContent = '删除分组';
  deleteButton.addEventListener('click', () => {
    closeGroupContextMenu();
    deleteGroup(group);
  });

  menu.append(editButton, deleteButton);
  document.body.append(menu);

  const rect = menu.getBoundingClientRect();
  const left = Math.min(event.clientX, window.innerWidth - rect.width - 8);
  const top = Math.min(event.clientY, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

function closeGroupContextMenu() {
  document.querySelector('.group-context-menu')?.remove();
}

function renderPorts() {
  elements.portsList.replaceChildren(...getVisiblePorts().map(createPortCard));
}

function createPortCard(port) {
  const card = document.createElement('article');
  card.className = 'port-card';
  card.draggable = true;
  card.dataset.portKey = getPortKey(port);
  card.addEventListener('dragstart', (event) => handlePortDragStart(event, port));
  card.addEventListener('dragover', handlePortDragOver);
  card.addEventListener('dragleave', handlePortDragLeave);
  card.addEventListener('drop', (event) => handlePortDrop(event, port));
  card.addEventListener('dragend', handlePortDragEnd);
  if (port.groupColor) {
    card.classList.add('has-group');
    card.style.setProperty('--group-color', port.groupColor);
  }
  card.append(createStatusDot(port.status));

  const main = document.createElement('div');
  main.className = 'port-main';

  const titleGroup = document.createElement('div');
  titleGroup.className = 'port-title';

  const badge = document.createElement('span');
  badge.className = 'port-badge';
  badge.textContent = port.portName || 'COM?';
  setTooltip(badge, port.portName || 'COM?');

  titleGroup.append(badge, createAliasView(port), createDeviceName(port));
  if (state.editingKey === port.deviceKey) {
    titleGroup.classList.add('is-editing-alias');
  }
  main.append(titleGroup, createPortMeta(port));

  card.append(main);
  return card;
}

function createAliasView(port) {
  if (state.editingKey === port.deviceKey) {
    return createAliasEditor(port);
  }

  const group = document.createElement('div');
  group.className = 'alias-view';

  const title = document.createElement('strong');
  title.textContent = port.alias || '未命名';
  title.className = port.alias ? '' : 'muted-title';
  setTooltip(title, port.alias || '未命名');

  const editButton = document.createElement('button');
  editButton.type = 'button';
  editButton.className = 'edit-icon-button';
  editButton.title = '编辑名称';
  editButton.setAttribute('aria-label', `编辑 ${port.portName || '串口'} 名称`);
  editButton.textContent = '✎';
  editButton.addEventListener('click', () => beginAliasEdit(port));

  group.append(title, editButton);
  return group;
}

function createDeviceName(port) {
  const deviceName = document.createElement('span');
  deviceName.className = 'device-name';
  deviceName.textContent = port.name || port.description || '未知设备';
  setTooltip(deviceName, port.name || port.description || '未知设备');
  return deviceName;
}

function beginAliasEdit(port) {
  state.editingKey = port.deviceKey;
  state.aliasDraft = port.alias || '';
  renderPorts();
  const input = document.querySelector('.alias-input');
  if (input) {
    input.focus();
    input.select();
  }
}

function createPortMeta(port) {
  const meta = document.createElement('div');
  meta.className = 'port-meta';
  meta.append(
    createMetaChip('厂商', port.manufacturer || '未知'),
    createMetaChip('服务', port.service || '未知'),
    createMetaChip('', getOpenStateText(port.openState), `open-state ${getOpenStateClass(port.openState)}`),
    createGroupSelect(port)
  );
  return meta;
}

function createGroupSelect(port) {
  const item = document.createElement('span');
  item.className = 'meta-chip group-select-chip';

  const labelNode = document.createElement('span');
  labelNode.className = 'meta-label';
  labelNode.textContent = '分组';

  const select = document.createElement('select');
  select.className = 'group-select';
  select.style.setProperty('--group-color', port.groupColor || '#d8cfba');

  const emptyOption = document.createElement('option');
  emptyOption.value = '';
  emptyOption.textContent = '未分组';
  select.append(emptyOption);

  for (const group of state.groups) {
    const option = document.createElement('option');
    option.value = group.id;
    option.textContent = group.name;
    select.append(option);
  }

  select.value = port.groupId || '';
  setTooltip(select, port.groupName || '未分组');
  select.addEventListener('change', () => assignPortGroup(port, select.value));
  item.append(labelNode, select);
  return item;
}

function handlePortDragStart(event, port) {
  if (event.target.closest('button, input, select, form')) {
    event.preventDefault();
    return;
  }

  state.draggingKey = getPortKey(port);
  event.currentTarget.classList.add('is-dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', state.draggingKey);
}

function handlePortDragOver(event) {
  if (!state.draggingKey) {
    return;
  }

  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const card = event.currentTarget;
  const rect = card.getBoundingClientRect();
  const isAfter = event.clientY > rect.top + rect.height / 2;
  card.classList.toggle('drop-before', !isAfter);
  card.classList.toggle('drop-after', isAfter);
}

function handlePortDragLeave(event) {
  event.currentTarget.classList.remove('drop-before', 'drop-after');
}

function handlePortDragEnd(event) {
  event.currentTarget.classList.remove('is-dragging', 'drop-before', 'drop-after');
  for (const card of elements.portsList.querySelectorAll('.port-card')) {
    card.classList.remove('drop-before', 'drop-after');
  }
  state.draggingKey = '';
}

async function handlePortDrop(event, targetPort) {
  if (!state.draggingKey) {
    return;
  }

  event.preventDefault();
  const targetKey = getPortKey(targetPort);
  const draggedKey = state.draggingKey;
  if (draggedKey === targetKey) {
    return;
  }

  const visibleKeys = getVisiblePorts().map(getPortKey);
  const nextKeys = visibleKeys.filter((key) => key !== draggedKey);
  const targetIndex = nextKeys.indexOf(targetKey);
  if (targetIndex < 0) {
    return;
  }

  const rect = event.currentTarget.getBoundingClientRect();
  const insertAfter = event.clientY > rect.top + rect.height / 2;
  nextKeys.splice(targetIndex + (insertAfter ? 1 : 0), 0, draggedKey);

  state.orders = { ...state.orders, [getActiveOrderKey()]: nextKeys };
  renderPorts();
  try {
    await window.serialApi.saveOrder(getActiveOrderKey(), nextKeys);
  } finally {
    state.draggingKey = '';
  }
}

function createStatusDot(status) {
  const dot = document.createElement('span');
  const isOk = String(status || '').toUpperCase() === 'OK';
  dot.className = `status-dot ${isOk ? 'is-ok' : 'is-warn'}`;
  dot.title = `设备状态：${status || '未知'}`;
  return dot;
}

function createMetaChip(label, value, valueClassName = '') {
  const item = document.createElement('span');
  item.className = 'meta-chip';

  if (label) {
    const labelNode = document.createElement('span');
    labelNode.className = 'meta-label';
    labelNode.textContent = label;
    item.append(labelNode);
  }

  const valueNode = document.createElement('strong');
  valueNode.textContent = value;
  if (valueClassName) {
    valueNode.className = valueClassName;
  }

  setTooltip(item, label ? `${label}：${value}` : value);
  item.append(valueNode);
  return item;
}

function setTooltip(element, text) {
  const value = String(text || '').trim();
  if (!value) {
    return;
  }

  element.dataset.tooltip = value;
  element.setAttribute('aria-label', value);
}

function showTooltip(target) {
  if (!target || !target.dataset.tooltip) {
    return;
  }

  activeTooltipTarget = target;
  const tooltip = getTooltipNode();
  tooltip.textContent = target.dataset.tooltip;
  tooltip.hidden = false;
  window.requestAnimationFrame(() => positionTooltip(target));
}

function hideTooltip(target = null) {
  if (target && target !== activeTooltipTarget) {
    return;
  }

  activeTooltipTarget = null;
  if (tooltipNode) {
    tooltipNode.hidden = true;
  }
}

function getTooltipNode() {
  if (tooltipNode) {
    return tooltipNode;
  }

  tooltipNode = document.createElement('div');
  tooltipNode.className = 'app-tooltip';
  tooltipNode.hidden = true;
  document.body.append(tooltipNode);
  return tooltipNode;
}

function positionTooltip(target) {
  if (!tooltipNode || tooltipNode.hidden || target !== activeTooltipTarget) {
    return;
  }

  const targetRect = target.getBoundingClientRect();
  const tooltipRect = tooltipNode.getBoundingClientRect();
  const margin = 8;
  const left = clamp(
    targetRect.left + targetRect.width / 2 - tooltipRect.width / 2,
    margin,
    window.innerWidth - tooltipRect.width - margin
  );
  let top = targetRect.top - tooltipRect.height - margin;
  if (top < margin) {
    top = targetRect.bottom + margin;
  }

  tooltipNode.style.left = `${left}px`;
  tooltipNode.style.top = `${Math.min(top, window.innerHeight - tooltipRect.height - margin)}px`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getOpenStateText(openState) {
  if (openState === 'open') {
    return '已打开';
  }
  if (openState === 'free') {
    return '未打开';
  }
  return '未知';
}

function getOpenStateClass(openState) {
  if (openState === 'open') {
    return 'is-open';
  }
  if (openState === 'free') {
    return 'is-free';
  }
  return 'is-unknown';
}

function createAliasEditor(port) {
  const form = document.createElement('form');
  form.className = 'alias-editor inline';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    commitAliasEdit(port);
  });

  const input = document.createElement('input');
  input.className = 'alias-input';
  input.type = 'text';
  input.value = state.aliasDraft;
  input.placeholder = `${port.portName} 的名称`;
  input.maxLength = 80;
  input.dataset.composing = 'false';
  input.addEventListener('compositionstart', () => {
    input.dataset.composing = 'true';
  });
  input.addEventListener('compositionend', () => {
    input.dataset.composing = 'false';
    state.aliasDraft = input.value;
  });
  input.addEventListener('input', () => {
    state.aliasDraft = input.value;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing && input.dataset.composing !== 'true') {
      event.preventDefault();
      commitAliasEdit(port);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      cancelAliasEdit();
    }
  });
  input.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (state.editingKey !== port.deviceKey) {
        return;
      }

      if (state.aliasDraft === (port.alias || '')) {
        cancelAliasEdit();
        return;
      }

      commitAliasEdit(port);
    }, 0);
  });

  form.append(input);
  return form;
}

function commitAliasEdit(port) {
  if (state.editingKey !== port.deviceKey) {
    return;
  }

  if (state.savingAliasKey === port.deviceKey) {
    return;
  }

  saveAlias(port.deviceKey, state.aliasDraft);
}

function cancelAliasEdit() {
  state.editingKey = null;
  state.aliasDraft = '';
  renderPorts();
}

function renderEvents({ animateLatest = false } = {}) {
  elements.eventsList.replaceChildren(...state.events.map((event, index) => createEventItem(event, index, animateLatest)));
}

function createEventItem(event, index, animateLatest = false) {
  const item = document.createElement('article');
  item.className = `event-item ${event.type === 'attached' ? 'attached' : 'detached'}${animateLatest && index === 0 ? ' is-new' : ''}`;

  const mark = document.createElement('span');
  mark.className = 'event-mark';
  mark.textContent = event.type === 'attached' ? '+' : '−';

  const body = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = event.label;
  const meta = document.createElement('span');
  meta.textContent = `${event.type === 'attached' ? '插入' : '拔出'} · ${formatTime(event.timestamp)}`;
  body.append(title, meta);

  item.append(mark, body);
  return item;
}

async function saveAlias(deviceKey, alias) {
  state.savingAliasKey = deviceKey;
  elements.scanStatus.textContent = '保存中';
  try {
    const snapshot = await window.serialApi.saveAlias(deviceKey, alias);
    state.editingKey = null;
    state.aliasDraft = '';
    applySnapshot(snapshot);
    renderPorts();
  } finally {
    state.savingAliasKey = null;
    elements.scanStatus.textContent = '监听中';
  }
}

async function commitGroupEdit() {
  if (!state.groupEditor || state.savingGroup) {
    return;
  }

  const group = {
    id: state.groupEditor.id,
    name: String(state.groupEditor.name || '').trim(),
    color: state.groupEditor.color || GROUP_COLORS[0]
  };

  if (!group.name) {
    focusGroupNameInput(false);
    return;
  }

  state.savingGroup = true;
  elements.scanStatus.textContent = '保存中';
  try {
    const snapshot = await window.serialApi.saveGroup(group);
    state.groupEditor = null;
    applySnapshot(snapshot);
    renderGroups();
    renderPorts();
  } finally {
    state.savingGroup = false;
    elements.scanStatus.textContent = '监听中';
  }
}

async function deleteGroup(group) {
  const confirmed = await showConfirmDialog({
    title: '删除分组',
    message: `删除“${group.name}”后，组内串口会变为未分组。`,
    confirmText: '删除',
    cancelText: '取消'
  });
  if (!confirmed) {
    return;
  }

  elements.scanStatus.textContent = '保存中';
  try {
    const snapshot = await window.serialApi.deleteGroup(group.id);
    applySnapshot(snapshot);
    renderGroups();
    renderPorts();
  } finally {
    elements.scanStatus.textContent = '监听中';
  }
}

function deleteActiveGroupByKeyboard() {
  if (isTextEntryActive() || state.groupEditor || state.savingGroup) {
    return;
  }

  const group = state.groups.find((item) => item.id === state.activeGroupId);
  if (!group) {
    return;
  }

  deleteGroup(group);
}

function isTextEntryActive() {
  const active = document.activeElement;
  return Boolean(active && active.closest('input, textarea, select, [contenteditable="true"]'));
}

function showConfirmDialog({ title, message, confirmText = '确认', cancelText = '取消' }) {
  closeConfirmDialog(false);

  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-backdrop';
    backdrop.setAttribute('role', 'presentation');

    const dialog = document.createElement('section');
    dialog.className = 'confirm-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'confirmTitle');
    dialog.setAttribute('aria-describedby', 'confirmMessage');

    const badge = document.createElement('span');
    badge.className = 'confirm-badge';
    badge.textContent = '!';

    const body = document.createElement('div');
    body.className = 'confirm-body';

    const heading = document.createElement('h3');
    heading.id = 'confirmTitle';
    heading.textContent = title;

    const copy = document.createElement('p');
    copy.id = 'confirmMessage';
    copy.textContent = message;

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'confirm-button secondary';
    cancelButton.textContent = cancelText;

    const confirmButton = document.createElement('button');
    confirmButton.type = 'button';
    confirmButton.className = 'confirm-button danger';
    confirmButton.textContent = confirmText;

    const finish = (value) => {
      if (activeConfirmCleanup !== finish) {
        return;
      }

      activeConfirmCleanup = null;
      backdrop.remove();
      document.removeEventListener('keydown', handleKeydown);
      resolve(value);
    };

    const handleKeydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    };

    cancelButton.addEventListener('click', () => finish(false));
    confirmButton.addEventListener('click', () => finish(true));
    backdrop.addEventListener('pointerdown', (event) => {
      if (event.target === backdrop) {
        finish(false);
      }
    });

    actions.append(cancelButton, confirmButton);
    body.append(heading, copy, actions);
    dialog.append(badge, body);
    backdrop.append(dialog);
    document.body.append(backdrop);
    document.addEventListener('keydown', handleKeydown);
    activeConfirmCleanup = finish;

    window.setTimeout(() => {
      cancelButton.focus();
    }, 0);
  });
}

function closeConfirmDialog(value = false) {
  if (activeConfirmCleanup) {
    activeConfirmCleanup(value);
    return;
  }

  document.querySelector('.confirm-backdrop')?.remove();
}

async function assignPortGroup(port, groupId) {
  elements.scanStatus.textContent = '保存中';
  try {
    const snapshot = await window.serialApi.assignGroup(port.deviceKey, port.portName, groupId);
    applySnapshot(snapshot);
    renderGroups();
    renderPorts();
  } finally {
    elements.scanStatus.textContent = '监听中';
  }
}

async function refreshNow() {
  elements.scanStatus.textContent = '刷新中';
  elements.refreshButton.disabled = true;
  try {
    const snapshot = await window.serialApi.refresh();
    applySnapshot(snapshot);
  } finally {
    elements.refreshButton.disabled = false;
    elements.scanStatus.textContent = '监听中';
  }
}

async function clearEventsNow() {
  elements.clearEventsButton.disabled = true;
  try {
    const snapshot = await window.serialApi.clearEvents();
    applySnapshot(snapshot);
  } finally {
    elements.clearEventsButton.disabled = state.events.length === 0;
  }
}

elements.refreshButton.addEventListener('click', refreshNow);
elements.trayButton.addEventListener('click', () => window.serialApi.minimizeToTray());
elements.clearEventsButton.addEventListener('click', clearEventsNow);
elements.portSearchInput.addEventListener('input', () => {
  state.searchQuery = elements.portSearchInput.value;
  updateVisibility();
  renderSearchMeta();
  renderPorts();
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    elements.portSearchInput.focus();
    elements.portSearchInput.select();
  }

  if (event.key === 'Escape' && document.activeElement === elements.portSearchInput && state.searchQuery) {
    elements.portSearchInput.value = '';
    state.searchQuery = '';
    updateVisibility();
    renderSearchMeta();
    renderPorts();
  }
});
elements.groupsBar.addEventListener('scroll', () => {
  closeGroupContextMenu();
  updateGroupScrollState();
});
window.addEventListener('resize', updateGroupScrollState);
window.addEventListener('scroll', () => hideTooltip(), true);
document.addEventListener('pointerover', (event) => {
  const target = event.target.closest('[data-tooltip]');
  if (target) {
    showTooltip(target);
  }
});
document.addEventListener('pointerout', (event) => {
  if (!activeTooltipTarget || activeTooltipTarget.contains(event.relatedTarget)) {
    return;
  }

  hideTooltip(activeTooltipTarget);
});
document.addEventListener('focusin', (event) => {
  const target = event.target.closest('[data-tooltip]');
  if (target) {
    showTooltip(target);
  }
});
document.addEventListener('focusout', (event) => {
  hideTooltip(event.target.closest('[data-tooltip]'));
});
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.group-context-menu')) {
    closeGroupContextMenu();
  }

  if (!state.editingKey || event.target.closest('.alias-editor')) {
    return;
  }

  const port = state.ports.find((item) => item.deviceKey === state.editingKey);
  if (!port) {
    cancelAliasEdit();
    return;
  }

  if (state.aliasDraft === (port.alias || '')) {
    cancelAliasEdit();
    return;
  }

  commitAliasEdit(port);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeGroupContextMenu();
    return;
  }

  if (document.querySelector('.confirm-backdrop')) {
    return;
  }

  if (event.key === 'Delete') {
    deleteActiveGroupByKeyboard();
  }
});

window.serialApi.onSnapshot(receiveSnapshot);
window.serialApi.onPortEvent((event) => {
  state.events = [event, ...state.events].slice(0, EVENT_HISTORY_LIMIT);
  state.eventSignature = createEventSignature(state.events);
  elements.eventCount.textContent = `${state.events.length} 条`;
  updateVisibility();
  renderEvents({ animateLatest: true });
});

updateVisibility();
window.serialApi.getSnapshot().then(receiveSnapshot);

function updateGroupScrollState() {
  const maxScrollTop = Math.max(0, elements.groupsBar.scrollHeight - elements.groupsBar.clientHeight);
  elements.groupsBar.classList.toggle('can-scroll-top', elements.groupsBar.scrollTop > 1);
  elements.groupsBar.classList.toggle('can-scroll-bottom', elements.groupsBar.scrollTop < maxScrollTop - 1);
}

function keepActiveGroupVisible() {
  window.setTimeout(() => {
    const active = elements.groupsBar.querySelector('.group-tab.is-active');
    if (!active) {
      updateGroupScrollState();
      return;
    }

    active.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    window.setTimeout(updateGroupScrollState, 180);
  }, 0);
}
