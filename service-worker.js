"use strict";
const scope = self.registration.scope;
const CACHE_PREFIX = "private-guide-e8281f5c10976380-" + encodeURIComponent(new URL(scope).pathname) + "-";
const CACHE = CACHE_PREFIX + "99939ebfc6963240ad7f";
const ASSETS = {"404.html": "c64e00f13b7b3434d067c32ec9648405c9221c689ee6698deb1b3bfe76cec8fa", "HankenGrotesk-OFL.txt": "e02ccb89a86839b22feff7872ff5cc355cc0f58318d29eee20e2cf83a612f16d", "app-runtime.css": "c5ff2122da7b958335691bb02ae6ddb26b46405825069dd3ce46117688bcce54", "app-runtime.js": "28d8f18b807c962145716857ea4d461e9037856672681596bdfdeeef1a37c836", "body.ttf": "813b3f8fa0965405669a89b38e51bbefd95eef6b8e20d1cb2d8c10cce062662f", "guide-meta.json": "eeab4b3ef05dfba1af5aed19ed215f75d7b880f4d5b1dcca561ea5e5339cd95a", "guide.bin": "00f99d56acee1146269a4c5c022ec75cc339da42447ae5a3bd45761070ecda88", "icon-180.png": "534e9cffc629054bed96d5ed5bad3943eaa8a08d894c43af126d7cb97867a3aa", "icon-192.png": "6b9bb91f63b54c0b5354c45794fde8cf1c708926fdbdf5399162743553a2dfbc", "icon-512.png": "3d250af3389db596edd39b1f3546ce4d60a86729b109e93d4759e3a0dba4743c", "index.html": "6a69eb8b3fcd59289975a3a027c415f59f258abfca224c3802996179d44bae6a", "manifest.webmanifest": "bc611a5c23b77b437a5a0796ac23ac033b97767dfd3bc360808da8f354aa3546", "private-common.js": "1fa4a9967972052ebd32d80b3a00f344a3d921a9e46f4c2ebffc05020a041e5b", "trip-ui.js": "214f1b4e6e42ccb7ccb0fd0cf9fb624002d1a566e9a90232835fc0c659eedbae", "trip-vault.js": "e7d035b3874408fb81fab40e43ee98877f60b1feb2d2063681bf41fc4c7c27b1", "unlock.css": "6abc0b96088b69e2d137e58e2281414d679ab414cb27ecec15293db7aabf830f", "unlock.js": "d6637e43ff13dd7d78bc525ba5a2f120d40e7c8f05d13c669f33c3d4a2d463e5"};
const urls = new Map(Object.entries(ASSETS).map(([name, hash]) => [new URL(name, scope).href, hash]));
const indexURL = new URL("index.html", scope).href;

async function digest(response) {
  const value = await crypto.subtle.digest("SHA-256", await response.clone().arrayBuffer());
  return [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function populate(cache) {
  let done = 0;
  for (const [url, expected] of urls) {
    const response = await fetch(url, {cache:"reload", credentials:"same-origin"});
    if (!response.ok || response.type !== "basic" || await digest(response) !== expected) {
      throw new Error("A required file could not be downloaded intact. Check your connection and available storage, then retry.");
    }
    await cache.put(url, response);
    done += 1;
    const clients = await self.clients.matchAll({type:"window", includeUncontrolled:true});
    for (const client of clients) {
      if (client.url.startsWith(scope)) client.postMessage({type:"DOWNLOAD_PROGRESS", done, total:urls.size});
    }
  }
}

async function check() {
  const cache = await caches.open(CACHE);
  for (const [url, expected] of urls) {
    const response = await cache.match(url);
    if (!response || await digest(response) !== expected) return false;
  }
  return true;
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    try {
      await populate(await caches.open(CACHE));
    } catch (error) {
      await caches.delete(CACHE);
      throw error;
    }
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_PREFIX) && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== new URL(scope).origin || !url.href.startsWith(scope)) return;
  url.hash = "";
  const isIndex = url.href.split("?")[0] === scope || url.href.split("?")[0] === indexURL;
  const cacheURL = isIndex ? indexURL : url.href;
  if (!urls.has(cacheURL)) {
    if (event.request.mode !== "navigate") return;
    event.respondWith((async () => {
      const cached = await (await caches.open(CACHE)).match(new URL("404.html", scope).href);
      return cached ? new Response(await cached.arrayBuffer(), {status:404, headers:cached.headers}) : fetch(event.request);
    })());
    return;
  }
  event.respondWith((async () => {
    const cached = await (await caches.open(CACHE)).match(cacheURL);
    return cached || fetch(event.request);
  })());
});

self.addEventListener("message", event => {
  if (event.data?.type === "ACTIVATE_UPDATE") {
    event.waitUntil(self.skipWaiting());
  } else if (event.data?.type === "CHECK_OFFLINE") {
    event.waitUntil((async () => {
      try {
        event.ports[0]?.postMessage({type:"OFFLINE_STATE", ready:await check()});
      } catch (error) {
        console.error("Offline verification failed:", error);
        event.ports[0]?.postMessage({type:"OFFLINE_STATE", ready:false});
      }
    })());
  } else if (event.data?.type === "REPAIR_OFFLINE") {
    event.waitUntil((async () => {
      try {
        await populate(await caches.open(CACHE));
        event.ports[0]?.postMessage({ready:await check()});
      } catch (error) {
        console.error("Offline repair failed:", error);
        event.ports[0]?.postMessage({ready:false, error:error.message});
      }
    })());
  }
});
