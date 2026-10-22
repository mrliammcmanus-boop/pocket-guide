(() => {
  "use strict";
  const enc = new TextEncoder();
  const dec = new TextDecoder("utf-8", {fatal:true});
  const PHOTO_LIMIT = 100 * 1024 * 1024;
  const IMAGE_LIMIT = 1536 * 1024;
  const RECORD_LIMIT = 2000;
  const CLOCK_LIMIT = 1e12;
  const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  const MAGIC = enc.encode("SGTRIP01");
  const random = () => crypto.getRandomValues(new Uint8Array(12));
  const json = value => enc.encode(JSON.stringify(value));
  const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const un64 = (text, length) => {
    if (typeof text !== "string" || text.length > 4096) throw new Error("Invalid encrypted-memory settings.");
    const value = Uint8Array.from(atob(text), item => item.charCodeAt(0));
    if (length !== undefined && value.length !== length) throw new Error("Invalid encrypted-memory settings.");
    return value;
  };
  const bytes = value => value instanceof Uint8Array ? value : new Uint8Array(value);
  const stampValid = stamp => stamp && Number.isSafeInteger(stamp.clock) && stamp.clock > 0 &&
    stamp.clock < CLOCK_LIMIT && typeof stamp.actor === "string" && UUID.test(stamp.actor);
  const newer = (left, right) => !right || left.clock > right.clock ||
    (left.clock === right.clock && left.actor > right.actor);
  const failure = (message, code) => Object.assign(new Error(message), {code});

  function transaction(db, stores, mode, action) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result, callbackError;
      const guard = callback => event => {
        try { callback(event); } catch (error) { callbackError = error; tx.abort(); }
      };
      try { result = action(tx, guard); } catch (error) { tx.abort(); reject(error); return; }
      tx.oncomplete = () => resolve(typeof result === "function" ? result() : result);
      tx.onabort = () => reject(callbackError || tx.error || failure("Another window changed the memories. Retry the action.", "RETRY_WRITE"));
      tx.onerror = () => reject(callbackError || tx.error || new Error("Device storage could not finish saving. Free some space and retry."));
    });
  }

  async function openDatabase(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      let settled = false;
      request.onupgradeneeded = () => {
        request.result.createObjectStore("settings");
        request.result.createObjectStore("records", {keyPath:"id"});
      };
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true;
        resolve(request.result);
      };
      request.onerror = () => { settled = true; reject(request.error); };
      request.onblocked = () => {
        settled = true;
        reject(new Error("Another tab is blocking memory storage. Close it and retry."));
      };
    });
  }

  async function snapshot(db) {
    let settings, rows;
    await transaction(db, ["settings", "records"], "readonly", tx => {
      tx.objectStore("settings").get("vault").onsuccess = event => { settings = event.target.result; };
      tx.objectStore("records").getAll().onsuccess = event => { rows = event.target.result; };
    });
    return {settings, rows};
  }

  function wrapAAD(appId, keyId, salt) {
    return enc.encode(`trip-memory-key:v1:${appId}:${keyId}:${salt}:600000`);
  }
  function recordAAD(appId, keyId, row) {
    return enc.encode(`trip-memory-record:v1:${appId}:${keyId}:${row.id}:${row.stamp.clock}:${row.stamp.actor}`);
  }
  function backupAAD(header) {
    return enc.encode(`trip-memory-backup:v1:${header.app_id}:${header.salt}:600000`);
  }
  async function seal(key, payload, aad) {
    const iv = random();
    const cipher = new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM", iv, additionalData:aad}, key, payload));
    return {iv, cipher};
  }
  async function open(key, box, aad) {
    return new Uint8Array(await crypto.subtle.decrypt(
      {name:"AES-GCM", iv:bytes(box.iv), additionalData:aad}, key, box.cipher,
    ));
  }
  function validateWrap(box) {
    if (!box || !UUID.test(box.id) || box.iterations !== 600000) throw new Error("The memory key is invalid. Keep your backup; do not clear site data.");
    un64(box.salt, 16);
    un64(box.iv, 12);
    un64(box.cipher, 48);
  }
  async function wrapKey(raw, master, meta, id) {
    const box = await seal(master, raw, wrapAAD(meta.app_id, id, meta.salt));
    return {id, salt:meta.salt, iterations:600000, iv:b64(box.iv), cipher:b64(box.cipher)};
  }
  async function unwrapKey(box, master, appId) {
    validateWrap(box);
    return open(master, {iv:un64(box.iv, 12), cipher:un64(box.cipher, 48)}, wrapAAD(appId, box.id, box.salt));
  }
  async function dataKey(raw) {
    return crypto.subtle.importKey("raw", raw, {name:"AES-GCM"}, false, ["encrypt", "decrypt"]);
  }

  function jpegSize(value) {
    if (value[0] !== 255 || value[1] !== 216) throw new Error("The photo is not a valid app JPEG.");
    let offset = 2;
    while (offset + 8 < value.length) {
      if (value[offset++] !== 255) break;
      while (value[offset] === 255) offset++;
      const marker = value[offset++];
      if (marker === 218 || marker === 217) break;
      const length = value[offset] * 256 + value[offset + 1];
      if (length < 2 || offset + length > value.length) break;
      if ([192, 193, 194].includes(marker)) {
        return {width:value[offset + 5] * 256 + value[offset + 6], height:value[offset + 3] * 256 + value[offset + 4]};
      }
      offset += length;
    }
    throw new Error("The photo's dimensions could not be verified.");
  }

  async function preparePhoto(file) {
    if (!(file instanceof Blob) || !file.size || file.size > 40 * 1024 * 1024) {
      throw new Error("Choose a photo smaller than 40 MB. Nothing has been saved.");
    }
    const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    const tag = String.fromCharCode(...head);
    const supported = (head[0] === 255 && head[1] === 216) ||
      (head[0] === 137 && tag.slice(1, 4) === "PNG") ||
      (tag.startsWith("RIFF") && tag.slice(8, 12) === "WEBP") ||
      (tag.slice(4, 8) === "ftyp" && /heic|heix|hevc|hevx|mif1|msf1|avif|avis/.test(tag));
    if (!supported) throw new Error("Choose a JPEG, PNG, WebP, HEIC/HEIF or AVIF photo. SVG and other file types are not accepted.");
    const url = URL.createObjectURL(file);
    const image = new Image();
    try {
      image.src = url;
      try { await image.decode(); } catch (error) {
        throw new Error("This browser could not open that photo. For HEIC, try current iPhone Safari or export a JPEG from Photos. Nothing has been saved.", {cause:error});
      }
      if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 64e6) {
        throw new Error("That image is too large to process safely. Choose a smaller copy from Photos.");
      }
      const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d", {alpha:false});
      if (!context) throw new Error("The photo editor could not start. Close other tabs and try again.");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      let blob;
      for (const quality of [0.86, 0.73, 0.6]) {
        blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
        if (blob && blob.size <= IMAGE_LIMIT) break;
      }
      canvas.width = canvas.height = 1;
      if (!blob || blob.size > IMAGE_LIMIT) throw new Error("That photo could not fit the app's 1.5 MB copy limit. Choose a smaller image.");
      return {payload:new Uint8Array(await blob.arrayBuffer()), width:Math.round(image.naturalWidth * scale), height:Math.round(image.naturalHeight * scale)};
    } finally {
      image.src = "";
      URL.revokeObjectURL(url);
    }
  }

  class Vault extends EventTarget {
    constructor(session, allowed) {
      super();
      this.session = session;
      this.allowed = new Set(allowed);
      this.name = `private-memories-${session.meta.app_id}-${encodeURIComponent(PrivateGuide.base.pathname)}`;
      this.rows = new Map();
      this.values = new Map();
      this.queue = Promise.resolve();
      this.closed = false;
    }
    async initialise(previousPassphrase) {
      if (!this.session.key.usages.includes("encrypt")) {
        throw new Error("Saved access needs refreshing for photo storage. Lock the guide, then enter the passphrase once.");
      }
      this.db = await openDatabase(this.name);
      try {
        let current = await snapshot(this.db);
        if (!current.settings) {
          const raw = crypto.getRandomValues(new Uint8Array(32));
          let candidate;
          try {
            candidate = {format:1, actor:crypto.randomUUID(), clock:0,
              key:await wrapKey(raw, this.session.key, this.session.meta, crypto.randomUUID())};
          } finally { raw.fill(0); }
          await transaction(this.db, ["settings"], "readwrite", (tx, guard) => {
            const store = tx.objectStore("settings");
            store.get("vault").onsuccess = guard(event => { if (!event.target.result) store.put(candidate, "vault"); });
          });
          current = await snapshot(this.db);
        }
        const setting = current.settings;
        this.validateSettings(setting);
        let raw;
        try {
          const master = previousPassphrase ? await PrivateGuide.derive(previousPassphrase, {salt:setting.key.salt}) : this.session.key;
          raw = await unwrapKey(setting.key, master, this.session.meta.app_id);
        } catch (error) {
          if (error.name === "OperationError") throw failure("These memories use a previous passphrase, or their saved key is damaged. Enter the previous guide passphrase to recover them; nothing has been deleted.", "MEMORY_PASSPHRASE");
          throw error;
        }
        try {
          this.key = await dataKey(raw);
          this.keyId = setting.key.id;
          if (previousPassphrase) {
            const wrapped = await wrapKey(raw, this.session.key, this.session.meta, this.keyId);
            await transaction(this.db, ["settings"], "readwrite", (tx, guard) => {
              const store = tx.objectStore("settings");
              store.get("vault").onsuccess = guard(event => {
                const latest = event.target.result;
                if (latest?.key?.id !== this.keyId) { tx.abort(); return; }
                store.put({...latest, key:wrapped}, "vault");
              });
            });
            current = await snapshot(this.db);
          }
        } finally { raw.fill(0); }
        await this.load(current);
        this.db.onversionchange = () => {
          this.close();
          this.dispatchEvent(new CustomEvent("storageerror", {detail:new Error("Memory storage changed in another tab. Reopen the app before saving.")}));
        };
        if ("BroadcastChannel" in window) {
          this.channel = new BroadcastChannel(this.name);
          this.channel.onmessage = () => this.refresh().catch(error => this.dispatchEvent(new CustomEvent("storageerror", {detail:error})));
        }
        return this;
      } catch (error) {
        this.db.close();
        throw error;
      }
    }
    validateSettings(setting) {
      if (!setting || setting.format !== 1 || !UUID.test(setting.actor) ||
          !Number.isSafeInteger(setting.clock) || setting.clock < 0 || setting.clock >= CLOCK_LIMIT) {
        throw new Error("Saved memory settings are damaged. Keep your backup and do not clear this site's data.");
      }
      validateWrap(setting.key);
    }
    validateRow(row, keyId = this.keyId) {
      if (!row || typeof row.id !== "string" || !stampValid(row.stamp) || bytes(row.iv).length !== 12 ||
          bytes(row.cipher).length < 16 || bytes(row.cipher).length > IMAGE_LIMIT + 16 || !UUID.test(keyId)) {
        throw new Error("An encrypted memory record is invalid. Nothing has been overwritten.");
      }
      const [kind, id, extra] = row.id.split(":");
      if (extra || !((kind === "state" && this.allowed.has(id)) || (["photo", "image"].includes(kind) && UUID.test(id)))) {
        throw new Error("This memory file has unknown stops or records. Update the app before importing it.");
      }
    }
    validateValue(row, value) {
      const [kind, id] = row.id.split(":");
      if (kind === "state") {
        if (value.kind !== kind || value.visitId !== id || !["pending", "done", "skipped"].includes(value.value)) throw new Error("Invalid saved completion state.");
      } else if (kind === "photo") {
        if (value.kind !== kind || value.id !== id || !this.allowed.has(value.visitId) || typeof value.deleted !== "boolean" ||
            !Number.isFinite(value.createdAt) || value.createdAt < 0 || value.createdAt > 8.64e15 ||
            !Number.isInteger(value.width) || value.width < 1 || value.width > 1600 ||
            !Number.isInteger(value.height) || value.height < 1 || value.height > 1600 ||
            !Number.isInteger(value.bytes) || value.bytes < 1 || value.bytes > IMAGE_LIMIT) throw new Error("Invalid saved photo details.");
      } else throw new Error("Unexpected memory metadata.");
    }
    async plain(row, key = this.key, keyId = this.keyId) {
      this.validateRow(row, keyId);
      return open(key, row, recordAAD(this.session.meta.app_id, keyId, row));
    }
    async sealed(id, stamp, payload) {
      const row = {id, stamp};
      return {...row, ...await seal(this.key, payload, recordAAD(this.session.meta.app_id, this.keyId, row))};
    }
    async load(current) {
      this.validateSettings(current.settings);
      if (current.settings.key.id !== this.keyId || current.rows.length > RECORD_LIMIT) throw new Error("The saved memory collection is invalid.");
      const rows = new Map(), values = new Map();
      for (const row of current.rows) {
        this.validateRow(row);
        if (row.stamp.clock > current.settings.clock) throw new Error("Saved memory revisions are inconsistent.");
        rows.set(row.id, row);
        if (!row.id.startsWith("image:")) {
          const value = JSON.parse(dec.decode(await this.plain(row)));
          this.validateValue(row, value);
          values.set(row.id, value);
        }
      }
      for (const value of values.values()) {
        if (value.kind === "photo" && !value.deleted && !rows.has(`image:${value.id}`)) throw new Error("A saved photo is missing its encrypted image. Keep your backup; nothing has been removed.");
      }
      this.rows = rows;
      this.values = values;
      this.setting = current.settings;
    }
    async refresh() {
      if (this.closed) return;
      await this.queue;
      await this.load(await snapshot(this.db));
      this.dispatchEvent(new Event("change"));
    }
    status(id) { return this.values.get(`state:${id}`)?.value || "pending"; }
    photos(id) {
      return [...this.values.values()].filter(value => value.kind === "photo" && !value.deleted && (!id || value.visitId === id))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    }
    size() { return this.photos().reduce((total, value) => total + value.bytes, 0); }
    mutate(builder, observed = 0) {
      const run = async () => {
        if (this.closed) throw new Error("Memory storage is closed. Reopen the app before saving.");
        for (let attempt = 0; attempt < 5; attempt++) {
          const current = await snapshot(this.db);
          await this.load(current);
          const clock = Math.max(current.settings.clock, observed) + 1;
          if (clock >= CLOCK_LIMIT) throw new Error("The memory revision limit was reached. Export your backup before continuing.");
          const stamp = {clock, actor:current.settings.actor};
          const {put = [], remove = []} = await builder(stamp);
          const resultingIds = new Set(current.rows.map(row => row.id));
          for (const id of remove) resultingIds.delete(id);
          for (const row of put) resultingIds.add(row.id);
          if (resultingIds.size > RECORD_LIMIT) throw new Error("The app's photo and deletion-history limit was reached. Export a backup before continuing. Nothing from this action was saved.");
          let conflict = false;
          try {
            // Crypto finishes before opening the write transaction; IndexedDB must not auto-close mid-encryption.
            await transaction(this.db, ["settings", "records"], "readwrite", (tx, guard) => {
              const settings = tx.objectStore("settings");
              settings.get("vault").onsuccess = guard(event => {
                const latest = event.target.result;
                if (latest?.clock !== current.settings.clock || latest?.key?.id !== this.keyId) {
                  conflict = true; tx.abort(); return;
                }
                const store = tx.objectStore("records");
                for (const id of remove) store.delete(id);
                for (const row of put) store.put(row);
                settings.put({...latest, clock}, "vault");
              });
            });
          } catch (error) {
            if (conflict) continue;
            throw error;
          }
          await this.load(await snapshot(this.db));
          this.channel?.postMessage({changed:true});
          this.dispatchEvent(new Event("change"));
          return;
        }
        throw new Error("Another tab keeps changing these memories. Close it, then retry.");
      };
      const result = this.queue.then(run);
      // The caller retains the rejecting promise; only the internal serialization chain recovers.
      this.queue = result.catch(() => {});
      return result;
    }
    async setStatus(id, value) {
      if (!this.allowed.has(id) || !["pending", "done", "skipped"].includes(value)) throw new Error("That completion action is invalid.");
      await this.mutate(async stamp => ({put:[await this.sealed(`state:${id}`, stamp, json({kind:"state", visitId:id, value}))]}));
    }
    async addPhoto(id, file) {
      if (!this.allowed.has(id)) throw new Error("Choose a real stop before adding a selfie.");
      const photo = await preparePhoto(file);
      const uid = crypto.randomUUID();
      await this.mutate(async stamp => {
        if (this.photos().length >= 500 || this.size() + photo.payload.length > PHOTO_LIMIT) throw new Error("This device reached the app's 100 MB / 500-photo limit. Export a backup and free space before retrying.");
        const value = {kind:"photo", id:uid, visitId:id, deleted:false, createdAt:Date.now(), width:photo.width, height:photo.height, bytes:photo.payload.length};
        return {put:[await this.sealed(`photo:${uid}`, stamp, json(value)), await this.sealed(`image:${uid}`, stamp, photo.payload)]};
      });
      return uid;
    }
    async photoBlob(id) {
      const value = this.values.get(`photo:${id}`);
      if (!value || value.deleted) throw new Error("That photo is no longer saved here.");
      const payload = await this.plain(this.rows.get(`image:${id}`));
      const size = jpegSize(payload);
      if (payload.length !== value.bytes || size.width !== value.width || size.height !== value.height) throw new Error("The saved photo is damaged. Try your encrypted backup.");
      return new Blob([payload], {type:"image/jpeg"});
    }
    async removePhoto(id) {
      await this.mutate(async stamp => {
        const value = this.values.get(`photo:${id}`);
        if (!value || value.deleted) throw new Error("That photo has already been removed.");
        return {put:[await this.sealed(`photo:${id}`, stamp, json({...value, deleted:true}))], remove:[`image:${id}`]};
      });
    }
    async exportFile() {
      await this.queue;
      await this.load(await snapshot(this.db));
      try {
        const raw = await unwrapKey(this.setting.key, this.session.key, this.session.meta.app_id);
        raw.fill(0);
      } catch (error) {
        if (error.name === "OperationError") throw new Error("The memory passphrase changed in another window. Reopen and unlock the guide before exporting.");
        throw error;
      }
      const rows = [...this.rows.values()].sort((a, b) => a.id.localeCompare(b.id));
      const manifest = {
        format:1, key:this.setting.key,
        records:rows.map(row => ({id:row.id, stamp:row.stamp, iv:b64(row.iv), bytes:bytes(row.cipher).length})),
      };
      const header = {format:1, app_id:this.session.meta.app_id, salt:this.session.meta.salt, iterations:600000};
      const box = await seal(this.session.key, json(manifest), backupAAD(header));
      header.iv = b64(box.iv);
      header.manifest_bytes = box.cipher.length;
      const encoded = json(header);
      const length = new Uint8Array(4);
      new DataView(length.buffer).setUint32(0, encoded.length);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      return new File([MAGIC, length, encoded, box.cipher, ...rows.map(row => row.cipher)],
        `singapore-memories-${stamp}.sgtrip`, {type:"application/octet-stream"});
    }
    async prepareImport(file, passphrase = "") {
      if (!(file instanceof Blob) || file.size < 30 || file.size > PHOTO_LIMIT + 4 * 1024 * 1024) throw new Error("Choose an encrypted .sgtrip backup no larger than 104 MB.");
      const start = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      if (!MAGIC.every((value, index) => start[index] === value)) throw new Error("This is not a Singapore memories backup.");
      const length = new DataView(start.buffer).getUint32(8);
      if (length < 20 || length > 4096) throw new Error("The backup header is invalid.");
      const header = JSON.parse(dec.decode(await file.slice(12, 12 + length).arrayBuffer()));
      if (header.format !== 1 || header.app_id !== this.session.meta.app_id || header.iterations !== 600000 ||
          !Number.isInteger(header.manifest_bytes) || header.manifest_bytes < 16 || header.manifest_bytes > 1024 * 1024) {
        throw new Error("This backup belongs to another guide or uses an unsupported format. Nothing has changed.");
      }
      un64(header.salt, 16);
      let offset = 12 + length + header.manifest_bytes;
      if (offset > file.size) throw new Error("The backup is incomplete.");
      const master = passphrase ? await PrivateGuide.derive(passphrase, {salt:header.salt}) : this.session.key;
      let manifest, incomingKey;
      try {
        manifest = JSON.parse(dec.decode(await open(master, {
          iv:un64(header.iv, 12), cipher:await file.slice(12 + length, offset).arrayBuffer(),
        }, backupAAD(header))));
        validateWrap(manifest.key);
        const raw = await unwrapKey(manifest.key, master, header.app_id);
        try { incomingKey = await dataKey(raw); } finally { raw.fill(0); }
      } catch (error) {
        if (error.name === "OperationError") throw failure("This backup needs its original passphrase, or the file is damaged. Enter the passphrase used when it was exported.", "BACKUP_PASSPHRASE");
        throw error;
      }
      if (manifest.format !== 1 || !Array.isArray(manifest.records) || manifest.records.length > RECORD_LIMIT) throw new Error("The backup contains invalid records.");
      const rows = new Map(), values = new Map();
      for (const entry of manifest.records) {
        if (!Number.isInteger(entry.bytes) || entry.bytes < 16 || entry.bytes > IMAGE_LIMIT + 16 || offset + entry.bytes > file.size || rows.has(entry.id)) throw new Error("The backup has incomplete or duplicate records.");
        const row = {...entry, iv:un64(entry.iv, 12), cipher:new Uint8Array(await file.slice(offset, offset + entry.bytes).arrayBuffer())};
        offset += entry.bytes;
        this.validateRow(row, manifest.key.id);
        const plain = await this.plain(row, incomingKey, manifest.key.id);
        if (row.id.startsWith("image:")) jpegSize(plain);
        else {
          const value = JSON.parse(dec.decode(plain));
          this.validateValue(row, value);
          values.set(row.id, value);
        }
        rows.set(row.id, row);
      }
      if (offset !== file.size) throw new Error("The backup contains unexpected trailing data.");
      let totalBytes = 0;
      for (const value of values.values()) {
        if (value.kind !== "photo" || value.deleted) continue;
        const image = rows.get(`image:${value.id}`);
        if (!image) throw new Error("The backup is missing a photo. Nothing has changed.");
        const payload = await this.plain(image, incomingKey, manifest.key.id);
        const size = jpegSize(payload);
        if (size.width !== value.width || size.height !== value.height || payload.length !== value.bytes) throw new Error("The backup's photo details do not match its image.");
        totalBytes += value.bytes;
      }
      for (const id of rows.keys()) if (id.startsWith("image:") && !values.has(`photo:${id.slice(6)}`)) throw new Error("The backup has a photo with no stop.");
      if (totalBytes > PHOTO_LIMIT) throw new Error("The backup exceeds the photo-storage limit.");
      await this.refresh();
      const summary = {states:0, photos:0, removals:0};
      for (const [id, value] of values) {
        if (!newer(rows.get(id).stamp, this.rows.get(id)?.stamp)) continue;
        const local = this.values.get(id);
        if (value.kind === "state" && value.value !== (local?.value || "pending")) summary.states++;
        if (value.kind === "photo") {
          if (local && local.visitId !== value.visitId) throw new Error("The backup contains a conflicting photo identity.");
          if (!value.deleted && !local) summary.photos++;
          if (value.deleted && local && !local.deleted) summary.removals++;
        }
      }
      return {summary, rows, values, key:incomingKey, keyId:manifest.key.id};
    }
    async applyImport(preview) {
      const prepared = new Map();
      for (const row of preview.rows.values()) {
        const payload = await this.plain(row, preview.key, preview.keyId);
        prepared.set(row.id, await this.sealed(row.id, row.stamp, payload));
      }
      const observed = Math.max(0, ...[...preview.rows.values()].map(row => row.stamp.clock));
      await this.mutate(async () => {
        const put = [], remove = [];
        const result = new Map(this.values);
        let removals = 0;
        for (const [id, value] of preview.values) {
          if (!newer(preview.rows.get(id).stamp, this.rows.get(id)?.stamp)) continue;
          result.set(id, value);
          put.push(prepared.get(id));
          if (value.kind === "photo") {
            if (value.deleted) {
              if (this.values.get(id) && !this.values.get(id).deleted) removals++;
              remove.push(`image:${value.id}`);
            }
            else put.push(prepared.get(`image:${value.id}`));
          }
        }
        if (removals > preview.summary.removals) throw new Error("Memories changed after the preview. Open the backup again to review its photo removals.");
        const photos = [...result.values()].filter(value => value.kind === "photo" && !value.deleted);
        if (photos.length > 500 || photos.reduce((total, value) => total + value.bytes, 0) > PHOTO_LIMIT) throw new Error("The combined photos exceed this app's device limit. Nothing was imported.");
        return {put, remove};
      }, observed);
    }
    async flush() { await this.queue; }
    close() {
      this.closed = true;
      this.channel?.close();
      this.db?.close();
      this.rows.clear();
      this.values.clear();
      this.key = null;
      this.session = null;
    }
  }

  window.TripVault = Object.freeze({
    async open(session, allowed, previousPassphrase = "") {
      return new Vault(session, allowed).initialise(previousPassphrase);
    },
  });
})();
