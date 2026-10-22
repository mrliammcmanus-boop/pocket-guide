(() => {
  "use strict";
  const byId = id => document.getElementById(id);
  const trip = JSON.parse(byId("trip-model").textContent);
  const visits = new Map(trip.visits.map(visit => [visit.id, visit]));
  const days = new Set(trip.days.map(day => day.bookmark));
  const session = window.__PRIVATE_GUIDE_SESSION__;
  const savedTiming = new Map([...document.querySelectorAll("[data-visit-id]")].map(node =>
    [node.dataset.visitId, node.querySelector(".stop-timing").textContent]));
  let activeDay = trip.days[0].bookmark;
  let vault, busy = 0, selectedVisit, preparedBackup, backupURL, importFile, preview, viewingPhoto;
  let renderVersion = 0, toastTimer;
  const thumbnailURLs = new Map();
  const pendingThumbnails = new Map();
  let viewerURL;

  function toast(text) {
    const node = byId("app-toast");
    node.textContent = text;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 6000);
  }
  function problem(error, context) {
    byId("memory-warning").hidden = false;
    byId("memory-warning-text").textContent = `${context} ${error.name === "QuotaExceededError" ?
      "Device storage is full or blocked. Nothing from that action was saved. Free space, keep your photo original and retry." : error.message}`;
    byId("memory-retry").hidden = Boolean(vault);
    byId("memory-recovery").hidden = error.code !== "MEMORY_PASSPHRASE";
    if (byId("photo-viewer").open) byId("photo-viewer-status").textContent = `${context} ${error.message}`;
    else toast(`${context} See the warning at the top of the page.`);
    console.error(context, error.name, error.code || "");
  }
  function controls() {
    for (const button of document.querySelectorAll("[data-done], [data-photo-add], [data-skip], #export-memories, #import-backup")) {
      button.disabled = !vault || busy > 0;
    }
    byId("merge-backup").disabled = busy > 0 || Boolean(preview?.summary.removals && !byId("import-delete-confirm").checked);
    byId("lock-guide")?.setAttribute("aria-busy", String(busy > 0));
  }
  async function action(callback, context) {
    busy++;
    controls();
    try {
      const result = await callback();
      byId("memory-warning").hidden = true;
      return result;
    } catch (error) { problem(error, context); return null; }
    finally { busy--; controls(); }
  }
  function route() {
    let hash;
    byId("guide-notice").hidden = true;
    try { hash = decodeURIComponent(location.hash.slice(1)); } catch (error) {
      byId("guide-notice").textContent = "That link is malformed. Choose a day or find the place in Places.";
      byId("guide-notice").hidden = false;
      hash = "";
    }
    let target = hash ? byId(hash) : null;
    if (hash === "main") {
      byId("main").focus({preventScroll:true});
      return;
    }
    if (!target) {
      const date = new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Singapore", year:"numeric", month:"2-digit", day:"2-digit"}).format(new Date());
      const today = trip.days.find(day => day.date === date);
      target = byId(today?.bookmark || activeDay);
    }
    const section = target.closest("[data-view]") || target.querySelector("[data-view]");
    const view = section?.dataset.view || activeDay;
    if (days.has(view)) activeDay = view;
    for (const node of document.querySelectorAll("section[data-view]")) node.hidden = node.dataset.view !== view;
    document.body.dataset.activeView = view;
    for (const link of document.querySelectorAll("[data-day-link]")) {
      if (link.dataset.dayLink === activeDay && days.has(view)) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    const tab = days.has(view) ? "plan" : view === "directory" ? "directory" : view === "photos" ? "photos" : "info";
    for (const link of document.querySelectorAll("[data-tab]")) {
      if (link.dataset.tab === tab) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
      if (link.dataset.tab === "plan") link.href = "#" + activeDay;
    }
    for (const link of document.querySelectorAll("[data-open-plan]")) link.href = "#" + activeDay;
    let parent = target;
    while (parent && parent !== document.body) {
      if (parent.tagName === "DETAILS") parent.open = true;
      parent = parent.parentElement;
    }
    const visit = target.closest("[data-visit-id]");
    if (visit) visit.querySelector(".stop-details").open = true;
    if (target.tagName === "DETAILS") target.open = true;
    if (hash) requestAnimationFrame(() => target.scrollIntoView({block:"start"}));
    if (vault) renderMemories().catch(error => problem(error, "Saved photos could not be displayed."));
  }
  window.addEventListener("hashchange", route);
  document.addEventListener("click", event => {
    const link = event.target.closest('a[href^="#"]');
    if (link && link.hash === location.hash) { event.preventDefault(); route(); }
  });
  byId("go-today").addEventListener("click", () => {
    const date = new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Singapore", year:"numeric", month:"2-digit", day:"2-digit"}).format(new Date());
    location.hash = trip.days.find(day => day.date === date)?.bookmark || trip.days[0].bookmark;
  });
  route();

  function normalise(text) { return text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, ""); }
  function filterPlaces() {
    const query = normalise(byId("place-search").value);
    const day = byId("place-day").value, role = byId("place-role").value;
    let count = 0;
    for (const node of document.querySelectorAll("[data-directory-place]")) {
      const matches = normalise(node.dataset.search).includes(query) &&
        (day === "all" || node.dataset.day === day) &&
        (role === "all" || (role === "options" ? ["option", "alternative"].includes(node.dataset.role) : node.dataset.role === role));
      node.hidden = !matches;
      if (matches) count++;
    }
    for (const group of document.querySelectorAll(".directory-group")) {
      group.hidden = !group.querySelector("[data-directory-place]:not([hidden])");
    }
    byId("place-count").textContent = `${count} ${count === 1 ? "place" : "places"} shown`;
    byId("place-empty").hidden = count !== 0;
    byId("reset-filters").hidden = !query && day === "all" && role === "all";
  }
  for (const id of ["place-search", "place-day", "place-role"]) byId(id).addEventListener("input", filterPlaces);
  function resetPlaces() { byId("place-search").value = ""; byId("place-day").value = byId("place-role").value = "all"; filterPlaces(); }
  byId("reset-filters").addEventListener("click", resetPlaces);
  byId("empty-reset").addEventListener("click", resetPlaces);

  function invalidateBackup() {
    if (!preparedBackup) return;
    preparedBackup = null;
    if (backupURL) URL.revokeObjectURL(backupURL);
    backupURL = null;
    byId("share-backup").hidden = byId("download-backup").hidden = true;
    byId("backup-status").textContent = "Memories changed. Prepare a fresh backup to include them.";
  }
  async function thumbnail(id) {
    if (thumbnailURLs.has(id)) return thumbnailURLs.get(id);
    if (pendingThumbnails.has(id)) return pendingThumbnails.get(id);
    const promise = (async () => {
      const blob = await vault.photoBlob(id);
      const source = URL.createObjectURL(blob);
      const image = new Image();
      try {
        image.src = source;
        await image.decode();
        const scale = Math.min(1, 300 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext("2d", {alpha:false});
        if (!context) throw new Error("A photo preview could not be created. Close other tabs and reopen Photos.");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const small = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.8));
        canvas.width = canvas.height = 1;
        if (!small) throw new Error("A photo preview could not be saved in memory.");
        const url = URL.createObjectURL(small);
        thumbnailURLs.set(id, url);
        return url;
      } finally { image.src = ""; URL.revokeObjectURL(source); }
    })();
    pendingThumbnails.set(id, promise);
    try { return await promise; } finally { pendingThumbnails.delete(id); }
  }
  function photoButton(photo, gallery) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = gallery ? "" : "photo-thumb";
    button.dataset.openPhoto = photo.id;
    const name = visits.get(photo.visitId).name;
    button.setAttribute("aria-label", `Open your photo at ${name}`);
    const image = document.createElement("img");
    image.alt = `Your photo at ${name}`;
    image.width = image.height = gallery ? 300 : 72;
    button.append(image);
    return button;
  }
  async function renderMemories() {
    const generation = ++renderVersion;
    const photos = vault.photos();
    const live = new Set(photos.map(photo => photo.id));
    for (const [id, url] of thumbnailURLs) if (!live.has(id)) { URL.revokeObjectURL(url); thumbnailURLs.delete(id); }
    for (const node of document.querySelectorAll("[data-visit-id]")) {
      const id = node.dataset.visitId, status = vault.status(id);
      node.dataset.status = status;
      const button = node.querySelector("[data-done]");
      if (!button) continue;
      button.setAttribute("aria-pressed", String(status === "done"));
      button.setAttribute("aria-label", `${status === "done" ? "Undo" : "Mark"} ${visits.get(id).name}${status === "done" ? " completion" : " done"}`);
      button.querySelector("span").textContent = status === "done" ? "Undo" : "Done";
      node.querySelector(".stop-timing").textContent = status === "done" ? "Done · saved on this phone" :
        status === "skipped" ? "Skipped · restore below if wanted" : savedTiming.get(id);
      const skip = node.querySelector("[data-skip]");
      skip.hidden = node.dataset.main !== "true";
      skip.textContent = status === "skipped" ? "Restore this stop" : "Skip this stop";
    }
    for (const day of trip.days) {
      const planned = trip.visits.filter(visit => visit.day === day.bookmark && visit.role === "planned" && visit.kind === "visit");
      const done = planned.filter(visit => vault.status(visit.id) === "done").length;
      const skipped = planned.filter(visit => vault.status(visit.id) === "skipped").length;
      document.querySelector(`[data-progress="${day.bookmark}"]`).textContent =
        `${done} / ${planned.length - skipped} planned done${skipped ? ` · ${skipped} skipped` : ""}`;
    }
    byId("photo-count").textContent = `${photos.length} ${photos.length === 1 ? "photo" : "photos"} saved on this device`;
    byId("photo-empty").hidden = photos.length !== 0;
    byId("memory-storage").textContent = `${photos.length} photos · ${(vault.size() / 1024 / 1024).toFixed(1)} MB of the app's 100 MB photo limit. Stored encrypted on this phone.`;
    const activeView = document.body.dataset.activeView;
    const imageTasks = [];
    for (const node of document.querySelectorAll("[data-stop-photos]")) {
      const id = node.dataset.stopPhotos;
      if (visits.get(id).day !== activeView) continue;
      node.replaceChildren();
      const saved = photos.filter(photo => photo.visitId === id);
      for (const photo of saved.slice(0, 4)) {
        const button = photoButton(photo, false);
        node.append(button);
        imageTasks.push({id:photo.id, image:button.firstChild});
      }
      if (saved.length > 4) {
        const link = document.createElement("a");
        link.href = "#memories";
        link.textContent = `See all ${saved.length} photos`;
        node.append(link);
      }
    }
    if (activeView === "photos") {
      const gallery = byId("memory-gallery");
      gallery.replaceChildren();
      for (const photo of photos) {
        const figure = document.createElement("figure");
        figure.className = "memory-card";
        const button = photoButton(photo, true);
        const caption = document.createElement("figcaption");
        caption.textContent = visits.get(photo.visitId).name;
        const link = document.createElement("a");
        link.href = `#${byVisit(photo.visitId).id}`;
        link.textContent = `${trip.days.find(day => day.bookmark === visits.get(photo.visitId).day).label} · See stop`;
        figure.append(button, caption, link);
        gallery.append(figure);
        imageTasks.push({id:photo.id, image:button.firstChild});
      }
    }
    controls();
    for (const item of imageTasks) {
      const url = await thumbnail(item.id);
      if (generation !== renderVersion) return;
      item.image.src = url;
    }
  }
  function byVisit(id) { return document.querySelector(`[data-visit-id="${id}"]`); }
  async function startVault(previous = "") {
    if (vault || busy) return;
    busy++;
    controls();
    try {
      vault = await TripVault.open(session, trip.visits.filter(visit => visit.kind === "visit" && visit.role !== "replaced").map(visit => visit.id), previous);
      vault.addEventListener("change", () => {
        invalidateBackup();
        renderMemories().catch(error => problem(error, "Saved memories could not be displayed."));
      });
      vault.addEventListener("storageerror", event => problem(event.detail, "Memory storage needs attention."));
      byId("memory-warning").hidden = true;
      document.body.dataset.memoriesReady = "true";
      await renderMemories();
    } catch (error) {
      vault?.close();
      vault = null;
      delete document.body.dataset.memoriesReady;
      byId("memory-storage").textContent = "Memories are not available. Resolve the storage warning before saving progress or photos.";
      for (const node of document.querySelectorAll("[data-progress]")) node.textContent = "Saving unavailable";
      problem(error, "The guide is open, but memories could not be unlocked.");
    } finally { busy--; controls(); }
  }
  byId("memory-retry").addEventListener("click", () => startVault());
  byId("memory-recovery").addEventListener("submit", event => {
    event.preventDefault();
    const old = byId("previous-passphrase").value;
    byId("previous-passphrase").value = "";
    startVault(old);
  });

  document.addEventListener("click", event => {
    const done = event.target.closest("[data-done]");
    const skip = event.target.closest("[data-skip]");
    const add = event.target.closest("[data-photo-add]");
    const photo = event.target.closest("[data-open-photo]");
    if (done && vault && !busy) action(async () => {
      const id = done.dataset.done;
      await vault.setStatus(id, vault.status(id) === "done" ? "pending" : "done");
      toast(vault.status(id) === "done" ? "Done — saved on this phone." : "Completion undone — saved on this phone.");
    }, "Progress was not saved.");
    if (skip && vault && !busy) action(async () => {
      const id = skip.dataset.skip;
      await vault.setStatus(id, vault.status(id) === "skipped" ? "pending" : "skipped");
      toast(vault.status(id) === "skipped" ? "Skipped. Optional stops never affect the main-plan count." : "Stop restored to the main plan.");
    }, "The change was not saved.");
    if (add && vault && !busy) {
      selectedVisit = add.dataset.photoAdd;
      byId("photo-picker-place").textContent = visits.get(selectedVisit).name;
      byId("photo-picker").showModal();
    }
    if (photo && vault && !busy) action(() => openPhoto(photo.dataset.openPhoto), "The photo could not be opened.");
    if (event.target.closest("[data-close-dialog]")) event.target.closest("dialog").close();
  });
  for (const [button, input] of [["take-selfie", "selfie-camera"], ["choose-selfie", "selfie-library"]]) {
    byId(button).addEventListener("click", () => {
      byId("photo-picker").close();
      byId(input).value = "";
      byId(input).click();
    });
    byId(input).addEventListener("change", event => {
      const file = event.target.files[0], id = selectedVisit;
      if (!file || !id || !vault) return;
      const state = document.querySelector(`[data-save-state="${id}"]`);
      state.textContent = "Processing and encrypting the photo…";
      action(async () => {
        await vault.addPhoto(id, file);
        state.textContent = "Selfie saved encrypted on this phone. Use a backup to share it.";
        toast("Selfie saved on this phone.");
      }, "The selfie was not saved.").finally(() => {
        event.target.value = "";
        if (!state.textContent.startsWith("Selfie saved")) state.textContent = "Photo not saved. See the storage warning above.";
      });
    });
  }
  async function openPhoto(id) {
    const photo = vault.photos().find(item => item.id === id);
    if (!photo) throw new Error("This photo is no longer saved here.");
    const blob = await vault.photoBlob(id);
    if (viewerURL) URL.revokeObjectURL(viewerURL);
    viewerURL = URL.createObjectURL(blob);
    viewingPhoto = {id, file:new File([blob], "singapore-photo.jpg", {type:"image/jpeg"})};
    byId("photo-viewer-image").src = viewerURL;
    byId("photo-viewer-title").textContent = visits.get(photo.visitId).name;
    byId("photo-viewer-caption").textContent = "Your saved app copy · " + new Intl.DateTimeFormat("en-IE", {timeZone:"Asia/Singapore", dateStyle:"medium", timeStyle:"short"}).format(new Date(photo.createdAt)) + " SGT";
    byId("photo-viewer-status").textContent = "";
    byId("photo-viewer").showModal();
  }
  byId("photo-viewer").addEventListener("close", () => {
    byId("photo-viewer-image").removeAttribute("src");
    if (viewerURL) URL.revokeObjectURL(viewerURL);
    viewerURL = null; viewingPhoto = null;
  });
  byId("share-photo").addEventListener("click", async () => {
    if (!viewingPhoto) return;
    try {
      if (navigator.canShare?.({files:[viewingPhoto.file]})) await navigator.share({files:[viewingPhoto.file]});
      else {
        const link = document.createElement("a");
        link.href = viewerURL; link.download = "singapore-photo.jpg"; link.click();
        byId("photo-viewer-status").textContent = "Photo download requested. In Safari, save the image from the download or share sheet.";
      }
    } catch (error) {
      if (error.name === "AbortError") byId("photo-viewer-status").textContent = "Sharing cancelled. Your photo is still saved here.";
      else problem(error, "The photo could not be shared.");
    }
  });
  byId("delete-photo").addEventListener("click", () => {
    if (!viewingPhoto || busy || !confirm("Remove this app photo from this device? This does not remove a camera original. The deletion will be included in your next encrypted backup.")) return;
    const id = viewingPhoto.id;
    action(async () => { await vault.removePhoto(id); byId("photo-viewer").close(); toast("App photo removed. Export a fresh backup to share this change."); }, "The photo was not removed.");
  });

  byId("export-memories").addEventListener("click", () => action(async () => {
    byId("backup-status").textContent = "Preparing an encrypted backup…";
    preparedBackup = await vault.exportFile();
    if (backupURL) URL.revokeObjectURL(backupURL);
    backupURL = URL.createObjectURL(preparedBackup);
    const download = byId("download-backup");
    download.href = backupURL; download.download = preparedBackup.name; download.hidden = false;
    byId("share-backup").hidden = !navigator.canShare?.({files:[preparedBackup]});
    byId("backup-status").textContent = "Encrypted backup ready. Save it in Files or share it through AirDrop. On the other phone, open Info → Share and back up → Import.";
  }, "The backup could not be created."));
  byId("share-backup").addEventListener("click", async () => {
    if (!preparedBackup) return;
    try { await navigator.share({files:[preparedBackup]}); byId("backup-status").textContent = "The share sheet completed. The other phone still needs to import the backup."; }
    catch (error) {
      if (error.name === "AbortError") byId("backup-status").textContent = "Sharing cancelled. The prepared backup is still available to save.";
      else problem(error, "The backup could not be shared. Use Save backup to Files instead.");
    }
  });
  async function inspectImport(passphrase = "") {
    preview = null;
    byId("import-preview").hidden = true;
    byId("import-passphrase-form").hidden = true;
    await action(async () => {
      byId("backup-status").textContent = "Checking the encrypted backup. Nothing is being changed yet…";
      try { preview = await vault.prepareImport(importFile, passphrase); } catch (error) {
        if (error.code === "BACKUP_PASSPHRASE") byId("import-passphrase-form").hidden = false;
        byId("backup-status").textContent = "Backup not imported. Resolve the warning and try again.";
        throw error;
      }
      const summary = preview.summary;
      byId("import-summary").textContent = `${summary.states} progress changes, ${summary.photos} new photos, ${summary.removals} photo removals. No changes have been applied yet.`;
      byId("import-delete-label").hidden = summary.removals === 0;
      byId("import-delete-confirm").checked = false;
      byId("import-preview").hidden = false;
      byId("backup-status").textContent = "Backup verified. Review the merge before applying it.";
    }, "The backup could not be opened.");
  }
  byId("import-backup").addEventListener("change", event => {
    importFile = event.target.files[0];
    if (importFile && vault) inspectImport();
  });
  byId("retry-import").addEventListener("click", () => {
    const passphrase = byId("backup-passphrase").value;
    byId("backup-passphrase").value = "";
    if (importFile) inspectImport(passphrase);
  });
  byId("import-delete-confirm").addEventListener("change", controls);
  byId("cancel-import").addEventListener("click", () => {
    preview = null; importFile = null; byId("import-backup").value = "";
    byId("import-preview").hidden = byId("import-passphrase-form").hidden = true;
    byId("backup-status").textContent = "Import cancelled. Nothing changed.";
  });
  byId("merge-backup").addEventListener("click", () => {
    if (!preview || busy || (preview.summary.removals && !byId("import-delete-confirm").checked)) return;
    action(async () => {
      await vault.applyImport(preview);
      preview = null; importFile = null; byId("import-backup").value = "";
      byId("import-preview").hidden = true;
      byId("backup-status").textContent = "Backup merged and saved encrypted on this phone. Export a fresh backup to update the other phone.";
      toast("Memories merged on this phone.");
    }, "The backup was not merged.");
  });
  window.TripMemoryUI = Object.freeze({
    isBusy:() => busy > 0,
    async flush() { if (busy) throw new Error("Wait for the photo or backup operation to finish before locking or updating."); await vault?.flush(); },
    close() {
      vault?.close();
      vault = null;
      for (const url of thumbnailURLs.values()) URL.revokeObjectURL(url);
      thumbnailURLs.clear();
      if (viewerURL) URL.revokeObjectURL(viewerURL);
      if (backupURL) URL.revokeObjectURL(backupURL);
      preparedBackup = preview = viewingPhoto = null;
    },
  });
  window.addEventListener("pagehide", () => { document.documentElement.style.visibility = "hidden"; });
  window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
  if (session && window.TripVault) startVault();
  else problem(new Error("Required memory files did not load. Reconnect and reload the app."), "Saving is unavailable.");
})();
