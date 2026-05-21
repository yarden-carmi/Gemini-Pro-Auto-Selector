document.addEventListener('DOMContentLoaded', () => {
  const enabledToggle = document.getElementById('enabled-toggle');
  
  // Model Select
  const modelSelect = document.getElementById('custom-model-select');
  const modelSelected = modelSelect.querySelector('.select-selected');
  const modelItems = modelSelect.querySelector('.select-items');
  const selectedModelDisplay = document.getElementById('selected-model-display');

  // Thinking Select
  const thinkingSelect = document.getElementById('custom-thinking-select');
  const thinkingSelected = thinkingSelect.querySelector('.select-selected');
  const thinkingItems = thinkingSelect.querySelector('.select-items');
  const selectedThinkingDisplay = document.getElementById('selected-thinking-display');

  const modelOptions = {
    'pro':        { name: '3.1 Pro',      icon: 'diamond_shine' },
    'flash':      { name: '3.5 Flash',    icon: 'bolt' },
    'flash-lite': { name: '3.1 Flash-Lite', icon: 'speed' }
  };

  const thinkingOptions = {
    'standard': { name: 'Standard', icon: 'psychology' },
    'extended': { name: 'Extended', icon: 'cognition_2' }
  };

  function closeDropdowns() {
    modelSelected.classList.remove('select-arrow-active');
    modelItems.classList.remove('select-show');
    thinkingSelected.classList.remove('select-arrow-active');
    thinkingItems.classList.remove('select-show');
  }

  function updateDisplay(displayEl, itemsContainer, value, optionsMap) {
    const option = optionsMap[value];
    if (!option) return;
    displayEl.innerHTML = `
      <span class="material-symbols-outlined model-icon">${option.icon}</span>
      <span>${option.name}</span>
    `;
    itemsContainer.querySelectorAll('div').forEach(item => {
      item.classList.toggle('same-as-selected', item.getAttribute('data-value') === value);
    });
  }

  // Model Toggle
  modelSelected.addEventListener('click', function(e) {
    e.stopPropagation();
    const wasActive = this.classList.contains('select-arrow-active');
    closeDropdowns();
    if (!wasActive) {
      this.classList.add('select-arrow-active');
      modelItems.classList.add('select-show');
    }
  });

  // Thinking Toggle
  thinkingSelected.addEventListener('click', function(e) {
    e.stopPropagation();
    const wasActive = this.classList.contains('select-arrow-active');
    closeDropdowns();
    if (!wasActive) {
      this.classList.add('select-arrow-active');
      thinkingItems.classList.add('select-show');
    }
  });

  // Handle Model selection
  modelItems.querySelectorAll('div').forEach(item => {
    item.addEventListener('click', function() {
      const value = this.getAttribute('data-value');
      updateDisplay(selectedModelDisplay, modelItems, value, modelOptions);
      chrome.storage.sync.set({ preferredModel: value });
      closeDropdowns();
    });
  });

  // Handle Thinking selection
  thinkingItems.querySelectorAll('div').forEach(item => {
    item.addEventListener('click', function() {
      const value = this.getAttribute('data-value');
      updateDisplay(selectedThinkingDisplay, thinkingItems, value, thinkingOptions);
      chrome.storage.sync.set({ thinkingLevel: value });
      closeDropdowns();
    });
  });

  // Close dropdown on outside click
  document.addEventListener('click', closeDropdowns);

  // Load saved settings
  chrome.storage.sync.get(['enabled', 'preferredModel', 'thinkingLevel'], (result) => {
    if (result.enabled !== undefined) enabledToggle.checked = result.enabled;
    updateDisplay(selectedModelDisplay, modelItems, result.preferredModel ?? 'pro', modelOptions);
    updateDisplay(selectedThinkingDisplay, thinkingItems, result.thinkingLevel ?? 'standard', thinkingOptions);

    // Re-enable transitions after initial state is painted
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { document.body.classList.remove('no-transition'); });
    });
  });

  // Persist toggle state
  enabledToggle.addEventListener('change', () => {
    chrome.storage.sync.set({ enabled: enabledToggle.checked });
  });
});
