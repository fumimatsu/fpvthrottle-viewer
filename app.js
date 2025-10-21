const videoInput = document.getElementById("video-input");
const video = document.getElementById("video");
const selectionCanvas = document.getElementById("selection-canvas");
const selectionCtx = selectionCanvas.getContext("2d");
const frameStepInput = document.getElementById("frame-step");
const minValueInput = document.getElementById("value-min");
const maxValueInput = document.getElementById("value-max");
const ocrEngineSelect = document.getElementById("ocr-engine");
const toggleModeBtn = document.getElementById("toggle-mode-btn");
const startBtn = document.getElementById("start-btn");
const downloadBtn = document.getElementById("download-btn");
const progressEl = document.getElementById("progress");
const statusText = document.getElementById("status-text");
const resultsBody = document.getElementById("results-body");
const chartCanvas = document.getElementById("chart");

let chart;
let roi = null;
let drawing = false;
let workerPromise = null;
let selectionMode = true;
let paddleInitPromise = null;
const ROI_PADDING_FACTOR = 0.08;
const ROI_SCALE_FACTOR = 3;

const workingCanvas = document.createElement("canvas");
const workingCtx = workingCanvas.getContext("2d", { willReadFrequently: true });

const roiCanvas = document.createElement("canvas");
const roiCtx = roiCanvas.getContext("2d", { willReadFrequently: true });
const scaledCanvas = document.createElement("canvas");
const scaledCtx = scaledCanvas.getContext("2d", { willReadFrequently: true });

videoInput.addEventListener("change", handleVideoUpload);
startBtn.addEventListener("click", () => analyzeVideo().catch(handleError));
downloadBtn.addEventListener("click", downloadCsv);
ocrEngineSelect.addEventListener("change", handleEngineChange);
toggleModeBtn.addEventListener("click", handleToggleMode);

window.addEventListener("beforeunload", () => {
  if (workerPromise) {
    workerPromise.then((worker) => worker.terminate()).catch(() => {});
  }
});

function handleEngineChange() {
  if (
    ocrEngineSelect.value === "paddle" &&
    (!video.src || statusText.textContent === "Load a video to begin.")
  ) {
    statusText.textContent =
      "PaddleOCR は初回実行時にモデルをダウンロードします (通信状況により数十秒かかる場合があります)。";
  } else if (!video.src) {
    statusText.textContent = "Load a video to begin.";
  }
}

function handleToggleMode() {
  if (!video.src) {
    return;
  }
  setSelectionMode(!selectionMode);
}

function setSelectionMode(enabled) {
  selectionMode = enabled;
  selectionCanvas.classList.toggle("selection-disabled", !enabled);
  toggleModeBtn.textContent = enabled
    ? "Selection mode (drag on video)"
    : "Video controls mode (scrub video)";
  toggleModeBtn.setAttribute("aria-pressed", enabled ? "true" : "false");
  if (!enabled) {
    drawing = false;
  }
}

function handleVideoUpload(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  const url = URL.createObjectURL(file);
  resetState();
  video.src = url;
  video.play().catch(() => video.pause());
  statusText.textContent =
    "Pause the video, then drag to select the number region. Use the mode toggle to scrub the video.";
  startBtn.disabled = true;

  video.addEventListener("loadedmetadata", () => {
    fitCanvasToVideo();
    startBtn.disabled = false;
    toggleModeBtn.disabled = false;
    setSelectionMode(true);
  }, { once: true });
}

function fitCanvasToVideo() {
  const rect = video.getBoundingClientRect();
  selectionCanvas.width = video.videoWidth || rect.width;
  selectionCanvas.height = video.videoHeight || rect.height;
  selectionCanvas.style.width = `${rect.width}px`;
  selectionCanvas.style.height = `${rect.height}px`;
  drawSelection();
}

window.addEventListener("resize", fitCanvasToVideo);
video.addEventListener("loadeddata", fitCanvasToVideo);

selectionCanvas.addEventListener("mousedown", (event) => {
  if (!video.src || !selectionMode) return;
  drawing = true;
  const { x, y } = getRelativeCoordinates(event);
  roi = { x, y, width: 0, height: 0 };
  drawSelection();
});

