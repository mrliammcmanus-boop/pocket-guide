(() => {
  "use strict";
  const base = new URL("./", location.href);
  const encoder = new TextEncoder();
  const iterations = 600000;

  function decode64(value, length) {
    if (typeof value !== "string") throw new Error("The app's encryption settings are invalid. Download it again.");
    const bytes = Uint8Array.from(atob(value), item => item.charCodeAt(0));
    if (bytes.length !== length) throw new Error("The app's encryption settings are invalid. Download it again.");
    return bytes;
  }

  async function metadata() {
    const response = await fetch(new URL("guide-meta.json", base), {cache:"no-cache"});
    if (!response.ok) throw new Error(`The guide settings could not be downloaded (${response.status}). Connect to the internet and try again.`);
    const meta = await response.json();
    if (meta.format !== 1 || meta.iterations !== iterations ||
        !/^[a-f0-9]{16}$/.test(meta.app_id) || !/^[a-f0-9]{64}$/.test(meta.sha256) ||
        !Number.isInteger(meta.bytes) || meta.bytes < 16 || meta.bytes > 25000000) {
      throw new Error("This guide uses invalid or unsupported encryption settings. Download it again.");
    }
    decode64(meta.salt, 16);
    decode64(meta.iv, 12);
    return Object.freeze(meta);
  }

  async function derive(passphrase, meta) {
    const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      {name:"PBKDF2", salt:decode64(meta.salt, 16), iterations, hash:"SHA-256"},
      material, {name:"AES-GCM", length:256}, false, ["decrypt"],
    );
  }

  async function decrypt(key, meta) {
    const response = await fetch(new URL("guide.bin", base), {cache:"no-cache"});
    if (!response.ok) throw new Error(`The encrypted guide could not be downloaded (${response.status}). Connect to the internet and try again.`);
    const bytes = await response.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = [...new Uint8Array(digest)].map(item => item.toString(16).padStart(2, "0")).join("");
    if (bytes.byteLength !== meta.bytes || hash !== meta.sha256) {
      throw new Error("The downloaded guide is incomplete or damaged. Check the offline download with an internet connection, then try again.");
    }
    const aad = encoder.encode(`private-guide:v1:${meta.app_id}:${meta.salt}:${iterations}`);
    const result = await crypto.subtle.decrypt(
      {name:"AES-GCM", iv:decode64(meta.iv, 12), additionalData:aad, tagLength:128},
      key, bytes,
    );
    return new TextDecoder("utf-8", {fatal:true}).decode(result);
  }

  async function database(meta, mode, operation) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(`private-guide-${meta.app_id}-${encodeURIComponent(base.pathname)}`, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("access");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Another tab is blocking saved access. Close that tab and try again."));
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction("access", mode);
        const request = operation(transaction.objectStore("access"));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error || new Error("Device storage did not complete the request."));
        transaction.onerror = () => reject(transaction.error || new Error("Device storage is unavailable."));
      });
    } finally {
      db.close();
    }
  }

  function forget(meta) {
    return database(meta, "readwrite", store => store.delete("key"));
  }

  async function recalled(meta) {
    const entry = await database(meta, "readonly", store => store.get("key"));
    if (!entry) return null;
    if (!Number.isFinite(entry.expires) || entry.expires <= Date.now()) {
      await forget(meta);
      return null;
    }
    if (!(entry.key instanceof CryptoKey) || entry.key.extractable ||
        entry.key.algorithm.name !== "AES-GCM" || !entry.key.usages.includes("decrypt")) {
      throw new Error("Saved access is invalid. Enter the passphrase and save access again.");
    }
    return entry.key;
  }

  function remember(meta, key) {
    if (key.extractable) throw new Error("The unlock key cannot be stored safely.");
    return database(meta, "readwrite", store => store.put({key, expires:Date.now() + 30 * 86400000}, "key"));
  }

  function openGuide(html, key, meta, warning = "") {
    window.__PRIVATE_GUIDE_SESSION__ = {key, meta, warning};
    document.open();
    document.write(html);
    document.close();
  }

  function controller() {
    const worker = navigator.serviceWorker.controller;
    return worker && worker.scriptURL === new URL("service-worker.js", base).href ? worker : null;
  }

  function waitForControl(registration) {
    if (controller()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const worker = registration.installing || registration.active;
      const timeout = setTimeout(() => finish(new Error("The offline download has not finished. Check your connection and retry.")), 120000);
      function changed() {
        if (controller()) finish();
        else if (worker?.state === "redundant") finish(new Error("The offline download failed. Check your connection and available storage, then retry."));
      }
      function finish(error) {
        clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener("controllerchange", changed);
        worker?.removeEventListener("statechange", changed);
        if (error) reject(error); else resolve();
      }
      navigator.serviceWorker.addEventListener("controllerchange", changed);
      worker?.addEventListener("statechange", changed);
      changed();
    });
  }

  function offlineState() {
    return new Promise((resolve, reject) => {
      const worker = controller();
      if (!worker) return reject(new Error("This page is not yet controlled by the offline app."));
      const channel = new MessageChannel();
      const timeout = setTimeout(() => {
        channel.port1.close();
        reject(new Error("The offline download could not be checked. Reopen the app and try again."));
      }, 15000);
      channel.port1.onmessage = event => {
        clearTimeout(timeout);
        channel.port1.close();
        const result = event.data;
        if (result?.type === "OFFLINE_STATE" && typeof result.ready === "boolean") resolve(result);
        else reject(new Error("The offline app returned an invalid download check."));
      };
      worker.postMessage({type:"CHECK_OFFLINE"}, [channel.port2]);
    });
  }

  function wireOffline(status, retry, update) {
    let registration;
    let watchedRegistration;
    let busy = false;
    let applying = false;
    function show(text, state) {
      status.textContent = text;
      status.dataset.state = state;
    }
    function showUpdate() {
      update.hidden = !registration?.waiting;
    }
    function watch() {
      showUpdate();
      if (watchedRegistration === registration) return;
      watchedRegistration = registration;
      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        installing?.addEventListener("statechange", async () => {
          showUpdate();
          if (installing.state === "redundant" && controller()) {
            try {
              const state = await offlineState();
              if (state.ready) show("Ready offline using the saved version. A newer version couldn't be downloaded; connect and check again.", "ready");
              else show("Not ready offline. A newer download failed and the saved copy is incomplete. Connect and repair the download.", "error");
            } catch (checkError) {
              show("The newer download failed and the saved copy couldn't be checked. Reopen the app with a connection.", "error");
              console.error("Checking the saved version after a failed update:", checkError);
            }
          }
        });
      });
    }
    async function check(manual = false) {
      if (busy) return;
      if (!window.isSecureContext || !("serviceWorker" in navigator)) {
        show("Offline access is unavailable here. Use a current browser and open the hosted HTTPS address, not a file in Downloads.", "error");
        retry.disabled = true;
        return;
      }
      busy = true;
      retry.disabled = true;
      show("Checking the offline download...", "loading");
      try {
        registration = await navigator.serviceWorker.register(new URL("service-worker.js", base), {scope:base.href, updateViaCache:"none"});
        watch();
        if (manual) await registration.update();
        await waitForControl(registration);
        const state = await offlineState();
        if (!state.ready) throw new Error("The offline copy is missing or damaged. Reconnect and use Repair offline download.");
        show("Ready offline. The guide, photos and walking maps are saved in this browser.", "ready");
        retry.textContent = "Check offline download";
        showUpdate();
        if (navigator.storage?.persist) {
          try {
            const persistent = await navigator.storage.persist();
            if (!persistent) status.textContent += " Your browser may still clear saved site data.";
          } catch (storageError) {
            status.textContent += " Persistent storage couldn't be granted; keep the PDF backup.";
            console.error("Requesting persistent offline storage failed:", storageError);
          }
        }
      } catch (error) {
        let verified = false;
        if (controller()) {
          try {
            verified = (await offlineState()).ready;
          } catch (checkError) {
            console.error("Offline-copy verification failed:", checkError);
          }
        }
        if (verified) {
          show("Ready offline. An update check failed; reconnect to check for a newer version.", "ready");
        } else {
          show(`Not ready offline. ${error.message}`, "error");
          retry.textContent = "Repair offline download";
        }
        console.error("Offline setup or update check failed:", error);
      } finally {
        busy = false;
        retry.disabled = false;
      }
    }
    retry.addEventListener("click", async () => {
      if (status.dataset.state === "error" && controller()) {
        retry.disabled = true;
        show("Repairing the offline download...", "loading");
        try {
          const channel = new MessageChannel();
          const result = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {channel.port1.close(); reject(new Error("The repair timed out. Check your connection and storage, then retry."));}, 120000);
            channel.port1.onmessage = event => {
              clearTimeout(timeout);
              channel.port1.close();
              resolve(event.data);
            };
            controller().postMessage({type:"REPAIR_OFFLINE"}, [channel.port2]);
          });
          if (!result?.ready) throw new Error(result?.error || "The offline copy could not be repaired.");
        } catch (error) {
          show(`Not ready offline. ${error.message}`, "error");
          console.error("Offline repair failed:", error);
          retry.disabled = false;
          return;
        }
      }
      check(true);
    });
    update.addEventListener("click", () => {
      if (!registration?.waiting) {
        show("The update is not ready yet. Check the download again.", "error");
        return;
      }
      applying = true;
      update.disabled = true;
      show("Applying the update. You may need to unlock the guide again.", "loading");
      registration.waiting.postMessage({type:"ACTIVATE_UPDATE"});
    });
    navigator.serviceWorker?.addEventListener("controllerchange", () => {
      if (applying) location.reload();
    });
    navigator.serviceWorker?.addEventListener("message", event => {
      if (event.data?.type === "DOWNLOAD_PROGRESS" && busy) {
        show(`Downloading for offline use (${event.data.done} of ${event.data.total} files)...`, "loading");
      }
    });
    window.addEventListener("online", () => check());
    check();
  }

  window.PrivateGuide = Object.freeze({base, metadata, derive, decrypt, recalled, remember, forget, openGuide, wireOffline});
})();
