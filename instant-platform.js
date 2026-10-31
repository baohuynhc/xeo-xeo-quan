/* Original Xèo Xèo Quán platform bridge. The Meta SDK is loaded by index.html. */
(function (global) {
  'use strict';
  var CLOUD_KEY = 'xeo-xeo-quan-unity-v1';
  var CLOUD_TEXT_PREFIX = 'xxq-unity-v1:';
  var CLOUD_RESET_PREFIX = 'xxq-unity-v2:';
  var RESET_PREFIX = 'XeoXeo.Instant.reset.v1:';
  var CACHE_PREFIX = 'XeoXeo.Instant.cache.v1:';
  var PREVIEW_KEY = 'XeoXeo.Web.progress.v1';
  var SAVE_DELAY = 1200;
  var RETRY_DELAYS = [1500, 3000, 6000, 12000, 20000];
  var state = { state: 'idle', mode: null, message: '', canRetry: false, saveState: 'saved', persistentLocal: true, resetState: 'idle' };
  var listeners = [], sdk = null, sdkInitialized = false, initialized = false, started = false;
  var initializePromise = null, startPromise = null, sdkInitOperation = null, sdkStartOperation = null, unity = null, receiver = 'XeoXeoGame';
  var playerId = null, cacheKey = null, progressJson = '', acknowledged = '', pending = null;
  var writingJson = null, attempted = [];
  var generation = null, resetting = false, resetPromise = null, resetIntent = null, resetKey = null;
  var slowSave = false;
  var flight = null, saveTimer = null, retryTimer = null, retryAttempt = 0, identityChanged = false;
  var unityReady = false, readyWaiters = [], pausePending = false, pauseBound = false;

  function emit(patch) {
    Object.assign(state, patch || {});
    var snapshot = Object.assign({}, state);
    listeners.slice().forEach(function (listener) { try { listener(snapshot); } catch (_) {} });
  }
  function failure(message) { return new Error(message); }
  function bounded(operation, message) {
    return new Promise(function (resolve, reject) {
      var timer = global.setTimeout(function () { reject(failure(message)); }, 20000);
      Promise.resolve(operation).then(function (value) { global.clearTimeout(timer); resolve(value); }, function (error) { global.clearTimeout(timer); reject(error); });
    });
  }
  function isPreview() {
    return true; // This release stores progress locally, independently of Facebook.
  }
  function storageRead(key) {
    try { return global.localStorage.getItem(key); }
    catch (_) { emit({ persistentLocal: false }); return null; }
  }
  function storageWrite(key, value) {
    try { global.localStorage.setItem(key, value); return true; }
    catch (_) { emit({ persistentLocal: false }); return false; }
  }
  function storageRemove(key) {
    try { global.localStorage.removeItem(key); return true; }
    catch (_) { emit({ persistentLocal: false }); return false; }
  }
  function validateProgress(value) {
    var json = typeof value === 'string' ? value : JSON.stringify(value);
    if (typeof json === 'string' && json.indexOf(CLOUD_TEXT_PREFIX) === 0) json = json.slice(CLOUD_TEXT_PREFIX.length);
    var parsed;
    try { parsed = JSON.parse(json); } catch (_) { throw failure('Dữ liệu quán chưa đọc được. Vui lòng thử lại; tiến trình chưa bị thay đổi.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw failure('Dữ liệu quán không hợp lệ. Tiến trình chưa bị thay đổi.');
    var numeric = ['day', 'coins', 'best', 'stove', 'tips', 'patience', 'plates', 'burners', 'coating'];
    numeric.forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(parsed, key) && (typeof parsed[key] !== 'number' || !Number.isFinite(parsed[key]) || !Number.isInteger(parsed[key])))
        throw failure('Dữ liệu quán không hợp lệ. Tiến trình chưa bị thay đổi.');
    });
    if (Object.prototype.hasOwnProperty.call(parsed, 'shopName') && parsed.shopName !== null && typeof parsed.shopName !== 'string')
      throw failure('Tên quán trong dữ liệu chưa đọc được. Tiến trình chưa bị thay đổi.');
    // Preserve the original JSON text: Unity uses an Int64 day counter.
    return json;
  }
  // The generation survives every new save after a reset. A legacy cache can never
  // resurrect an old quán merely because a new game's default JSON looks identical.
  function unpackCloud(value) {
    if (typeof value === 'string' && value.indexOf(CLOUD_RESET_PREFIX) === 0) {
      var record;
      try { record = JSON.parse(value.slice(CLOUD_RESET_PREFIX.length)); } catch (_) {}
      if (!record || record.version !== 2 || typeof record.generation !== 'string' || !/^reset-[a-zA-Z0-9-]{8,120}$/.test(record.generation) || (record.progress !== null && typeof record.progress !== 'string'))
        throw failure('Dữ liệu quán chưa đọc được. Tiến trình chưa bị thay đổi.');
      return { generation: record.generation, json: record.progress === null ? '' : validateProgress(record.progress) };
    }
    return { generation: null, json: validateProgress(value) };
  }
  function packCloud(json) {
    return generation === null ? CLOUD_TEXT_PREFIX + json : CLOUD_RESET_PREFIX + JSON.stringify({ version: 2, generation: generation, progress: json });
  }
  function newGeneration() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return 'reset-' + global.crypto.randomUUID();
    return 'reset-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
  }
  function readResetIntent() {
    var value;
    try { value = JSON.parse(storageRead(resetKey) || 'null'); } catch (_) {}
    return value && value.version === 1 && value.playerId === playerId && typeof value.generation === 'string' && /^reset-[a-zA-Z0-9-]{8,120}$/.test(value.generation) && (value.baselineGeneration === null || typeof value.baselineGeneration === 'string') ? value : null;
  }
  function resetStatus(name, message, canRetry) {
    emit({ resetState: name, message: message || '', canRetry: !!canRetry });
    send('OnInstantResetState', JSON.stringify({ state: name, message: message || '', canRetry: !!canRetry }));
  }
  function finishResetLocally() {
    progressJson = ''; acknowledged = ''; pending = null; writingJson = null; attempted = [];
    clearSaveTimer(); clearRetryTimer(); retryAttempt = 0;
    var cacheRemoved = storageRemove(cacheKey), intentRemoved = storageRemove(resetKey);
    return cacheRemoved && intentRemoved;
  }
  function performReset(intent) {
    if (resetPromise) return resetPromise;
    resetIntent = intent; resetting = true;
    clearSaveTimer(); clearRetryTimer(); pending = null;
    // Persist only the deletion intent, never old progress in this journal.
    if (state.mode === 'facebook') { storageWrite(resetKey, JSON.stringify(intent)); storageRemove(cacheKey); }
    resetStatus('waiting', 'Đang chờ lượt lưu trước kết thúc…', false);
    send('OnInstantPause');
    var previousFlight = flight;
    resetPromise = Promise.resolve().then(async function () {
      var watchdog = global.setTimeout(function () {
        resetStatus('waiting', 'Facebook vẫn đang xử lý. Chưa xác nhận xóa; vui lòng giữ game mở.', false);
      }, 20000);
      var localCleaned = true;
      try {
        // A stalled SDK write remains the same flight. Never race it with reset.
        if (previousFlight) await previousFlight;
        if (state.mode === 'preview') {
          if (!storageRemove(PREVIEW_KEY)) throw failure('Trình duyệt chưa cho phép xóa bản lưu trên máy. Hãy kiểm tra quyền lưu trữ rồi thử lại.');
          progressJson = ''; acknowledged = ''; pending = null; writingJson = null; attempted = [];
        } else {
          assertIdentity();
          resetStatus('deleting', 'Đang xóa tiến trình trên Facebook…', false);
          var payload = {}; payload[CLOUD_KEY] = CLOUD_RESET_PREFIX + JSON.stringify({ version: 2, generation: intent.generation, progress: null });
          await sdk.player.setDataAsync(payload);
          assertIdentity();
          await sdk.player.flushDataAsync();
          assertIdentity();
          generation = intent.generation;
          localCleaned = finishResetLocally();
        }
        emit({ saveState: 'saved' });
        resetStatus('complete', localCleaned ? 'Đã xóa tiến trình. Quán mới sẽ bắt đầu từ ngày 1.' : 'Đã xóa tiến trình trên Facebook. Trình duyệt đang chặn dọn bản lưu cục bộ; hãy xóa dữ liệu trang trong cài đặt trình duyệt.', false);
        return true;
      } catch (error) {
        resetStatus('failed', identityChanged ? state.message : error.message || 'Chưa xóa được tiến trình. Hãy thử lại khi có kết nối.', !identityChanged);
        return false;
      } finally { global.clearTimeout(watchdog); }
    }).finally(function () { resetPromise = null; });
    return resetPromise;
  }
  function resetProgress() {
    if (!initialized || !started || identityChanged) return Promise.resolve(false);
    if (state.resetState === 'complete') return Promise.resolve(true);
    if (resetPromise) return resetPromise;
    try { assertIdentity(); } catch (_) { return Promise.resolve(false); }
    var intent = resetIntent || { version: 1, playerId: playerId, generation: newGeneration(), baselineGeneration: generation };
    return performReset(intent);
  }
  function cachePending() {
    if (!cacheKey || resetting) return;
    storageWrite(cacheKey, JSON.stringify({ version: 1, playerId: playerId, generation: generation, acknowledged: acknowledged, pending: pending !== null ? pending : writingJson, attempted: attempted.slice() }));
  }
  function send(method, argument) {
    if (!unity || !unityReady) return;
    try { if (argument === undefined) unity.SendMessage(receiver, method); else unity.SendMessage(receiver, method, argument); } catch (_) {}
  }
  function assertIdentity() {
    if (state.mode !== 'facebook') return;
    if (identityChanged || String(sdk.player.getID() || '') !== playerId) {
      identityChanged = true;
      emit({ state: 'error', canRetry: false, saveState: 'error', message: 'Tài khoản Facebook đã đổi. Hãy mở lại game để tải đúng quán.' });
      send('OnInstantPause');
      throw failure(state.message);
    }
  }
  function clearSaveTimer() { if (saveTimer !== null) global.clearTimeout(saveTimer); saveTimer = null; }
  function clearRetryTimer() { if (retryTimer !== null) global.clearTimeout(retryTimer); retryTimer = null; }
  function scheduleSave() {
    if (resetting || !started || flight || saveTimer !== null || retryTimer !== null || retryAttempt >= RETRY_DELAYS.length) return;
    saveTimer = global.setTimeout(function () { saveTimer = null; flush(); }, SAVE_DELAY);
  }
  function scheduleRetry() {
    if (resetting || identityChanged || retryTimer !== null || retryAttempt >= RETRY_DELAYS.length) return;
    var delay = RETRY_DELAYS[retryAttempt++];
    retryTimer = global.setTimeout(function () { retryTimer = null; flush(); }, delay);
  }
  function pause() {
    pausePending = true;
    send('OnInstantPause');
    flush();
  }
  async function initialize() {
    if (initialized) return Object.assign({}, state);
    if (initializePromise) return initializePromise;
    initializePromise = (async function () {
      emit({ state: 'initializing', message: 'Đang mở quán…', canRetry: false });
      try {
        if (isPreview()) {
          playerId = 'local-preview'; cacheKey = PREVIEW_KEY;
          emit({ mode: 'preview' });
          var local = storageRead(PREVIEW_KEY);
          progressJson = local ? validateProgress(local) : '';
          acknowledged = progressJson;
          emit({ saveState: state.persistentLocal ? 'saved' : 'memory' });
        } else {
          sdk = global.FBInstant;
          if (!sdk || typeof sdk.initializeAsync !== 'function' || !sdk.player) throw failure('Chưa kết nối được Facebook Instant. Vui lòng mở game từ Facebook hoặc thử lại.');
          if (!sdkInitialized) {
            if (!sdkInitOperation) sdkInitOperation = Promise.resolve().then(function () { return sdk.initializeAsync(); }).catch(function (error) { sdkInitOperation = null; throw error; });
            await bounded(sdkInitOperation, 'Facebook chưa phản hồi. Hãy thử mở lại quán.'); sdkInitialized = true;
          }
          if (typeof sdk.player.getID !== 'function' || typeof sdk.player.getDataAsync !== 'function' || typeof sdk.player.setDataAsync !== 'function' || typeof sdk.player.flushDataAsync !== 'function') throw failure('Facebook chưa cung cấp kết nối lưu quán. Vui lòng thử lại.');
          playerId = String(sdk.player.getID() || '');
          if (!playerId) throw failure('Chưa xác định được người chơi Facebook. Vui lòng mở lại game.');
          cacheKey = CACHE_PREFIX + encodeURIComponent(playerId); resetKey = RESET_PREFIX + encodeURIComponent(playerId);
          emit({ mode: 'facebook', message: 'Đang tải quán của bạn…' });
          var data;
          try { data = await bounded(sdk.player.getDataAsync([CLOUD_KEY]), 'Chưa tải được tiến trình Facebook. Vui lòng thử lại.'); }
          catch (_) { throw failure('Chưa tải được tiến trình Facebook. Hãy thử lại; game chưa tạo hay ghi đè quán.'); }
          assertIdentity();
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('Facebook chưa trả về dữ liệu quán hợp lệ. Vui lòng thử lại.');
          var exists = Object.prototype.hasOwnProperty.call(data, CLOUD_KEY);
          var cloud = exists ? unpackCloud(data[CLOUD_KEY]) : { generation: null, json: '' };
          generation = cloud.generation; progressJson = cloud.json; acknowledged = progressJson;
          var deletion = readResetIntent() || (resetIntent && resetIntent.playerId === playerId ? resetIntent : null);
          if (deletion) {
            if (generation === deletion.generation && progressJson !== '' || generation !== deletion.generation && generation !== deletion.baselineGeneration) {
              // A completed/obsolete request must not erase subsequent fresh play.
              storageRemove(resetKey); resetting = false; resetIntent = null; emit({ resetState: 'idle', message: '' });
            } else {
              if (!await performReset(deletion)) throw failure(state.message || 'Chưa hoàn tất yêu cầu xóa tiến trình. Vui lòng thử lại.');
              resetting = false; resetIntent = null; emit({ resetState: 'idle', message: '' });
            }
          }
          // Recover only against this player's acknowledged baseline or an exact write we submitted.
          // setData can reach the cloud before flush confirms it; the latest local snapshot must survive that window.
          var cache = null;
          try { cache = JSON.parse(storageRead(cacheKey) || 'null'); } catch (_) {}
          pending = null; writingJson = null; attempted = [];
          if (cache && cache.version === 1 && cache.playerId === playerId && (cache.generation || null) === generation && typeof cache.pending === 'string') {
            var knownWrite = Array.isArray(cache.attempted) && cache.attempted.slice(-32).some(function (snapshot) { return typeof snapshot === 'string' && snapshot === acknowledged; });
            if (cache.acknowledged === acknowledged || knownWrite) {
              try { pending = validateProgress(cache.pending); progressJson = pending; } catch (_) { pending = null; }
            }
          }
          cachePending();
          if (!pauseBound && typeof sdk.onPause === 'function') { sdk.onPause(pause); pauseBound = true; }
        }
        initialized = true;
        emit({ state: 'ready', message: 'Đang dọn quầy bánh…', canRetry: false, saveState: pending !== null ? 'pending' : state.saveState });
        return Object.assign({}, state);
      } catch (error) {
        emit({ state: 'error', message: error.message || 'Chưa mở được quán. Vui lòng thử lại.', canRetry: !identityChanged });
        throw error;
      }
    })().finally(function () { initializePromise = null; });
    return initializePromise;
  }
  function markUnityReady(name) {
    if (name) receiver = name;
    unityReady = true;
    readyWaiters.splice(0).forEach(function (waiter) { waiter.resolve(); });
  }
  function reportFatal(message) {
    started = false; initialized = false;
    clearSaveTimer(); clearRetryTimer(); pending = null;
    var error = failure(message || 'Game chưa đọc được quán. Vui lòng tải lại.');
    emit({ state: 'error', message: error.message, canRetry: false });
    readyWaiters.splice(0).forEach(function (waiter) { waiter.reject(error); });
  }
  async function start(instance) {
    if (started) return Object.assign({}, state);
    if (startPromise) return startPromise;
    if (!initialized) throw failure('Quán chưa tải xong tiến trình.');
    unity = instance;
    startPromise = (async function () {
      try {
        if (!unityReady) await bounded(new Promise(function (resolve, reject) { readyWaiters.push({ resolve: resolve, reject: reject }); }), 'Quầy bánh chưa tải xong. Vui lòng mở lại game.');
        emit({ state: 'starting', message: 'Quán đã sẵn sàng…', canRetry: false });
        if (state.mode === 'facebook') {
          assertIdentity(); sdk.setLoadingProgress(100);
          if (!sdkStartOperation) sdkStartOperation = Promise.resolve().then(function () { return sdk.startGameAsync(); }).catch(function (error) { sdkStartOperation = null; throw error; });
          await bounded(sdkStartOperation, 'Facebook chưa mở được game. Vui lòng thử lại.'); assertIdentity();
        }
        started = true;
        emit({ state: 'started', message: '', canRetry: false });
        send('OnInstantStarted');
        if (pausePending || global.document && global.document.hidden) send('OnInstantPause');
        if (pending !== null) scheduleSave();
        return Object.assign({}, state);
      } catch (error) {
        emit({ state: 'error', message: error.message || 'Facebook chưa mở được game. Vui lòng thử lại.', canRetry: !identityChanged });
        throw error;
      }
    })().finally(function () { startPromise = null; });
    return startPromise;
  }
  function saveProgress(json) {
    if (!initialized || identityChanged || resetting) return false;
    try {
      assertIdentity(); json = validateProgress(json);
      progressJson = json;
      if (state.mode === 'preview') {
        var stored = storageWrite(PREVIEW_KEY, json); acknowledged = json;
        emit({ saveState: stored ? 'saved' : 'memory', message: stored ? '' : 'Bản xem thử chỉ giữ quán trong lần mở này.' });
        return true;
      }
      if (json === acknowledged && pending === null && !flight) return true;
      pending = json; cachePending();
      emit({ saveState: slowSave ? 'error' : flight ? 'saving' : 'pending', message: slowSave ? 'Facebook đang lưu chậm. Quán đang giữ tiến trình và tiếp tục chờ xác nhận.' : '', canRetry: false });
      scheduleSave(); return true;
    } catch (error) {
      emit({ saveState: 'error', message: error.message, canRetry: !identityChanged });
      return false;
    }
  }
  function flush() {
    clearSaveTimer();
    if (!initialized || !started || identityChanged || resetting) return Promise.resolve(false);
    if (state.mode === 'preview') return Promise.resolve(true);
    if (flight) return flight;
    if (pending === null) return Promise.resolve(true);
    clearRetryTimer();
    flight = (async function () {
      while (pending !== null) {
        var writing = pending; pending = null; writingJson = writing;
        emit({ saveState: 'saving', message: '', canRetry: false });
        var watchdog = global.setTimeout(function () {
          slowSave = true;
          if (resetting) return;
          emit({ saveState: 'error', canRetry: false, message: 'Facebook đang lưu chậm. Quán đang giữ tiến trình và tiếp tục chờ xác nhận.' });
        }, 20000);
        try {
          assertIdentity();
          if (attempted.indexOf(writing) < 0) attempted.push(writing);
          if (attempted.length > 32) attempted = attempted.slice(-32);
          cachePending();
          var payload = {}; payload[CLOUD_KEY] = packCloud(writing);
          await sdk.player.setDataAsync(payload);
          assertIdentity();
          await sdk.player.flushDataAsync();
          assertIdentity();
          acknowledged = writing; writingJson = null; attempted = []; retryAttempt = 0;
          cachePending();
        } catch (error) {
          if (resetting) return false;
          if (pending === null) pending = writing;
          cachePending();
          emit({ saveState: 'error', message: identityChanged ? state.message : 'Chưa lưu lên Facebook. Quán đang được giữ để thử lại.', canRetry: !identityChanged });
          scheduleRetry(); return false;
        } finally { global.clearTimeout(watchdog); slowSave = false; writingJson = null; }
      }
      if (!resetting) emit({ saveState: 'saved', message: '', canRetry: false });
      return true;
    })().finally(function () { flight = null; });
    return flight;
  }
  function requestRetry() {
    if (identityChanged) return Promise.reject(failure(state.message));
    if (!initialized) return initialize();
    if (resetting) return resetProgress();
    if (!started && unity) return start(unity);
    retryAttempt = 0; clearRetryTimer(); return flush();
  }
  global.XeoInstant = {
    initialize: initialize, start: start, markUnityReady: markUnityReady, reportFatal: reportFatal,
    setLoadingProgress: function (fraction) { if (initialized && state.mode === 'facebook' && !started) sdk.setLoadingProgress(Math.round(Math.max(0, Math.min(1, Number(fraction) || 0)) * 100)); },
    getProgressJson: function () { if (!initialized) throw failure('Tiến trình Facebook chưa tải xong.'); return progressJson; },
    saveProgress: saveProgress, flush: flush, requestRetry: requestRetry, resetProgress: resetProgress,
    isStarted: function () { return started && !identityChanged && !resetting; },
    getState: function () { return Object.assign({}, state); },
    subscribe: function (listener) { listeners.push(listener); listener(Object.assign({}, state)); return function () { listeners = listeners.filter(function (value) { return value !== listener; }); }; }
  };
  if (global.addEventListener) {
    global.addEventListener('pagehide', pause);
    global.addEventListener('online', function () { if (initialized && pending !== null && !identityChanged && !resetting) { retryAttempt = 0; flush(); } });
  }
  if (global.document && global.document.addEventListener) global.document.addEventListener('visibilitychange', function () { if (global.document.hidden) pause(); });
})(window);
