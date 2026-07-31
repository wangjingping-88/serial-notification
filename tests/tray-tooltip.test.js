const assert = require('node:assert/strict');
const test = require('node:test');
const { createTrayTooltip } = require('../src/main/tray-tooltip');

test('createTrayTooltip shows an empty-state message when there are no events', () => {
  assert.equal(createTrayTooltip([]), '串口管理工具\n暂无最近插拔事件');
});

test('createTrayTooltip keeps the newest events and describes their actions', () => {
  const tooltip = createTrayTooltip([
    { type: 'attached', label: '网关 AP (COM7)', timestamp: '2026-07-31T06:20:00.000Z' },
    { type: 'detached', label: 'R4 (COM8)', timestamp: '2026-07-31T06:19:00.000Z' },
    { type: 'attached', label: 'COM9', timestamp: '2026-07-31T06:18:00.000Z' },
    { type: 'attached', label: 'COM10', timestamp: '2026-07-31T06:17:00.000Z' }
  ]);

  assert.match(tooltip, /最近事件/);
  assert.match(tooltip, /插入 网关 AP \(COM7\)/);
  assert.match(tooltip, /拔出 R4 \(COM8\)/);
  assert.match(tooltip, /插入 COM9/);
  assert.doesNotMatch(tooltip, /COM10/);
});