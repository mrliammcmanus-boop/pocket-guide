(() => {
  "use strict";
  const app = window.PrivateGuide;
  const form = document.getElementById("unlock-form");
  const input = document.getElementById("passphrase");
  const remember = document.getElementById("remember-access");
  const button = document.getElementById("unlock-button");
  const error = document.getElementById("unlock-error");
  const note = document.getElementById("unlock-note");
  const setupRetry = document.getElementById("setup-retry");
  const show = document.getElementById("show-passphrase");
  let meta;
  let busy = false;

  function failure(message) {
    error.textContent = message;
    error.hidden = false;
  }
  function setBusy(value) {
    busy = value;
    form.setAttribute("aria-busy", String(value));
    button.disabled = value || !meta;
    input.disabled = value;
    remember.disabled = value;
    button.textContent = value ? "Unlocking..." : "Unlock guide";
  }
  function unlockError(problem) {
    return problem.name === "OperationError" ?
      "That passphrase didn't unlock the guide. Check it and try again." : problem.message;
  }

  if (!app) {
    failure("The app couldn't finish downloading. Reconnect and reload this page.");
    note.hidden = true;
    const status = document.getElementById("offline-status");
    status.textContent = "Not ready offline. Required app files did not load.";
    status.dataset.state = "error";
    return;
  }

  show.addEventListener("click", () => {
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    show.textContent = visible ? "Hide" : "Show";
    show.setAttribute("aria-pressed", String(visible));
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || !meta || !input.value) return;
    error.hidden = true;
    setBusy(true);
    let passphrase = input.value;
    input.value = "";
    try {
      const key = await app.derive(passphrase, meta);
      passphrase = "";
      const html = await app.decrypt(key, meta);
      let warning = "";
      try {
        if (remember.checked) await app.remember(meta, key);
        else await app.forget(meta);
      } catch (storageError) {
        warning = remember.checked ?
          "The guide is unlocked for this session, but access could not be saved on this device. You will need the passphrase next time." :
          "This device's previously saved access could not be removed. Clear this site's data in browser settings before lending the device to someone.";
        console.error("Saving or removing remembered access failed:", storageError);
      }
      app.openGuide(html, key, meta, warning);
    } catch (problem) {
      failure(unlockError(problem));
      console.error("Guide unlock failed:", problem.name);
      setBusy(false);
      input.focus();
    } finally {
      passphrase = "";
    }
  });

  async function initialise() {
    setupRetry.hidden = true;
    error.hidden = true;
    note.hidden = false;
    note.textContent = "Preparing the unlock form...";
    if (!window.isSecureContext || !window.crypto?.subtle) {
      failure("This browser cannot decrypt the guide here. Use current Safari and the hosted HTTPS address; don't open it as a file in Downloads.");
      note.hidden = true;
      return;
    }
    try {
      meta = await app.metadata();
      note.textContent = "Checking saved access...";
      let key;
      try {
        key = await app.recalled(meta);
      } catch (storageError) {
        failure(`Saved access couldn't be checked. Enter your passphrase to continue. ${storageError.message}`);
        console.error("Reading remembered access failed:", storageError);
      }
      if (key) {
        setBusy(true);
        try {
          const html = await app.decrypt(key, meta);
          app.openGuide(html, key, meta);
          return;
        } catch (problem) {
          failure("Saved access couldn't unlock this copy. Enter the shared passphrase again.");
          console.error("Remembered-access unlock failed:", problem.name);
        }
      }
      note.hidden = true;
      setBusy(false);
    } catch (problem) {
      failure(problem.message);
      note.hidden = true;
      setupRetry.hidden = false;
      console.error("Loading guide settings failed:", problem);
    }
  }
  setupRetry.addEventListener("click", initialise);
  app.wireOffline(document.getElementById("offline-status"), document.getElementById("offline-retry"), document.getElementById("app-update"));
  initialise();
})();