selectionCanvas.addEventListener("mousemove", (event) => {
  if (!drawing || !roi || !selectionMode) return;
  const { x, y } = getRelativeCoordinates(event);
  roi.width = x - roi.x;
  roi.height = y - roi.y;
  drawSelection();
});

["mouseup", "mouseleave"].forEach((type) => {
  selectionCanvas.addEventListener(type, () => {
    drawing = false;
    if (roi && (roi.width === 0 || roi.height === 0)) {
      roi = null;
    }
    drawSelection();
  });
});

function drawSelection() {
  selectionCtx.clearRect(0, 0, selectionCanvas.width, selectionCanvas.height);
  if (!roi) return;

  const normalized = normalizeRoi(roi);
  selectionCtx.strokeStyle = "#ff6b2c";
  selectionCtx.lineWidth = 2;
  selectionCtx.setLineDash([8, 6]);
  selectionCtx.strokeRect(
    normalized.x,
    normalized.y,
    normalized.width,
    normalized.height
  );
  selectionCtx.setLineDash([]);
}

function getRelativeCoordinates(event) {
  const rect = selectionCanvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * selectionCanvas.width;
  const y = ((event.clientY - rect.top) / rect.height) * selectionCanvas.height;
  return { x, y };
}

function normalizeRoi(rawRoi) {
  if (!rawRoi) return null;
  const { x, y, width, height } = rawRoi;
  return {
    x: width < 0 ? x + width : x,
    y: height < 0 ? y + height : y,
    width: Math.abs(width),
    height: Math.abs(height),
  };
}

async function analyzeVideo() {
  if (!video.src) {
    return;
  }
  const normalizedRoi = normalizeRoi(roi);
  if (!normalizedRoi || normalizedRoi.width < 4 || normalizedRoi.height < 4) {
    alert("Please select the region that contains the numeric value.");
    return;
  }

  let minValue = Number(minValueInput.value);
  let maxValue = Number(maxValueInput.value);
  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
    alert("Please enter numeric values for the minimum and maximum.");
    return;
  }
  if (minValue === maxValue) {
    alert("Minimum and maximum cannot be the same value.");
    return;
  }
  if (minValue > maxValue) {
    [minValue, maxValue] = [maxValue, minValue];
    minValueInput.value = minValue;
    maxValueInput.value = maxValue;
  }

  const frameInterval = Math.max(Number(frameStepInput.value) || 0, 16) / 1000;
  const duration = video.duration;
  const steps = Math.ceil(duration / frameInterval) || 1;
  const results = [];
  const engineKey = ocrEngineSelect.value;

  startBtn.disabled = true;
  downloadBtn.disabled = true;
  frameStepInput.disabled = true;
  video.pause();
  statusText.textContent =
    engineKey === "paddle"
      ? "Loading PaddleOCR models…"
      : "Initializing OCR worker…";
  progressEl.value = 0;

  let engineHandle;
  try {
    engineHandle = await ensureOcrEngine(engineKey);
  } catch (error) {
    handleError(error);
    return;
  }

  statusText.textContent = "Analyzing frames…";

  workingCanvas.width = video.videoWidth;
  workingCanvas.height = video.videoHeight;

  for (let step = 0; step <= steps; step += 1) {
    const currentTime = Math.min(step * frameInterval, duration);
    await seekVideo(currentTime);
    const value = await recognizeFrameWithEngine(
      engineKey,
      engineHandle,
      normalizedRoi,
      minValue,
      maxValue
    );
    results.push({
      time: Number(currentTime.toFixed(3)),
      value,
    });
    progressEl.value = duration ? currentTime / duration : 1;
    statusText.textContent = `Processing ${(progressEl.value * 100).toFixed(1)}%`;
  }

  populateResults(results);
  updateChart(results, { minValue, maxValue });

  statusText.textContent = "Done! Review the results below.";
  progressEl.value = 1;
  startBtn.disabled = false;
  downloadBtn.disabled = false;
  frameStepInput.disabled = false;
  downloadBtn.dataset.csv = JSON.stringify(results);
}

