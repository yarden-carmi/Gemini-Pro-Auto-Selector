document.addEventListener('DOMContentLoaded', () => {
  const enabledToggle = document.getElementById('enabled-toggle');
  const customSelect = document.getElementById('custom-model-select');
  const selectSelected = customSelect.querySelector('.select-selected');
  const selectItems = customSelect.querySelector('.select-items');
  const selectedModelDisplay = document.getElementById('selected-model-display');

  const modelOptions = {
    'pro':     { name: 'Pro',      icon: 'diamond_shine' },
    'thinking':{ name: 'Thinking', icon: 'cognition_2' },
    'fast':    { name: 'Fast',     icon: 'bolt' }
  };



  function closeDropdown() {
    selectSelected.classList.remove('select-arrow-active');
    selectItems.classList.remove('select-show');
  }

  function updateSelectedDisplay(value) {
    const model = modelOptions[value];
    if (!model) return;
    selectedModelDisplay.innerHTML = `
      <span class="material-symbols-outlined model-icon">${model.icon}</span>
      <span>${model.name}</span>
    `;
    selectItems.querySelectorAll('div').forEach(item => {
      item.classList.toggle('same-as-selected', item.getAttribute('data-value') === value);
    });
  }

  // Toggle dropdown open/closed
  selectSelected.addEventListener('click', function(e) {
    e.stopPropagation();
    this.classList.toggle('select-arrow-active');
    selectItems.classList.toggle('select-show');
  });

  // Handle option selection
  selectItems.querySelectorAll('div').forEach(item => {
    item.addEventListener('click', function() {
      const value = this.getAttribute('data-value');
      updateSelectedDisplay(value);
      chrome.storage.sync.set({ preferredModel: value });
      closeDropdown();
    });
  });

  // Close dropdown on outside click
  document.addEventListener('click', closeDropdown);

  // Load saved settings
  chrome.storage.sync.get(['enabled', 'preferredModel'], (result) => {
    if (result.enabled !== undefined) enabledToggle.checked = result.enabled;
    updateSelectedDisplay(result.preferredModel ?? 'pro');

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
