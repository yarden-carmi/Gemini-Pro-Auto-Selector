// content.js

// ── Constants ────────────────────────────────────────────────────────────────

// CSS selectors for Gemini's model-switcher UI elements.
const TRIGGER_SELECTOR = ".input-area-switch";
const TRIGGER_LABEL_SELECTOR = ".input-area-switch, .logo-pill-label-container";

// Default priority order when the user picks "pro" (or an unknown value).
const MODEL_HIERARCHY_BASE = ["pro", "flash", "flash-lite"];

// ── State ────────────────────────────────────────────────────────────────────

let settings = { enabled: true, preferredModel: "pro", thinkingLevel: "standard" };

// True once the user has physically clicked the model switcher this session.
// When set, the auto-switcher backs off permanently until the page reloads.
let userManuallySelected = false;

let lastKnownModel = null;         // Last confirmed model key seen in the trigger label
let lastKnownThinkingLevel = null; // Last confirmed thinking level ("standard" | "extended")
let lastTriggerClickTime = 0;      // Timestamp of the last programmatic trigger click (debounce)
let isExtensionClick = false;      // Guards against misidentifying our own synthetic clicks as manual input
let extensionActionTimeout = null; // Timer handle for clearing isExtensionClick
let knownRateLimitedModels = new Set(); // Models discovered to be rate-limited this session
let observer = null;               // The primary MutationObserver that watches for DOM changes

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Derive a model key from a display text string (supports 3.7, 3.8, etc.). */
function getModelFromText(text) {
  if (!text) return null;
  text = text.trim().toLowerCase();
  if (text.includes("flash-lite") || text.includes("flash lite")) return "flash-lite";
  if (text.includes("flash") && !text.includes("lite")) return "flash";
  if (text.includes("pro")) return "pro";
  return null;
}

/** Check if the current URL should be excluded (e.g. Gems creation/editor pages). */
function isExcludedPage() {
  const path = location.pathname.toLowerCase();
  return path.startsWith("/gems") || location.href.toLowerCase().includes("/gems");
}

/** Check if the found trigger element is truly the model selector (not a tool picker). */
function isValidModelTrigger(triggerEl) {
  if (!triggerEl) return false;
  const text = (triggerEl.innerText + " " + (triggerEl.getAttribute("aria-label") || "")).toLowerCase();
  if (text.includes("tool") || triggerEl.closest(".gem-builder, .tool-selector, .default-tool-container")) {
    return false;
  }
  return true;
}

/** Check if trigger indicates Extended thinking is active. */
function getThinkingFromTrigger(triggerEl) {
  if (!triggerEl) return "standard";
  const text = (triggerEl.innerText + " " + (triggerEl.getAttribute("aria-label") || "")).toLowerCase();
  return text.includes("extended") ? "extended" : "standard";
}

/** Simulate a single trusted click. */
function simulateClick(element) {
  if (!element) return;
  try { element.click(); } catch (e) { }
}

