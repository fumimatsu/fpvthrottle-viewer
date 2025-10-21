const videoInput = document.getElementById("video-input");
const video = document.getElementById("video");
const selectionCanvas = document.getElementById("selection-canvas");
const selectionCtx = selectionCanvas.getContext("2d");
const frameStepInput = document.getElementById("frame-step");
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

const workingCanvas = document.createElement("canvas");
const workingCtx = workingCanvas.getContext("2d", { willReadFrequently: true });

const roiCanvas = document.createElement("canvas");
const roiCtx = roiCanvas.getContext("2d", { willReadFrequently: true });

videoInput.addEventListener("change", handleVideoUpload);
startBtn.addEventListener("click", () => analyzeVideo().catch(handleError));
downloadBtn.addEventListener("click", downloadCsv);

window.addEventListener("beforeunload", () => {
  if (workerPromise) {
    workerPromise.then((worker) => worker.terminate()).catch(() => {});
  }
});

function handleVideoUpload(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  const url = URL.createObjectURL(file);
  resetState();
  video.src = url;
  video.play().catch(() => video.pause());
  statusText.textContent = "Pause the video and drag to select the number region.";
  startBtn.disabled = true;

  video.addEventListener("loadedmetadata", () => {
    fitCanvasToVideo();
    startBtn.disabled = false;
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
  if (!video.src) return;
  drawing = true;
  const { x, y } = getRelativeCoordinates(event);
  roi = { x, y, width: 0, height: 0 };
  drawSelection();
});

selectionCanvas.addEventListener("mousemove", (event) => {
  if (!drawing || !roi) return;
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
    alert("Please select the region that contains the numeric throttle indicator.");
    return;
  }

  const frameInterval = Math.max(Number(frameStepInput.value) || 0, 16) / 1000;
  const duration = video.duration;
  const steps = Math.ceil(duration / frameInterval) || 1;
  const results = [];

  startBtn.disabled = true;
  downloadBtn.disabled = true;
  frameStepInput.disabled = true;
  video.pause();
  statusText.textContent = "Initializing OCR worker…";
  progressEl.value = 0;

  const worker = await getWorker();

  statusText.textContent = "Analyzing frames…";

  workingCanvas.width = video.videoWidth;
  workingCanvas.height = video.videoHeight;

  for (let step = 0; step <= steps; step += 1) {
    const currentTime = Math.min(step * frameInterval, duration);
    await seekVideo(currentTime);
    const value = await recognizeFrame(worker, normalizedRoi);
    results.push({
      time: Number(currentTime.toFixed(3)),
      value,
    });
    progressEl.value = duration ? currentTime / duration : 1;
    statusText.textContent = `Processing ${(progressEl.value * 100).toFixed(1)}%`;
  }

  populateResults(results);
  updateChart(results);

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
        tessedit_char_whitelist: "0123456789",
        classify_bln_numeric_mode: "1",
      });
      return worker;
    })().catch((error) => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

async function recognizeFrame(worker, normalizedRoi) {
  workingCtx.drawImage(video, 0, 0, workingCanvas.width, workingCanvas.height);
  const { x, y, width, height } = normalizedRoi;
  const imageData = workingCtx.getImageData(x, y, width, height);
  enhanceImageData(imageData);
  roiCanvas.width = width;
  roiCanvas.height = height;
  roiCtx.putImageData(imageData, 0, 0);
  const { data } = await worker.recognize(roiCanvas);
  const digits = data.text.match(/\d+/);
  if (!digits) {
    return null;
  }
  const value = Number(digits[0]);
  if (Number.isNaN(value)) {
    return null;
  }
  return Math.min(Math.max(value, 0), 100);
}

function enhanceImageData(imageData) {
  const { data } = imageData;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    const threshold = gray > 140 ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = threshold;
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

function updateChart(results) {
  const labels = results.map((item) => item.time);
  const data = results.map((item) => item.value);
  if (!chart) {
    chart = new Chart(chartCanvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Throttle",
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
            beginAtZero: true,
            max: 100,
            ticks: {
              stepSize: 10,
            },
            title: {
              display: true,
              text: "Throttle (0-100)",
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
    chart.update();
  }
}

function downloadCsv() {
  const encoded = downloadBtn.dataset.csv;
  if (!encoded) return;
  const results = JSON.parse(encoded);
  const header = "time_seconds,throttle";
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
}

function handleError(error) {
  console.error(error);
  statusText.textContent = "Something went wrong. Check the console for details.";
  startBtn.disabled = false;
  frameStepInput.disabled = false;
  downloadBtn.disabled = true;
}
