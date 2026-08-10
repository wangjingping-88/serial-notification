const elements = {
  bubble: document.querySelector('#eventBubble'),
  mark: document.querySelector('#eventMark'),
  title: document.querySelector('#eventTitle'),
  time: document.querySelector('#eventTime'),
  label: document.querySelector('#eventLabel'),
  detail: document.querySelector('#eventDetail'),
  summary: document.querySelector('#eventSummary'),
  close: document.querySelector('#closeBubble')
};

function renderBubble(payload) {
  if (!payload) {
    return;
  }

  const attached = payload.type === 'attached';
  elements.mark.classList.toggle('attached', attached);
  elements.mark.classList.toggle('detached', !attached);
  elements.mark.textContent = attached ? '+' : '−';
  elements.title.textContent = payload.title || '串口状态已更新';
  elements.time.textContent = payload.time || '--:--:--';
  elements.label.textContent = payload.label || '未知串口';
  elements.detail.textContent = payload.detail || '串口状态已更新';
  elements.summary.hidden = !payload.extraCount;
  elements.summary.textContent = payload.extraCount ? `另有 ${payload.extraCount} 条串口变化已合并` : '';
}

elements.bubble.addEventListener('click', (event) => {
  if (event.target.closest('#closeBubble')) {
    return;
  }

  window.eventBubbleApi.showMainWindow();
});

elements.close.addEventListener('click', () => window.eventBubbleApi.hide());
window.eventBubbleApi.onUpdate(renderBubble);
