// content.js

// ── Constants ────────────────────────────────────────────────────────────────

// CSS selectors for Gemini's model-switcher UI elements.
const TRIGGER_SELECTOR = ".input-area-switch";
const TRIGGER_LABEL_SELECTOR = ".input-area-switch, .logo-pill-label-container";

// Default priority order when the user picks "pro" (or an unknown value).
const MODEL_HIERARCHY_BASE = ["pro", "flash", "flash-lite"];

// ── State ────────────────────────────────────────────────────────────────────

let settings = { enabled: true, preferredModel: "pro", thinkingLevel: "low" };

// True once the user has physically clicked the model switcher this session.
// When set, the auto-switcher backs off permanently until the page reloads.
let userManuallySelected = false;

let lastKnownModel = null;              // Last confirmed model key seen in trigger label ("pro" | "flash" | "flash-lite")
let lastKnownThinkingLevel = null;      // Last confirmed thinking level ("low" | "medium" | "high")
let lastTriggerClickTime = 0;           // Timestamp of the last programmatic trigger click (debounce)
let isExtensionClick = false;           // Guards against misidentifying our own synthetic clicks as manual input
let extensionActionTimeout = null;      // Timer handle for clearing isExtensionClick
let knownRateLimitedModels = new Set(); // Models discovered to be rate-limited this session
let modelsWithoutThinking = new Set();  // Models that don't support thinking levels in the UI
let observer = null;                    // The primary MutationObserver that watches for DOM changes

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Derive a model key from a display text string (supports 3.x, 4 / 4.*, Pro, etc.). */
function getModelFromText(text) {
  if (!text) return null;
  text = text.trim().toLowerCase();
  if (text.includes("flash-lite") || text.includes("flash lite")) return "flash-lite";
  if (text.includes("flash") && !text.includes("lite")) return "flash";
  // Future-proof: matches Pro (e.g. 3.1 Pro, 4 Pro, 4.0 Pro) and 4 / 4.* (e.g. 4.0, 4.1, 4)
  if (text.includes("pro") || /\b4(\.\d+)?\b/.test(text)) return "pro";
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

/** Normalize thinking level string (supports legacy "standard" and "extended"). */
function normalizeThinkingLevel(level) {
  if (level === "standard") return "low";
  if (level === "extended") return "high";
  if (level === "low" || level === "medium" || level === "high") return level;
  return "low";
}

/** Derive active thinking level from trigger button ("low" | "medium" | "high"). */
function getThinkingFromTrigger(triggerEl) {
  if (!triggerEl) return "low";
  const secondaryEl = triggerEl.querySelector(".picker-secondary-text, [data-test-id='secondary-text']");
  const secondaryText = secondaryEl ? secondaryEl.textContent.trim().toLowerCase() : "";
  const fullText = (triggerEl.innerText + " " + (triggerEl.getAttribute("aria-label") || "")).toLowerCase();

  if (secondaryText === "high" || fullText.includes("high") || fullText.includes("extended")) {
    return "high";
  }
  if (secondaryText === "medium" || fullText.includes("medium")) {
    return "medium";
  }
  if (secondaryText === "low" || fullText.includes("low")) {
    return "low";
  }
  return "low";
}

/** Determine if a dropdown menu item belongs to the thinking level picker. */
function isThinkingMenuItem(el) {
  if (!el) return false;
  const text = el.innerText.toLowerCase();
  const labelEl = el.querySelector(".label, .item-label, [class*='label']");
  const label = (labelEl ? labelEl.textContent : el.innerText.split("\n")[0]).trim().toLowerCase();

  if (label === "low" || label === "medium" || label === "high") return true;
  if (text.includes("quick and efficient") || text.includes("balanced depth") || text.includes("extra thorough")) return true;
  if (text.includes("extended thinking") || text.includes("thinking level")) return true;
  return false;
}

/** Check if a menu item represents the requested modelKey. */
function matchesModelOption(el, modelKey) {
  if (isThinkingMenuItem(el)) return false;
  const text = el.innerText.toLowerCase();

  if (modelKey === "flash-lite") {
    return text.includes("flash-lite") || text.includes("flash lite");
  }
  if (modelKey === "flash") {
    return text.includes("flash") && !text.includes("lite");
  }
  if (modelKey === "pro") {
    // Avoid accidentally matching any future 4.x Flash models
    if (text.includes("flash")) return false;
    // Matches 3.1 Pro, 4 Pro, 4.0 Pro, 4.* Pro, or 4 / 4.x
    return text.includes("pro") || /\b4(\.\d+)?\b/.test(text);
  }
  return false;
}

/** Check whether a menu item is currently selected in Gemini's menu. */
function isMenuItemSelected(el) {
  if (!el) return false;
  return el.classList.contains("selected") ||
    !!el.querySelector("[aria-label='Selected'], .selected, mat-icon[fonticon='check']");
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
  modelsWithoutThinking.clear();
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
  if (result.thinkingLevel !== undefined) settings.thinkingLevel = normalizeThinkingLevel(result.thinkingLevel);
  selectPreferredModel();
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled) settings.enabled = changes.enabled.newValue;
  if (changes.preferredModel) {
    settings.preferredModel = changes.preferredModel.newValue;
    lastKnownThinkingLevel = null;
  }
  if (changes.thinkingLevel) {
    settings.thinkingLevel = normalizeThinkingLevel(changes.thinkingLevel.newValue);
    lastKnownThinkingLevel = null;
  }

  resetState();
  const trigger = document.querySelector(TRIGGER_SELECTOR);
  if (trigger && isValidModelTrigger(trigger)) {
    const primaryLabel = trigger.querySelector(".picker-primary-text, [data-test-id='primary-text']");
    lastKnownModel = getModelFromText(primaryLabel ? primaryLabel.innerText : trigger.innerText);
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
    const primaryLabel = trigger.querySelector(".picker-primary-text, [data-test-id='primary-text']");
    const m = getModelFromText(primaryLabel ? primaryLabel.innerText : trigger.innerText);
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
        let option = allMenuItems.find(el => matchesModelOption(el, modelKey));
        if (!option) continue;

        const isRateLimited =
          option.innerText.toLowerCase().includes("limit") ||
          option.getAttribute("aria-disabled") === "true";

        if (isRateLimited) {
          knownRateLimitedModels.add(modelKey);
          continue;
        }
        knownRateLimitedModels.delete(modelKey);

        const isSelected = isMenuItemSelected(option);
        const targetThinking = normalizeThinkingLevel(settings.thinkingLevel);
        const thinkingMatches = modelsWithoutThinking.has(modelKey) || lastKnownThinkingLevel === targetThinking;

        if (isSelected && thinkingMatches) {
          window._geminiSwitcherEvaluatingMenu = false;
          // Close menu since already satisfied
          const trg = document.querySelector(TRIGGER_SELECTOR);
          if (trg) {
            setExtensionClick(500);
            simulateOptionClick(trg);
          }
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
                const primary = newTrigger.querySelector(".picker-primary-text, [data-test-id='primary-text']");
                lastKnownModel = getModelFromText(primary ? primary.innerText : newTrigger.innerText);
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
        // 1. New direct Thinking Levels menu (Low, Medium, High)
        const lowItem = allMenuItems.find(el => {
          if (!isThinkingMenuItem(el)) return false;
          const lbl = (el.querySelector(".label, .item-label, [class*='label']")?.textContent || el.innerText.split("\n")[0]).trim().toLowerCase();
          return lbl === "low" || el.innerText.toLowerCase().includes("quick and efficient");
        });
        const medItem = allMenuItems.find(el => {
          if (!isThinkingMenuItem(el)) return false;
          const lbl = (el.querySelector(".label, .item-label, [class*='label']")?.textContent || el.innerText.split("\n")[0]).trim().toLowerCase();
          return lbl === "medium" || el.innerText.toLowerCase().includes("balanced depth");
        });
        const highItem = allMenuItems.find(el => {
          if (!isThinkingMenuItem(el)) return false;
          const lbl = (el.querySelector(".label, .item-label, [class*='label']")?.textContent || el.innerText.split("\n")[0]).trim().toLowerCase();
          return lbl === "high" || el.innerText.toLowerCase().includes("extra thorough");
        });

        if (lowItem || medItem || highItem) {
          let targetThinkingItem = lowItem;
          if (targetThinking === "medium") targetThinkingItem = medItem || lowItem;
          else if (targetThinking === "high") targetThinkingItem = highItem || lowItem;

          if (targetThinkingItem) {
            if (isMenuItemSelected(targetThinkingItem)) {
              // Already selected
              lastKnownThinkingLevel = targetThinking;
              window._geminiSwitcherEvaluatingMenu = false;
              const trg = document.querySelector(TRIGGER_SELECTOR);
              if (trg) {
                setExtensionClick(500);
                simulateOptionClick(trg);
              }
              return;
            }

            // Click the desired thinking item
            setExtensionClick(1500);
            simulateOptionClick(targetThinkingItem);
            lastKnownThinkingLevel = targetThinking;

            setTimeout(() => {
              isExtensionClick = false;
              const newTrigger = document.querySelector(TRIGGER_SELECTOR);
              if (newTrigger) lastKnownThinkingLevel = getThinkingFromTrigger(newTrigger);
              window._geminiSwitcherEvaluatingMenu = false;
            }, 600);
            return;
          }
        }

        // 2. Fallback: Layout with direct "Extended thinking" toggle item
        const extendedThinkingItem = allMenuItems.find(el => el.innerText.toLowerCase().includes("extended thinking"));
        if (extendedThinkingItem) {
          const isExtendedSelected = isMenuItemSelected(extendedThinkingItem);
          const wantsExtended = targetThinking === "high";

          if (wantsExtended !== isExtendedSelected) {
            setExtensionClick(1500);
            simulateOptionClick(extendedThinkingItem);
            lastKnownThinkingLevel = targetThinking;

            setTimeout(() => {
              isExtensionClick = false;
              const newTrigger = document.querySelector(TRIGGER_SELECTOR);
              if (newTrigger) lastKnownThinkingLevel = getThinkingFromTrigger(newTrigger);
              window._geminiSwitcherEvaluatingMenu = false;
            }, 600);
            return;
          } else {
            lastKnownThinkingLevel = targetThinking;
            window._geminiSwitcherEvaluatingMenu = false;
            const trg = document.querySelector(TRIGGER_SELECTOR);
            if (trg) {
              setExtensionClick(500);
              simulateOptionClick(trg);
            }
            return;
          }
        }

        // 3. Fallback: Legacy "Thinking level" sub-menu
        const legacyThinkingBtn = allMenuItems.find(el => el.innerText.toLowerCase().includes("thinking level") && el.getAttribute("value") === "thinking_level");
        if (legacyThinkingBtn) {
          setExtensionClick(1000);
          simulateOptionClick(legacyThinkingBtn);

          setTimeout(() => {
            const levelOpt = Array.from(document.querySelectorAll("gem-menu-item, [role='menuitemradio'], [role='menuitem']"))
              .find(el => {
                const txt = el.textContent.toLowerCase();
                const targetText = targetThinking === "high" ? "extended" : (targetThinking === "medium" ? "medium" : "standard");
                return (txt.includes(targetText) || txt.includes(targetThinking)) && el.getAttribute('value') !== 'thinking_level';
              });

            setExtensionClick(1000);
            if (levelOpt) {
              simulateOptionClick(levelOpt);
            } else {
              simulateOptionClick(option);
            }
            lastKnownThinkingLevel = targetThinking;
            window._geminiSwitcherEvaluatingMenu = false;
          }, 600);
          return;
        }

        // No thinking option found on page for this model
        modelsWithoutThinking.add(modelKey);
        lastKnownThinkingLevel = targetThinking;
        window._geminiSwitcherEvaluatingMenu = false;
        const trg = document.querySelector(TRIGGER_SELECTOR);
        if (trg) {
          setExtensionClick(500);
          simulateOptionClick(trg);
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

    const currentIdx = MODEL_HIERARCHY.indexOf(lastKnownModel);
    const targetThinking = normalizeThinkingLevel(settings.thinkingLevel);
    const thinkingMatches = modelsWithoutThinking.has(lastKnownModel) || lastKnownThinkingLevel === targetThinking;

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
