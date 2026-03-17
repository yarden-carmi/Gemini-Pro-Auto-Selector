// content.js

// ── Constants ────────────────────────────────────────────────────────────────

// CSS selectors for Gemini's model-switcher UI elements.
// These are stable class/attribute names used throughout the extension.
const TRIGGER_SELECTOR       = ".input-area-switch";          // The pill button that opens the model menu
const TRIGGER_LABEL_SELECTOR = ".logo-pill-label-container span"; // Text label inside the trigger pill

// Maps each internal model key to its aria data-test-id in the dropdown menu.
// Gemini uses these predictable test IDs, so we prefer them over text-matching.
const MODEL_SELECTORS = {
  "pro":     "[data-test-id='bard-mode-option-pro']",
  "thinking":"[data-test-id='bard-mode-option-thinking']",
  "fast":    "[data-test-id='bard-mode-option-fast']"
};

// Default priority order when the user picks "pro" (or an unknown value).
// The extension walks this list top-to-bottom and picks the first non-limited model.
const MODEL_HIERARCHY_BASE = ["pro", "thinking", "fast"];

// ── State ────────────────────────────────────────────────────────────────────

let settings = { enabled: true, preferredModel: "pro" };

// True once the user has physically clicked the model switcher this session.
// When set, the auto-switcher backs off permanently until the page reloads.
let userManuallySelected = false;

let lastKnownModel = null;         // Last confirmed model key seen in the trigger label
let lastTriggerClickTime = 0;      // Timestamp of the last programmatic trigger click (debounce)
let isExtensionClick = false;      // Guards against misidentifying our own synthetic clicks as manual input
let extensionActionTimeout = null; // Timer handle for clearing isExtensionClick
let knownRateLimitedModels = new Set(); // Models discovered to be rate-limited this session
let observer = null;               // The primary MutationObserver that watches for DOM changes

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Derive a model key from a display text string. */
function getModelFromText(text) {
  text = text.trim().toLowerCase();
  if (text.includes("pro") || text.includes("advanced")) return "pro";
  if (text.includes("thinking")) return "thinking";
  if (text.includes("flash") || text.includes("fast")) return "fast";
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

// Load saved settings on initial inject, then trigger a first-pass model check.
chrome.storage.sync.get(["enabled", "preferredModel"], (result) => {
  if (result.enabled !== undefined) settings.enabled = result.enabled;
  if (result.preferredModel !== undefined) settings.preferredModel = result.preferredModel;
  selectPreferredModel();
});

// React to popup changes in real-time without requiring a page reload.
chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled) settings.enabled = changes.enabled.newValue;
  if (changes.preferredModel) settings.preferredModel = changes.preferredModel.newValue;

  // Reset session state, but snapshot the current label first and mark the
  // next tick as extension-initiated so the observer doesn't misread it as
  // a manual override when the model doesn't yet match the new preference.
  resetState();
  const triggerLabel = document.querySelector(TRIGGER_LABEL_SELECTOR);
  if (triggerLabel) lastKnownModel = getModelFromText(triggerLabel.textContent);
  setExtensionClick(800);

  restartObserver();
  selectPreferredModel();
});

// ── Manual-interaction detection ─────────────────────────────────────────────

