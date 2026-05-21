// content.js

// ── Constants ────────────────────────────────────────────────────────────────

// CSS selectors for Gemini's model-switcher UI elements.
// These are stable class/attribute names used throughout the extension.
const TRIGGER_SELECTOR = ".input-area-switch";          // The pill button that opens the model menu
const TRIGGER_LABEL_SELECTOR = ".logo-pill-label-container span"; // Text label inside the trigger pill

// Maps each internal model key to its aria data-test-id in the dropdown menu.
// Gemini uses these predictable test IDs, so we prefer them over text-matching.
const MODEL_SELECTORS = {
  "pro": "[data-test-id='bard-mode-option-pro']",
  "flash": "[data-test-id='bard-mode-option-flash']",
  "flash-lite": "[data-test-id='bard-mode-option-flash-lite']"
};

// Default priority order when the user picks "pro" (or an unknown value).
// The extension walks this list top-to-bottom and picks the first non-limited model.
const MODEL_HIERARCHY_BASE = ["pro", "flash", "flash-lite"];

// ── State ────────────────────────────────────────────────────────────────────

let settings = { enabled: true, preferredModel: "pro", thinkingLevel: "standard" };

// True once the user has physically clicked the model switcher this session.
// When set, the auto-switcher backs off permanently until the page reloads.
let userManuallySelected = false;

let lastKnownModel = null;         // Last confirmed model key seen in the trigger label
let lastKnownThinkingLevel = null; // Last confirmed thinking level
let lastTriggerClickTime = 0;      // Timestamp of the last programmatic trigger click (debounce)
let isExtensionClick = false;      // Guards against misidentifying our own synthetic clicks as manual input
let extensionActionTimeout = null; // Timer handle for clearing isExtensionClick
let knownRateLimitedModels = new Set(); // Models discovered to be rate-limited this session
let observer = null;               // The primary MutationObserver that watches for DOM changes

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Derive a model key from a display text string. */
function getModelFromText(text) {
  text = text.trim().toLowerCase();
  if (text.includes("pro")) return "pro";
  if (text.includes("flash-lite")) return "flash-lite";
  if (text.includes("flash") && !text.includes("lite")) return "flash";
  return null;
}

/** Simulate a single trusted click (used to open/close menus). */
function simulateClick(element) {
  if (!element) return;
  element.focus();
  element.dispatchEvent(new MouseEvent("click", {
    bubbles: true, cancelable: true, view: window, composed: true
  }));
}

/**
 * Simulate a full mousedown→mouseup→click sequence.
 * Some Angular/Material menu items only react to the full event chain,
 * so a bare 'click' event isn't always enough to register a selection.
 */
function simulateOptionClick(element) {
  if (!element) return;
  ["mousedown", "mouseup", "click"].forEach(type => {
    element.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window, composed: true
    }));
  });
  try { element.click(); } catch (e) { }
}

/**
 * Mark the next `ms` milliseconds as extension-initiated.
 * Must be called before any programmatic click so the manual-override
 * detector (mousedown listener) will see e.isTrusted=false and ignore it.
 */
function setExtensionClick(ms = 800) {
  isExtensionClick = true;
  if (extensionActionTimeout) clearTimeout(extensionActionTimeout);
  extensionActionTimeout = setTimeout(() => { isExtensionClick = false; }, ms);
}

/** Reset per-session switching state. Called on settings change and SPA navigation. */
function resetState() {
  userManuallySelected = false;
  lastKnownModel = null;
  lastKnownThinkingLevel = null;
  lastTriggerClickTime = 0;
  knownRateLimitedModels.clear();
}

/** Disconnect and recreate the MutationObserver that drives auto-switching. */
function restartObserver() {
  if (observer) observer.disconnect();
  observer = new MutationObserver(() => { selectPreferredModel(); });
  observer.observe(document.body, { childList: true, subtree: true });
}

// ── Settings persistence ─────────────────────────────────────────────────────

