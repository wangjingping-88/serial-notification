function formatBubbleTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

function createEventBubbleContent(events) {
  const queuedEvents = Array.isArray(events) ? events.filter(Boolean) : [];
  const latest = queuedEvents.at(-1);
  if (!latest) {
    return null;
  }

  const detail = [latest.name, latest.manufacturer]
    .map((value) => String(value || '').trim())
    .find((value) => value && value !== latest.label && value !== latest.portName) || '串口状态已更新';

  return {
    type: latest.type === 'attached' ? 'attached' : 'detached',
    title: latest.type === 'attached' ? '串口已插入' : '串口已拔出',
    label: String(latest.label || latest.portName || '未知串口'),
    detail,
    time: formatBubbleTime(latest.timestamp),
    extraCount: Math.max(0, queuedEvents.length - 1)
  };
}

module.exports = {
  createEventBubbleContent,
  formatBubbleTime
};
