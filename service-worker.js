"use strict";
const scope = self.registration.scope;
const CACHE_PREFIX = "private-guide-e8281f5c10976380-" + encodeURIComponent(new URL(scope).pathname) + "-";
const CACHE = CACHE_PREFIX + "ff978f0e75468cff390c";
const ASSETS = {"404.html": "c64e00f13b7b3434d067c32ec9648405c9221c689ee6698deb1b3bfe76cec8fa", "Lato-OFL.txt": "74ba064d03f1f1c4a952da936c3eb71866c34404916734de3cae73b34357e59e", "SourceSerif4-OFL.txt": "c21d7293d87b6d7ab1d0229a2f55b77f33a7613a6a4e66f6693d68d7d8d09464", "app-runtime.css": "8fce9a7c98e0e43ddfade29823d764504f5b7732d48334237aaa45aa278755c4", "app-runtime.js": "2b80971ea8c28ea1943345d3b9c4aaf3ca442f325709e905968ba2f39b443968", "body-bold.ttf": "8a0aace75d33794eece4b28187bfc1df0bbd2888b5d8a56e01788c8d65d16be1", "body.ttf": "d636e4683231f931eda222d588e944d082bfd3bdba02f928bee461c0f185b251", "guide-meta.json": "cf726d4f3ea6fbf7cdd1d5f45174390fdeca51e3af876585489b8e5585cffc41", "guide.bin": "7aa458e6dcbd90b84ed5bbcb441dc791d64054d202e023112582cc3b49d5077f", "heading.ttf": "36db62940cb5728b12b1802476dc7fcf4c6c519a7bdd476ba23a4e555fc4655f", "icon-180.png": "83665e3a0b53b0d27066e5dcebdc3a0c05761f2050f5705e3b42b634ca1068ec", "icon-192.png": "7f21fc0ca7e995dc772011fb640674e7daf419d24981f261d8cb7193adc45133", "icon-512.png": "b86e50806b3dd35d36ba9127477684e2385dcf8b78ad5f199e299201bde43c8f", "index.html": "cdc31472cdd9d88e4ca9d6981da2db7abed331b7d583ddc8d3aa4e3a09f2ea0b", "manifest.webmanifest": "44891316d21accbadcf4f15c1c6de73f8cf32919568241f5cfb273fa69dee626", "private-common.js": "324effc71bb069cf3163d9cf4fb06543af87be45240f15702ab2d157c45ec090", "unlock.css": "d362cc11722b8273fd7e87bb5cfbb3836b3318b030ccb6022813cbd3a3521cde", "unlock.js": "d6637e43ff13dd7d78bc525ba5a2f120d40e7c8f05d13c669f33c3d4a2d463e5"};
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
