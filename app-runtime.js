(() => {
  "use strict";
  const app = window.PrivateGuide;
  const session = window.__PRIVATE_GUIDE_SESSION__;
  const warning = document.getElementById("private-app-warning");
  if (!session?.key || !session.meta) {
    warning.textContent = "The app's unlock session is missing. Reopen the app and enter the passphrase.";
    warning.hidden = false;
    return;
  }
  if (session.warning) {
    warning.textContent = session.warning;
    warning.hidden = false;
    document.getElementById("guide-notice").textContent = session.warning;
    document.getElementById("guide-notice").hidden = false;
  }
  app.wireOffline(document.getElementById("app-offline-status"), document.getElementById("app-offline-retry"), document.getElementById("app-download-update"));
  const lock = document.getElementById("lock-guide");
  lock.addEventListener("click", async () => {
    lock.disabled = true;
    try {
      await app.forget(session.meta);
      session.key = null;
      window.__PRIVATE_GUIDE_SESSION__ = null;
      location.reload();
    } catch (problem) {
      warning.textContent = "Saved access couldn't be removed, so this device has not been forgotten. Clear this site's data in browser settings before lending the device to someone.";
      warning.hidden = false;
      console.error("Lock and forget failed:", problem);
      lock.disabled = false;
    }
  });
})();
