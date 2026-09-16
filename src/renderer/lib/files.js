/**
 * File helpers.
 *
 * The app had three different ways to save a file — an unused `downloadFile`
 * helper, a hand-rolled data-URL download inside the wallet screen, and the
 * native save dialog over IPC — with the two backup screens each picking a
 * different one. This is the single path: the native dialog when the Electron
 * bridge is present, and a plain browser download when running in the web
 * preview harness.
 */

const bridge = () =>
  typeof window !== "undefined" ? window.nilevault : undefined;

/** Save text content, prompting for a location when possible. */
export async function saveTextFile({
  defaultPath,
  content,
  mime = "application/json",
}) {
  const native = bridge()?.saveBackupFile;
  if (native) {
    return native({ defaultPath, content });
  }

  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = defaultPath;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return { canceled: false, filePath: defaultPath };
}

/** Read a text file, via the native open dialog when available. */
export async function openTextFile({
  accept = ".json,application/json",
  title = "Select a file",
} = {}) {
  const native = bridge()?.openBackupFile;
  if (native) {
    return native({ accept, title });
  }

  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) {
        resolve({ canceled: true });
        return;
      }
      const reader = new FileReader();
      reader.onload = () =>
        resolve({
          canceled: false,
          content: String(reader.result || ""),
          fileName: file.name,
        });
      reader.onerror = () => resolve({ canceled: true });
      reader.readAsText(file);
    });
    document.body.appendChild(input);
    input.click();
    input.remove();
  });
}