chrome.storage.sync.get(["enabled", "preferredModel", "thinkingLevel"], (result) => {
  if (result.enabled !== undefined) settings.enabled = result.enabled;
  if (result.preferredModel !== undefined) settings.preferredModel = result.preferredModel;
  if (result.thinkingLevel !== undefined) settings.thinkingLevel = result.thinkingLevel;
  selectPreferredModel();
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled) settings.enabled = changes.enabled.newValue;
  if (changes.preferredModel) {
    settings.preferredModel = changes.preferredModel.newValue;
    lastKnownThinkingLevel = null;
  }
  if (changes.thinkingLevel) {
    settings.thinkingLevel = changes.thinkingLevel.newValue;
    lastKnownThinkingLevel = null;
  }

  resetState();
  const triggerLabel = document.querySelector(TRIGGER_LABEL_SELECTOR);
  if (triggerLabel) lastKnownModel = getModelFromText(triggerLabel.textContent);
  setExtensionClick(800);

  restartObserver();
  selectPreferredModel();
});

// ── Manual-interaction detection ─────────────────────────────────────────────

document.addEventListener("mousedown", (e) => {
  const isTrigger = e.target.closest(".input-area-switch");
  const isModelOption = e.target.closest("gem-menu-item, [role='menuitemradio'], [role='menuitem']");

  if ((isTrigger || isModelOption) && e.isTrusted) {
    userManuallySelected = true;
    if (observer) observer.disconnect();
    isExtensionClick = false;
    if (extensionActionTimeout) clearTimeout(extensionActionTimeout);
  }
}, true);

// ── Core logic ───────────────────────────────────────────────────────────────