async function seekVideo(time) {
  return new Promise((resolve) => {
    const handler = () => {
      video.removeEventListener("seeked", handler);
      resolve();
    };
    video.addEventListener("seeked", handler);
    if (Math.abs(video.currentTime - time) < 0.0001) {
      handler();
    } else {
      video.currentTime = time;
    }
  });
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      statusText.textContent = "Loading OCR engine…";
      const worker = await Tesseract.createWorker();
      statusText.textContent = "Loading language data…";
      await worker.loadLanguage("eng");
      statusText.textContent = "Initializing OCR…";
      await worker.initialize("eng");
      await worker.setParameters({
        tessedit_char_whitelist: "0123456789.-",
        tessedit_pageseg_mode: "6",
        user_defined_dpi: "200",
        classify_bln_numeric_mode: "1",
        preserve_interword_spaces: "1",
      });
      return worker;
    })().catch((error) => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

async function ensureOcrEngine(engineKey) {
  if (engineKey === "paddle") {
    if (!window.paddlejs || !window.paddlejs.ocr) {
      throw new Error(
        "PaddleOCR のスクリプトが読み込めませんでした。ページを再読み込みして再試行してください。"
      );
    }
    return getPaddleRecognizer();
  }
  // default to Tesseract
  return getWorker();
}

async function getPaddleRecognizer() {
  if (!paddleInitPromise) {
    paddleInitPromise = window.paddlejs.ocr.init().catch((error) => {
      paddleInitPromise = null;
      throw error;
    });
  }
  await paddleInitPromise;
  return window.paddlejs.ocr;
}

async function recognizeFrameWithEngine(
  engineKey,
  engineHandle,
  normalizedRoi,
  minValue,
  maxValue
) {
  workingCtx.drawImage(video, 0, 0, workingCanvas.width, workingCanvas.height);
  const { canvas } = prepareScaledCanvas(normalizedRoi, {
    enhance: engineKey === "tesseract",
  });

  if (engineKey === "paddle") {
    const paddleResult = await recognizeWithPaddle(engineHandle, canvas);
    if (paddleResult.parsedValue !== null) {
      return clampToRange(paddleResult.parsedValue, minValue, maxValue);
    }
    console.debug("PaddleOCR returned no numeric match", paddleResult.payload);
    const worker = await getWorker();
    const { canvas: enhancedCanvas } = prepareScaledCanvas(normalizedRoi, {
      enhance: true,
    });
    const fallback = await recognizeWithTesseract(worker, enhancedCanvas);
    if (fallback.parsedValue !== null) {
      return clampToRange(fallback.parsedValue, minValue, maxValue);
    }
    return null;
  }

  const tesseractResult = await recognizeWithTesseract(engineHandle, canvas);
  if (tesseractResult.parsedValue === null) {
    return null;
  }
  return clampToRange(tesseractResult.parsedValue, minValue, maxValue);
}

function enhanceImageData(imageData) {
  const { data, width, height } = imageData;
  let min = 255;
  let max = 0;

  for (let i = 0; i < data.length; i += 4) {
    const gray = toGray(data[i], data[i + 1], data[i + 2]);
    if (gray < min) min = gray;
    if (gray > max) max = gray;
  }

  const spread = max - min || 1;
  const lut = new Array(256);
  for (let i = 0; i < 256; i += 1) {
    const normalized = (i - min) / spread;
    lut[i] = Math.max(0, Math.min(255, Math.round(normalized * 255)));
  }

  const blockSize = Math.max(3, Math.floor(Math.min(width, height) / 8) | 1);
  const thresholdMap = computeAdaptiveThresholdMap(data, width, height, blockSize);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      const gray = lut[toGray(data[idx], data[idx + 1], data[idx + 2])];
      const threshold = thresholdMap[y * width + x];
      const binary = gray > threshold ? 255 : 0;
      data[idx] = data[idx + 1] = data[idx + 2] = binary;
    }
  }
}

