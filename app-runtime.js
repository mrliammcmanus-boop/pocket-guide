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
      await window.TripMemoryUI?.flush();
      await app.forget(session.meta);
      window.TripMemoryUI?.close();
      session.key = null;
      window.__PRIVATE_GUIDE_SESSION__ = null;
      location.reload();
    } catch (problem) {
      warning.textContent = `The guide has not been locked. ${problem.message} Do not clear site data without exporting a memory backup first.`;
      warning.hidden = false;
      console.error("Lock and forget failed:", problem);
      lock.disabled = false;
    }
  });
})();
