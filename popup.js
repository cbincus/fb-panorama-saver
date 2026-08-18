/** popup.js — settings UI. Saved to chrome.storage.sync; read by
 *  background.js when encoding the panorama. */
"use strict";

const DEFAULTS = { format: "jpg", qualityJpg: 92, qualityWebp: 80 };

const HINTS = {
  jpg:  "Smallest files. Quality 92 is visually lossless for photos.",
  png:  "Lossless \u2014 no quality setting. Files can exceed 200 MB for high-res panoramas.",
  webp: "Smaller than JPG at similar quality. Quality 80 is a good balance.",
};

const segments = [...document.querySelectorAll(".segments button")];
const qualityRow = document.getElementById("quality-row");
const qualitySlider = document.getElementById("quality");
const qualityValue = document.getElementById("quality-value");
const hint = document.getElementById("hint");

let settings = { ...DEFAULTS };

function qualityKey(format) {
  return format === "webp" ? "qualityWebp" : "qualityJpg";
}

function render() {
  for (const b of segments) {
    const active = b.dataset.format === settings.format;
    b.classList.toggle("active", active);
    b.setAttribute("aria-checked", String(active));
  }
  const lossy = settings.format !== "png";
  qualityRow.classList.toggle("hidden", !lossy);
  if (lossy) {
    const q = settings[qualityKey(settings.format)];
    qualitySlider.value = q;
    qualityValue.textContent = q;
  }
  hint.textContent = HINTS[settings.format];
}

function save() {
  chrome.storage.sync.set(settings);
}

for (const b of segments) {
  b.addEventListener("click", () => {
    settings.format = b.dataset.format;
    render();
    save();
  });
}

qualitySlider.addEventListener("input", () => {
  qualityValue.textContent = qualitySlider.value;
});
qualitySlider.addEventListener("change", () => {
  settings[qualityKey(settings.format)] = Number(qualitySlider.value);
  save();
});

chrome.storage.sync.get(DEFAULTS).then((s) => {
  settings = { ...DEFAULTS, ...s };
  render();
});