function toGray(r, g, b) {
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

function computeAdaptiveThresholdMap(data, width, height, blockSize) {
  const pitch = width + 1;
  const integral = new Float32Array(pitch * (height + 1));
  for (let y = 1; y <= height; y += 1) {
    let rowSum = 0;
    const base = (y - 1) * width;
    for (let x = 1; x <= width; x += 1) {
      const idx = (base + (x - 1)) * 4;
      const gray = toGray(data[idx], data[idx + 1], data[idx + 2]);
      rowSum += gray;
      const integralIdx = y * pitch + x;
      integral[integralIdx] = integral[integralIdx - pitch] + rowSum;
    }
  }

  const half = Math.floor(blockSize / 2);
  const thresholdMap = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(height - 1, y + half);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(width - 1, x + half);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        integral[(y1 + 1) * pitch + (x1 + 1)] -
        integral[(y1 + 1) * pitch + x0] -
        integral[y0 * pitch + (x1 + 1)] +
        integral[y0 * pitch + x0];
      const threshold = sum / count;
      thresholdMap[y * width + x] = threshold * 0.9;
    }
  }

  return thresholdMap;
}

function expandRoi(roi, maxWidth, maxHeight, paddingFactor = 0.1) {
  const padX = Math.max(2, Math.round(roi.width * paddingFactor));
  const padY = Math.max(2, Math.round(roi.height * paddingFactor));
  const x = Math.max(0, Math.floor(roi.x - padX));
  const y = Math.max(0, Math.floor(roi.y - padY));
  const width = Math.min(maxWidth - x, Math.ceil(roi.width + padX * 2));
  const height = Math.min(maxHeight - y, Math.ceil(roi.height + padY * 2));
  return { x, y, width, height };
}

function prepareScaledCanvas(normalizedRoi, { enhance }) {
  const expandedRoi = expandRoi(
    normalizedRoi,
    workingCanvas.width,
    workingCanvas.height,
    ROI_PADDING_FACTOR
  );
  const { x, y, width, height } = expandedRoi;

  roiCanvas.width = Math.max(1, width);
  roiCanvas.height = Math.max(1, height);

  if (enhance) {
    const imageData = workingCtx.getImageData(x, y, width, height);
    enhanceImageData(imageData);
    roiCtx.putImageData(imageData, 0, 0);
  } else {
    roiCtx.drawImage(
      workingCanvas,
      x,
      y,
      width,
      height,
      0,
      0,
      width,
      height
    );
  }

  const scaledWidth = Math.max(1, Math.round(width * ROI_SCALE_FACTOR));
  const scaledHeight = Math.max(1, Math.round(height * ROI_SCALE_FACTOR));
  scaledCanvas.width = scaledWidth;
  scaledCanvas.height = scaledHeight;
  scaledCtx.imageSmoothingEnabled = false;
  scaledCtx.drawImage(roiCanvas, 0, 0, scaledWidth, scaledHeight);

  return { canvas: scaledCanvas, roi: expandedRoi };
}

function extractTextFromPaddleResult(result) {
  if (!result) {
    return "";
  }
  if (typeof result === "string") {
    return result;
  }
  if (Array.isArray(result)) {
    return result
      .map((item) => extractTextFromPaddleResult(item))
      .filter(Boolean)
      .join(" ");
  }
  if (typeof result === "object") {
    if (typeof result.text === "string") {
      return result.text;
    }
    if (Array.isArray(result.text)) {
      return result.text.filter(Boolean).join(" ");
    }
    if (typeof result.data === "string") {
      return result.data;
    }
    if (Array.isArray(result.data)) {
      return result.data.filter(Boolean).join(" ");
    }
    if (Array.isArray(result.result)) {
      return result.result
        .map((item) => extractTextFromPaddleResult(item))
        .filter(Boolean)
        .join(" ");
    }
  }
  return "";
}

function parseNumericValue(rawText) {
  if (!rawText) {
    return null;
  }
  const text = Array.isArray(rawText) ? rawText.join(" ") : String(rawText);
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }
  const value = Number(match[0]);
  return Number.isNaN(value) ? null : value;
}