function selectPreferredModel() {
  if (!settings.enabled || userManuallySelected) return;

  for (const banner of document.querySelectorAll(".disclaimer-container, .promo")) {
    const text = banner.innerText.toLowerCase();
    if (text.includes("limit resets on") || text.includes("responses will use other models") || text.includes("reached your")) {
      knownRateLimitedModels.add("pro");
      break;
    }
  }

  const triggerLabel = document.querySelector(TRIGGER_LABEL_SELECTOR);
  if (triggerLabel) {
    const m = getModelFromText(triggerLabel.textContent);
    if (m) lastKnownModel = m;
  }

  const hierarchyMap = {
    "flash": ["flash", "pro", "flash-lite"],
    "flash-lite": ["flash-lite", "flash", "pro"],
  };
  const MODEL_HIERARCHY = hierarchyMap[settings.preferredModel] ?? [...MODEL_HIERARCHY_BASE];

  // ── Case A: Model dropdown is currently open ──────────────────────────────
  const optionsFound = document.querySelector("gem-menu-item, [role='menuitemradio'], [role='menuitem']");
  if (optionsFound) {
    if (window._geminiSwitcherEvaluatingMenu) return;

    if (!isExtensionClick) {
      userManuallySelected = true;
      if (observer) observer.disconnect();
      return;
    }

    window._geminiSwitcherEvaluatingMenu = true;

    setTimeout(() => {
      if (!document.querySelector("gem-menu-item, [role='menuitemradio'], [role='menuitem']")) {
        window._geminiSwitcherEvaluatingMenu = false;
        return;
      }

      for (const modelKey of MODEL_HIERARCHY) {
        let option = document.querySelector(MODEL_SELECTORS[modelKey]);

        if (!option) {
          option = Array.from(document.querySelectorAll("gem-menu-item, [role='menuitemradio'], [role='menuitem']"))
            .find(el => {
              const elText = el.innerText.toLowerCase();
              if (modelKey === "flash" && elText.includes("lite")) return false;
              if (elText.includes("thinking level")) return false;
              return elText.includes(modelKey);
            });
        }
        if (!option) continue;

        const isRateLimited =
          option.innerText.toLowerCase().includes("limit") ||
          option.getAttribute("aria-disabled") === "true";

        if (isRateLimited) {
          knownRateLimitedModels.add(modelKey);
          continue;
        }
        knownRateLimitedModels.delete(modelKey);

        const isSelected =
          lastKnownModel === modelKey ||
          option.classList.contains("selected") ||
          option.getAttribute("aria-checked") === "true" ||
          option.getAttribute("aria-current") === "true";

        const needsThinkingUpdate = lastKnownThinkingLevel !== settings.thinkingLevel;

        if (isSelected && !needsThinkingUpdate) {
          window._geminiSwitcherEvaluatingMenu = false;
          return;
        }

        if (!isSelected) {
          setExtensionClick(2000); // give enough time for the full cycle
          window._geminiSwitcherEvaluatingMenu = true; // Hard lock observer

          setTimeout(() => {
            simulateOptionClick(option);
            lastKnownModel = modelKey;
            lastKnownThinkingLevel = null; // force re-evaluation
            lastTriggerClickTime = Date.now() + 10000; // Prevent observer from prematurely opening menu

            setTimeout(() => {
              isExtensionClick = false;
              const newLabel = document.querySelector(TRIGGER_LABEL_SELECTOR);
              if (newLabel) lastKnownModel = getModelFromText(newLabel.textContent);

              lastTriggerClickTime = 0; // Unblock menu opening
              window._geminiSwitcherEvaluatingMenu = false; // Unlock observer
              selectPreferredModel(); // Safely start Cycle 2
            }, 600); // Wait 1.2s for Gemini to completely settle after a model change

          }, 50);
          return;
        }

        // Logic for setting thinking level if the model is already selected
        const thinkingBtn = document.querySelector('gem-menu-item[value="thinking_level"]') ||
          Array.from(document.querySelectorAll("gem-menu-item, [role='menuitemradio'], [role='menuitem']"))
            .find(el => el.textContent.toLowerCase().includes("thinking level") && el.getAttribute('value') === 'thinking_level');

        if (thinkingBtn) {
          setExtensionClick(1000);
          simulateOptionClick(thinkingBtn);

          setTimeout(() => {
            const levelOpt = Array.from(document.querySelectorAll("gem-menu-item, [role='menuitemradio'], [role='menuitem']"))
              .find(el => {
                const txt = el.textContent.toLowerCase();
                return txt.includes(settings.thinkingLevel) && el.getAttribute('value') !== 'thinking_level';
              });

            setExtensionClick(1000);
            if (levelOpt) {
              simulateOptionClick(levelOpt);
            } else {
              simulateOptionClick(option); // close menu fallback
            }
            lastKnownThinkingLevel = settings.thinkingLevel;
            window._geminiSwitcherEvaluatingMenu = false;
          }, 600);
          return;
        } else {
          lastKnownThinkingLevel = settings.thinkingLevel;
          window._geminiSwitcherEvaluatingMenu = false;
        }

        return;
      }

      window._geminiSwitcherEvaluatingMenu = false;
    }, 150);
    return;
  }

  // ── Case B: Menu is closed – decide if we need to open it ─────────────────
  if (lastKnownModel) {
    let bestIdx = 0;
    while (bestIdx < MODEL_HIERARCHY.length && knownRateLimitedModels.has(MODEL_HIERARCHY[bestIdx])) {
      bestIdx++;
    }
    const bestModel = MODEL_HIERARCHY[bestIdx];

    if (MODEL_HIERARCHY.indexOf(lastKnownModel) === bestIdx && lastKnownThinkingLevel === settings.thinkingLevel) {
      return;
    }
  }

  const triggerBtn = document.querySelector(TRIGGER_SELECTOR);
  if (triggerBtn) {
    const now = Date.now();
    if (now - lastTriggerClickTime < 1000) return;

    setExtensionClick(1000);
    triggerBtn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    simulateClick(triggerBtn);
    lastTriggerClickTime = now;
  }
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

restartObserver();
selectPreferredModel();

// ── SPA navigation handling ──────────────────────────────────────────────────

let currentUrl = location.href;

function handleNavigation() {
  if (location.href === currentUrl) return;
  currentUrl = location.href;
  resetState();
  restartObserver();
  setTimeout(() => selectPreferredModel(), 500);
}

new MutationObserver(handleNavigation).observe(document.body, { childList: true, subtree: true });
window.addEventListener("popstate", handleNavigation);
setInterval(handleNavigation, 500);

