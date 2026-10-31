(function () {
  "use strict";
  var booted = false, failed = false, started = false, saveRetrying = false;
  var SDK_URL = "https://connect.facebook.net/en_US/fbinstant.8.0.js";
  var canvas, screen, message, detail, progress, fill, retry, saveNotice, saveMessage, saveRetry;

  function isLocalPreview() {
    return true; // Standalone web release: never initialize the Facebook host SDK.
  }
  function script(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var tag = document.createElement("script"), done = false;
      var timer = setTimeout(function () { finish(new Error("SCRIPT_TIMEOUT")); }, timeoutMs);
      function finish(error) {
        if (done) return;
        done = true; clearTimeout(timer); tag.onload = tag.onerror = null;
        if (error) { tag.remove(); reject(error); } else resolve();
      }
      tag.src = url; tag.async = true;
      tag.onload = function () { finish(); };
      tag.onerror = function () { finish(new Error("SCRIPT_LOAD_FAILED")); };
      document.head.appendChild(tag);
    });
  }
  function reportProgress(value) {
    var fraction = Math.max(0, Math.min(1, Number(value) || 0));
    progress.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
    fill.style.width = Math.round(fraction * 100) + "%";
    if (window.XeoInstant) window.XeoInstant.setLoadingProgress(fraction);
  }
  function fatal(text, error, guidance) {
    if (failed) return;
    failed = true; screen.hidden = false; screen.classList.remove("is-complete");
    message.textContent = text || "Chưa mở được quán. Mình thử lại nhé!";
    detail.textContent = guidance || "Kiểm tra kết nối rồi nhấn Thử lại.";
    progress.hidden = true; retry.hidden = false; saveNotice.hidden = true;
    if (error) console.error("Xeo Xeo Quan startup:", error);
  }
  function platformState(state) {
    if (!state || !started || failed) return;
    if (state.state === "error" && state.canRetry === false) {
      fatal(state.message || "Phiên chơi đã thay đổi. Mở lại quán nhé!", null,
        "Mở lại game để nhận đúng tiến trình của bạn.");
      return;
    }
    var saveFailed = state.saveState === "error" || state.saveState === "memory";
    saveNotice.hidden = !saveFailed;
    saveRetry.hidden = state.canRetry === false;
    if (saveFailed) saveMessage.textContent = state.saveState === "memory"
      ? "Chưa lưu được trên thiết bị này. Đóng cửa sổ sẽ mất tiến trình mới."
      : state.message || "Chưa lưu được tiến trình. Bạn vẫn có thể chơi tiếp.";
  }
  function complete() {
    if (failed) return;
    started = true; reportProgress(1); screen.classList.add("is-complete");
    setTimeout(function () { if (!failed) screen.hidden = true; }, 340);
    if (window.XeoInstant.getState) platformState(window.XeoInstant.getState());
    canvas.focus({ preventScroll: true });
  }
  async function boot() {
    if (booted) return;
    booted = true;
    canvas = document.getElementById("unity-canvas"); screen = document.getElementById("loading-screen");
    message = document.getElementById("loading-message"); detail = document.getElementById("loading-detail");
    progress = document.getElementById("loading-progress"); fill = document.getElementById("loading-fill"); retry = document.getElementById("loading-retry");
    saveNotice = document.getElementById("save-notice"); saveMessage = document.getElementById("save-message"); saveRetry = document.getElementById("save-retry");
    retry.addEventListener("click", function () { retry.disabled = true; window.location.reload(); });
    saveRetry.addEventListener("click", async function () {
      if (saveRetrying || !window.XeoInstant) return;
      saveRetrying = true; saveRetry.disabled = true;
      try { await window.XeoInstant.requestRetry(); }
      catch (error) { console.warn("Xeo Xeo Quan save retry:", error); }
      finally { saveRetrying = false; saveRetry.disabled = false; platformState(window.XeoInstant.getState()); }
    });
    canvas.addEventListener("webglcontextlost", function () {
      fatal("Hình ảnh vừa bị gián đoạn. Mở lại quán nhé!");
    });
    try {
      if (!isLocalPreview() && !window.FBInstant) await script(SDK_URL, 20000);
      await script("instant-platform.js", 15000);
      if (!window.XeoInstant) throw new Error("PLATFORM_BRIDGE_MISSING");
      window.XeoInstant.subscribe(platformState);
      message.textContent = "Đang nhận tiến trình của bạn…";
      await window.XeoInstant.initialize();
      if (failed) return;
      message.textContent = "Đang dọn đồ lên quán…";
      await script(window.XEO_UNITY_LOADER, 30000);
      if (typeof window.createUnityInstance !== "function") throw new Error("UNITY_LOADER_MISSING");
      var config = Object.assign({}, window.XEO_UNITY_CONFIG);
      config.showBanner = function (text, type) {
        if (type === "error") fatal("Quán chưa tải xong. Mình thử lại nhé!", text);
        else console.warn("Unity:", text);
      };
      var unity = await window.createUnityInstance(canvas, config, reportProgress);
      if (failed) return;
      message.textContent = "Quán sẵn sàng rồi…";
      await window.XeoInstant.start(unity);
      complete();
    } catch (error) { fatal("Chưa mở được quán. Mình thử lại nhé!", error); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