function createImageFromCanvas(canvas) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (error) => reject(error);
    img.src = canvas.toDataURL("image/png");
  });
}

function clampToRange(value, minValue, maxValue) {
  return Math.min(Math.max(value, minValue), maxValue);
}

async function recognizeWithPaddle(recognizer, canvas) {
  try {
    const imageElement = await createImageFromCanvas(canvas);
    const payload = await recognizer.recognize(imageElement);
    const rawText = extractTextFromPaddleResult(payload);
    return {
      parsedValue: parseNumericValue(rawText),
      rawText,
      payload,
    };
  } catch (error) {
    console.warn("PaddleOCR recognize failed", error);
    return { parsedValue: null, rawText: null, payload: null };
  }
}

async function recognizeWithTesseract(worker, canvas) {
  try {
    const payload = await worker.recognize(canvas);
    const rawText = payload?.data?.text ?? "";
    return {
      parsedValue: parseNumericValue(rawText),
      rawText,
      payload,
    };
  } catch (error) {
    console.warn("Tesseract recognize failed", error);
    return { parsedValue: null, rawText: null, payload: null };
  }
}

function populateResults(results) {
  resultsBody.innerHTML = "";
  const fragment = document.createDocumentFragment();
  results.forEach(({ time, value }) => {
    const row = document.createElement("tr");
    const timeCell = document.createElement("td");
    const valueCell = document.createElement("td");
    timeCell.textContent = time.toFixed(2);
    valueCell.textContent = value === null ? "–" : value.toString();
    row.append(timeCell, valueCell);
    fragment.appendChild(row);
  });
  resultsBody.appendChild(fragment);
}

function updateChart(results, { minValue, maxValue }) {
  const labels = results.map((item) => item.time);
  const data = results.map((item) => item.value);
  const rangeLabel = `${formatNumber(minValue)}-${formatNumber(maxValue)}`;
  if (!chart) {
    chart = new Chart(chartCanvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Recognized value",
            data,
            borderColor: "#ff6b2c",
            backgroundColor: "rgba(255, 107, 44, 0.25)",
            tension: 0.25,
            pointRadius: 0,
            spanGaps: true,
          },
        ],
      },
      options: {
        responsive: true,
        scales: {
          y: {
            min: minValue,
            max: maxValue,
            title: {
              display: true,
              text: `Value (${rangeLabel})`,
            },
          },
          x: {
            title: {
              display: true,
              text: "Time (s)",
            },
          },
        },
        plugins: {
          legend: {
            display: false,
          },
        },
      },
    });
  } else {
    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    chart.options.scales.y.min = minValue;
    chart.options.scales.y.max = maxValue;
    chart.options.scales.y.title.text = `Value (${rangeLabel})`;
    chart.update();
  }
}

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return "";
  }
  return Number.isInteger(value) ? value.toString() : value.toFixed(2);
}

function downloadCsv() {
  const encoded = downloadBtn.dataset.csv;
  if (!encoded) return;
  const results = JSON.parse(encoded);
  const header = "time_seconds,value";
  const rows = results
    .map(({ time, value }) => `${time.toFixed(3)},${value ?? ""}`)
    .join("\n");
  const blob = new Blob([`${header}\n${rows}`], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "throttle-data.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function resetState() {
  roi = null;
  drawing = false;
  drawSelection();
  resultsBody.innerHTML = "";
  if (chart) {
    chart.destroy();
    chart = null;
  }
  progressEl.value = 0;
  statusText.textContent = "Load a video to begin.";
  startBtn.disabled = true;
  frameStepInput.disabled = false;
  downloadBtn.disabled = true;
  downloadBtn.dataset.csv = "";
  setSelectionMode(true);
  toggleModeBtn.disabled = true;
}

function handleError(error) {
  console.error(error);
  statusText.textContent = "Something went wrong. Check the console for details.";
  startBtn.disabled = false;
  frameStepInput.disabled = false;
  downloadBtn.disabled = true;
}

setSelectionMode(true);
toggleModeBtn.disabled = true;
