const assert = require('node:assert/strict');
const test = require('node:test');
const { createEventBubbleContent } = require('../src/main/event-bubble-content');

test('createEventBubbleContent describes a single attached event', () => {
  const content = createEventBubbleContent([{
    type: 'attached',
    label: '网关 AP (COM7)',
    portName: 'COM7',
    name: 'USB-SERIAL CH340 (COM7)',
    manufacturer: 'wch.cn',
    timestamp: '2026-08-10T06:00:00.000Z'
  }]);

  assert.equal(content.type, 'attached');
  assert.equal(content.title, '串口已插入');
  assert.equal(content.label, '网关 AP (COM7)');
  assert.equal(content.detail, 'USB-SERIAL CH340 (COM7)');
  assert.equal(content.extraCount, 0);
});

test('createEventBubbleContent uses the latest event and summarizes a burst', () => {
  const content = createEventBubbleContent([
    { type: 'attached', label: 'COM7', portName: 'COM7', timestamp: '2026-08-10T06:00:00.000Z' },
    { type: 'detached', label: 'R4 (COM8)', portName: 'COM8', manufacturer: 'FTDI', timestamp: '2026-08-10T06:00:01.000Z' },
    { type: 'attached', label: 'COM9', portName: 'COM9', timestamp: '2026-08-10T06:00:02.000Z' }
  ]);

  assert.equal(content.type, 'attached');
  assert.equal(content.label, 'COM9');
  assert.equal(content.detail, '串口状态已更新');
  assert.equal(content.extraCount, 2);
});

test('createEventBubbleContent returns null when the burst is empty', () => {
  assert.equal(createEventBubbleContent([]), null);
});
