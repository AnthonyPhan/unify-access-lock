const PATCH_FLAG = Symbol.for("doorstate.frontGateCountdownPatched");
const ACTIVE_DIALOGS = new Set();
let animationFrame;

function formatRemaining(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function ensureIndicator(host) {
  const toggle = host.shadowRoot?.querySelector("ha-state-control-lock-toggle");
  const control = toggle?.shadowRoot?.querySelector("ha-control-switch");
  const root = control?.shadowRoot;
  const thumb = root?.querySelector(".button");
  if (!root || !thumb) {
    return undefined;
  }

  if (!root.querySelector("style[data-doorstate-countdown-style]")) {
    const style = document.createElement("style");
    style.dataset.doorstateCountdownStyle = "";
    style.textContent = `
      .button > slot {
        position: relative;
        z-index: 2;
        transition: transform 180ms ease-in-out;
      }
      .button {
        position: relative;
      }
      .button.doorstate-countdown-active > slot {
        transform: translateY(-9px);
      }
      .doorstate-relock-countdown {
        position: absolute;
        left: 50%;
        top: 50%;
        width: 74px;
        height: 74px;
        transform: translate(-50%, -50%);
        pointer-events: none;
        z-index: 1;
        color: var(--warning-color, var(--primary-color));
        opacity: 0;
        transition: opacity 180ms ease-in-out;
      }
      .doorstate-relock-countdown[data-active="true"] {
        opacity: 1;
      }
      .doorstate-relock-countdown svg {
        display: block;
        width: 100%;
        height: 100%;
        overflow: visible;
        transform: rotate(-90deg);
      }
      .doorstate-relock-track,
      .doorstate-relock-progress {
        fill: none;
        stroke-width: 3;
      }
      .doorstate-relock-track {
        stroke: currentColor;
        opacity: 0.2;
      }
      .doorstate-relock-progress {
        stroke: currentColor;
        stroke-linecap: round;
      }
      .doorstate-relock-label {
        position: absolute;
        left: 50%;
        top: calc(50% + 12px);
        transform: translateX(-50%);
        color: currentColor;
        font-size: 11px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        line-height: 1;
        white-space: nowrap;
      }
    `;
    root.append(style);
  }

  let indicator = thumb.querySelector(".doorstate-relock-countdown");
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.className = "doorstate-relock-countdown";
    indicator.setAttribute("aria-hidden", "true");
    indicator.innerHTML = `
      <svg viewBox="0 0 74 74" aria-hidden="true">
        <circle class="doorstate-relock-track" cx="37" cy="37" r="32"></circle>
        <circle class="doorstate-relock-progress" cx="37" cy="37" r="32"></circle>
      </svg>
      <span class="doorstate-relock-label"></span>
    `;
    thumb.append(indicator);
  }

  return { indicator, thumb };
}

function updateCountdown(host) {
  const attributes = host.stateObj?.attributes;
  if (!attributes || !("relock_at" in attributes)) {
    return;
  }

  const elements = ensureIndicator(host);
  if (!elements) {
    return;
  }

  const { indicator, thumb } = elements;
  const lockState = host.stateObj?.state;
  const relockAt = Date.parse(attributes.relock_at ?? "");
  const remaining = relockAt - Date.now();
  const maximumSeconds = Number(attributes.maximum_unlock_time);
  const duration = Number.isFinite(maximumSeconds) && maximumSeconds > 0
    ? maximumSeconds * 1000
    : 60_000;
  const active = ["unlocked", "unlocking"].includes(lockState)
    && Number.isFinite(relockAt)
    && remaining > 0;

  indicator.dataset.active = String(active);
  thumb.classList.toggle("doorstate-countdown-active", active);
  if (!active) {
    return;
  }

  const circumference = 2 * Math.PI * 32;
  const progress = Math.max(0, Math.min(1, remaining / duration));
  const circle = indicator.querySelector(".doorstate-relock-progress");
  circle.setAttribute("stroke-dasharray", String(circumference));
  circle.setAttribute("stroke-dashoffset", String(circumference * (1 - progress)));
  const label = indicator.querySelector(".doorstate-relock-label");
  const nextLabel = formatRemaining(remaining);
  if (label.textContent !== nextLabel) {
    label.textContent = nextLabel;
  }
}

function animateCountdowns() {
  for (const host of ACTIVE_DIALOGS) {
    if (!host.isConnected) {
      ACTIVE_DIALOGS.delete(host);
      continue;
    }
    updateCountdown(host);
  }

  animationFrame = ACTIVE_DIALOGS.size
    ? window.requestAnimationFrame(animateCountdowns)
    : undefined;
}

function startCountdown(host) {
  ACTIVE_DIALOGS.add(host);
  updateCountdown(host);
  if (animationFrame === undefined) {
    animationFrame = window.requestAnimationFrame(animateCountdowns);
  }
}

function stopCountdown(host) {
  ACTIVE_DIALOGS.delete(host);
  if (!ACTIVE_DIALOGS.size && animationFrame !== undefined) {
    window.cancelAnimationFrame(animationFrame);
    animationFrame = undefined;
  }
}

function findLockDialogs(root = document) {
  const dialogs = [];
  const walk = (node) => {
    if (!node?.querySelectorAll) {
      return;
    }
    dialogs.push(...node.querySelectorAll("more-info-lock"));
    for (const element of node.querySelectorAll("*")) {
      if (element.shadowRoot) {
        walk(element.shadowRoot);
      }
    }
  };
  walk(root);
  return dialogs;
}

customElements.whenDefined("more-info-lock").then(() => {
  const LockDialog = customElements.get("more-info-lock");
  const prototype = LockDialog.prototype;
  if (prototype[PATCH_FLAG]) {
    return;
  }
  prototype[PATCH_FLAG] = true;

  const originalConnectedCallback = prototype.connectedCallback;
  prototype.connectedCallback = function patchedConnectedCallback() {
    originalConnectedCallback?.call(this);
    startCountdown(this);
  };

  const originalUpdated = prototype.updated;
  prototype.updated = function patchedUpdated(changedProperties) {
    originalUpdated?.call(this, changedProperties);
    window.requestAnimationFrame(() => updateCountdown(this));
  };

  const originalDisconnectedCallback = prototype.disconnectedCallback;
  prototype.disconnectedCallback = function patchedDisconnectedCallback() {
    stopCountdown(this);
    originalDisconnectedCallback?.call(this);
  };

  for (const dialog of findLockDialogs()) {
    startCountdown(dialog);
  }
});