// Capture-phase mousedown lets us intercept user clicks before they reach
// Angular's event handlers. Only trusted events (real mouse input) count —
// our synthetic MouseEvents have e.isTrusted === false and are ignored.
document.addEventListener("mousedown", (e) => {
  const isTrigger = e.target.closest(".input-area-switch");
  const isModelOption = e.target.closest("[role='menuitemradio'], [role='menuitem']");

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

  // Proactively detect quota banners before reading the trigger label.
  // Gemini sometimes still shows "Pro" in the pill even when Pro is limited,
  // so we scan the DOM for known rate-limit message strings.
  for (const banner of document.querySelectorAll(".disclaimer-container, .promo")) {
    const text = banner.innerText.toLowerCase();
    if (text.includes("limit resets on") || text.includes("responses will use other models") || text.includes("reached your")) {
      knownRateLimitedModels.add("pro");
      break;
    }
  }

  // Snapshot what model the trigger pill currently shows.
  const triggerLabel = document.querySelector(TRIGGER_LABEL_SELECTOR);
  if (triggerLabel) {
    const m = getModelFromText(triggerLabel.textContent);
    if (m) lastKnownModel = m;
  }

  // Build the preference-ordered fallback list for this evaluation.
  // "pro" is the default map entry via MODEL_HIERARCHY_BASE.
  const hierarchyMap = {
    "thinking": ["thinking", "pro", "fast"],
    "fast":     ["fast", "thinking", "pro"],
  };
  const MODEL_HIERARCHY = hierarchyMap[settings.preferredModel] ?? [...MODEL_HIERARCHY_BASE];

  // ── Case A: Model dropdown is currently open ──────────────────────────────
  const optionsFound = document.querySelector("[role='menuitemradio'], [role='menuitem']");
  if (optionsFound) {
    // Re-entrancy guard: if we're already inside the 150 ms aria-disabled wait,
    // don't start another evaluation on top of it.
    if (window._geminiSwitcherEvaluatingMenu) return;

    // If the menu appeared but we didn't open it, the user must have.
    if (!isExtensionClick) {
      userManuallySelected = true;
      if (observer) observer.disconnect();
      return;
    }

    window._geminiSwitcherEvaluatingMenu = true;

    // Google attaches aria-disabled to rate-limited options asynchronously
    // after the menu renders. Wait 150 ms so those attributes are present
    // before we decide which option to click.
    setTimeout(() => {
      window._geminiSwitcherEvaluatingMenu = false;

      // Menu may have closed during the wait (e.g. user pressed Escape).
      if (!document.querySelector("[role='menuitemradio'], [role='menuitem']")) return;

      // Walk the priority list and pick the first available (non-limited) model.
      for (const modelKey of MODEL_HIERARCHY) {
        let option = document.querySelector(MODEL_SELECTORS[modelKey]);

        // data-test-id selectors are preferred but may disappear in future
        // Gemini updates. Fall back to case-insensitive text matching.
        if (!option) {
          option = Array.from(document.querySelectorAll("[role='menuitemradio'], [role='menuitem']"))
            .find(el => el.innerText.toLowerCase().includes(modelKey));
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

        // Whether the model is already active or needs switching, we always
        // call simulateOptionClick: it selects a new model OR closes the menu
        // if the correct one is already checked — both outcomes are correct.
        const isSelected =
          option.getAttribute("aria-checked") === "true" ||
          option.getAttribute("aria-current") === "true";

        // Short delay so any pending Angular micro-tasks settle before the click.
        setExtensionClick(800);
        setTimeout(() => {
          simulateOptionClick(option);
          lastKnownModel = modelKey;
          // After clicking, update lastKnownModel from the live label once
          // Gemini has had time to update it.
          extensionActionTimeout = setTimeout(() => {
            isExtensionClick = false;
            const newLabel = document.querySelector(TRIGGER_LABEL_SELECTOR);
            if (newLabel) lastKnownModel = getModelFromText(newLabel.textContent);
          }, 800);
        }, 50);
        return;
      }
      // If every model in the hierarchy was rate-limited, there's nothing to do.
    }, 150);
    return;
  }

  // ── Case B: Menu is closed – decide if we need to open it ─────────────────
  // Compare the currently-active model against the best available option.
  // If they match, nothing to do. If they don't, open the menu so Case A runs.
  if (lastKnownModel) {
    let bestIdx = 0;
    while (bestIdx < MODEL_HIERARCHY.length && knownRateLimitedModels.has(MODEL_HIERARCHY[bestIdx])) {
      bestIdx++;
    }
    // lastKnownModel is already the best available option — nothing to switch.
    if (MODEL_HIERARCHY.indexOf(lastKnownModel) === bestIdx) return;
  }

  const triggerBtn = document.querySelector(TRIGGER_SELECTOR);
  if (triggerBtn) {
    const now = Date.now();
    // Debounce: don't spam-open the menu if a previous open is still in flight.
    if (now - lastTriggerClickTime < 1000) return;

    // mouseover before click mirrors what a real mouse hover does and helps
    // Angular's event model attach the menu correctly before it opens.
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
  // A new chat starts fresh — clear rate-limit knowledge and manual-override
  // flags so the extension auto-switches on the new page.
  resetState();
  restartObserver();
  setTimeout(() => selectPreferredModel(), 500);
}

// Three complementary strategies to catch Gemini's SPA navigation:
// 1. MutationObserver on body — catches most pushState-driven route changes.
// 2. popstate — catches browser back/forward button navigation.
// 3. setInterval — safety net for pushState/replaceState calls that don't
//    trigger a DOM mutation or popstate (e.g. deep-linked message anchors).
new MutationObserver(handleNavigation).observe(document.body, { childList: true, subtree: true });
window.addEventListener("popstate", handleNavigation);
setInterval(handleNavigation, 500);