/** Simulate a full mousedown→mouseup→click sequence without double-firing click. */
function simulateOptionClick(element) {
  if (!element) return;
  ["mousedown", "mouseup"].forEach(type => {
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
  const trigger = document.querySelector(TRIGGER_SELECTOR);
  if (trigger) {
    lastKnownModel = getModelFromText(trigger.innerText);
    lastKnownThinkingLevel = getThinkingFromTrigger(trigger);
  }
  setExtensionClick(800);

  restartObserver();
  selectPreferredModel();
});

// ── Manual-interaction detection ─────────────────────────────────────────────

document.addEventListener("mousedown", (e) => {
  const isTrigger = e.target.closest(TRIGGER_SELECTOR);
  const isModelOption = e.target.closest("gem-menu-item, [role='menuitemradio'], [role='menuitem']");

  if ((isTrigger || isModelOption) && e.isTrusted && !isExtensionClick) {
    userManuallySelected = true;
    if (observer) observer.disconnect();
    isExtensionClick = false;
    if (extensionActionTimeout) clearTimeout(extensionActionTimeout);
  }
}, true);

// ── Core logic ───────────────────────────────────────────────────────────────

function selectPreferredModel() {
  if (!settings.enabled || userManuallySelected || isExcludedPage()) return;

  // Check rate limit banners
  for (const banner of document.querySelectorAll(".disclaimer-container, .promo")) {
    const text = banner.innerText.toLowerCase();
    if (text.includes("limit resets on") || text.includes("responses will use other models") || text.includes("reached your")) {
      knownRateLimitedModels.add("pro");
      break;
    }
  }

  const trigger = document.querySelector(TRIGGER_SELECTOR);
  if (trigger && isValidModelTrigger(trigger)) {
    const m = getModelFromText(trigger.innerText);
    if (m) lastKnownModel = m;
    lastKnownThinkingLevel = getThinkingFromTrigger(trigger);
  }

  const hierarchyMap = {
    "flash": ["flash", "pro", "flash-lite"],
    "flash-lite": ["flash-lite", "flash", "pro"],
    "pro": ["pro", "flash", "flash-lite"]
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
      const allMenuItems = Array.from(document.querySelectorAll("gem-menu-item, [role='menuitemradio'], [role='menuitem']"));
      if (!allMenuItems.length) {
        window._geminiSwitcherEvaluatingMenu = false;
        return;
      }

      for (const modelKey of MODEL_HIERARCHY) {
        // Find model option matching modelKey (e.g. 3.7 Flash, 3.8 Flash, 3.1 Pro, etc.)
        let option = allMenuItems.find(el => {
          const elText = el.innerText.toLowerCase();
          if (elText.includes("extended thinking") || elText.includes("thinking level")) return false;
          if (modelKey === "flash-lite") return elText.includes("flash-lite") || elText.includes("flash lite");
          if (modelKey === "flash") return elText.includes("flash") && !elText.includes("lite");
          if (modelKey === "pro") return elText.includes("pro");
          return false;
        });

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
          option.classList.contains("selected") ||
          !!option.querySelector("[aria-label='Selected'], .selected");

        const needsThinkingUpdate = lastKnownThinkingLevel !== settings.thinkingLevel;

        if (isSelected && !needsThinkingUpdate) {
          window._geminiSwitcherEvaluatingMenu = false;
          return;
        }

        // If target model is not selected yet, click it
        if (!isSelected) {
          setExtensionClick(2000);
          window._geminiSwitcherEvaluatingMenu = true;

          setTimeout(() => {
            simulateOptionClick(option);
            lastKnownModel = modelKey;
            lastKnownThinkingLevel = null; // force re-evaluation of thinking
            lastTriggerClickTime = Date.now() + 10000; // prevent premature menu opening

            setTimeout(() => {
              isExtensionClick = false;
              const newTrigger = document.querySelector(TRIGGER_SELECTOR);
              if (newTrigger) {
                lastKnownModel = getModelFromText(newTrigger.innerText);
                lastKnownThinkingLevel = getThinkingFromTrigger(newTrigger);
              }

              lastTriggerClickTime = 0;
              window._geminiSwitcherEvaluatingMenu = false;
              selectPreferredModel(); // Re-evaluate to apply thinking level if needed
            }, 600);
          }, 50);
          return;
        }

        // Target model IS selected. Now evaluate thinking level.
        // Look for the "Extended thinking" menu item in the dropdown
        const extendedThinkingItem = allMenuItems.find(el => el.innerText.toLowerCase().includes("extended thinking"));
        const legacyThinkingBtn = allMenuItems.find(el => el.innerText.toLowerCase().includes("thinking level") && el.getAttribute("value") === "thinking_level");

        // Layout 1: Direct "Extended thinking" toggle item
        if (extendedThinkingItem) {
          const isExtendedSelected = extendedThinkingItem.classList.contains("selected") ||
            !!extendedThinkingItem.querySelector("[aria-label='Selected'], .selected");
          const wantsExtended = settings.thinkingLevel === "extended";

          if (wantsExtended !== isExtendedSelected) {
            // Need to toggle Extended thinking
            setExtensionClick(1500);
            simulateOptionClick(extendedThinkingItem);
            lastKnownThinkingLevel = settings.thinkingLevel;

            setTimeout(() => {
              isExtensionClick = false;
              const newTrigger = document.querySelector(TRIGGER_SELECTOR);
              if (newTrigger) lastKnownThinkingLevel = getThinkingFromTrigger(newTrigger);
              window._geminiSwitcherEvaluatingMenu = false;
            }, 600);
            return;
          } else {
            // Already matches
            lastKnownThinkingLevel = settings.thinkingLevel;
            window._geminiSwitcherEvaluatingMenu = false;
            // Close menu
            const trg = document.querySelector(TRIGGER_SELECTOR);
            if (trg) {
              setExtensionClick(500);
              simulateClick(trg);
            }
            return;
          }
        }

        // Layout 2: Legacy "Thinking level" sub-menu
        if (legacyThinkingBtn) {
          setExtensionClick(1000);
          simulateOptionClick(legacyThinkingBtn);

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
        }

        // No thinking option found on page
        lastKnownThinkingLevel = settings.thinkingLevel;
        window._geminiSwitcherEvaluatingMenu = false;
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

    const currentIdx = MODEL_HIERARCHY.indexOf(lastKnownModel);
    const thinkingMatches = lastKnownThinkingLevel === settings.thinkingLevel;

    if (currentIdx === bestIdx && thinkingMatches) {
      return;
    }
  }

  const triggerBtn = document.querySelector(TRIGGER_SELECTOR);
  if (triggerBtn && isValidModelTrigger(triggerBtn)) {
    const now = Date.now();
    if (now - lastTriggerClickTime < 1000) return;

    setExtensionClick(1000);
    simulateOptionClick(triggerBtn);
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
