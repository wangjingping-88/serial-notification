function formatTrayEventTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function createTrayTooltip(events, { limit = 3 } = {}) {
  const recentEvents = Array.isArray(events) ? events.slice(0, limit) : [];
  if (recentEvents.length === 0) {
    return '串口管理工具\n暂无最近插拔事件';
  }

  const lines = recentEvents.map((event) => {
    const action = event.type === 'attached' ? '插入' : '拔出';
    const time = formatTrayEventTime(event.timestamp);
    return `${action} ${event.label || event.portName || '串口'}${time ? ` · ${time}` : ''}`;
  });

  return ['串口管理工具 · 最近事件', ...lines].join('\n');
}

module.exports = {
  createTrayTooltip,
  formatTrayEventTime
};