/* ============================================================
 *  SISTEM MONITORING PASANG SURUT AIR LAUT
 *  Frontend Logic — Firebase Realtime DB + Fallback Simulasi
 * ============================================================
 *  Alur data:
 *    Sensor JSN-SR04 → ESP32 → WiFi → Firebase RTDB → Web ini
 *  
 *  Jika Firebase belum dikonfigurasi, web otomatis menggunakan
 *  data simulasi (model sinusoidal semidiurnal).
 * ============================================================
 */

// ===================== KONFIGURASI =====================
const CONFIG = {
  TINGGI_SENSOR: 100.0,     // cm - tinggi sensor dari dasar
  BATAS_NORMAL: 50.0,       // di bawah 50 cm = NORMAL
  BATAS_WASPADA: 50.0,      // 50 cm = mulai WASPADA
  BATAS_BAHAYA: 80.0,       // 80 cm = mulai BAHAYA
  MAX_TINGGI: 100.0,        // tinggi maksimum gauge
  UPDATE_INTERVAL: 2000,    // interval update simulasi (ms)
  HISTORY_POINTS: 144,      // 24 jam × 6 per jam (setiap 10 menit)
  PREDICTION_POINTS: 144,   // 24 jam ke depan
  TABLE_ROWS: 50,           // jumlah baris tabel
};

// ============= KONFIGURASI FIREBASE =====================
// Konfigurasi Firebase Project: waterlevel-esp-54d3a
// Harus SAMA dengan konfigurasi di Arduino (test2new.ino)
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAXYuOuhIkCpy6W2Y7fWph8uACz_WDAxUs",
  authDomain: "waterlevel-esp-54d3a.firebaseapp.com",
  databaseURL: "https://waterlevel-esp-54d3a-default-rtdb.firebaseio.com",
  projectId: "waterlevel-esp-54d3a",
  storageBucket: "waterlevel-esp-54d3a.appspot.com",
  messagingSenderId: "",
  appId: ""
};

// =================== MODEL PASANG SURUT ===================
// Simulasi semidiurnal tide (2 pasang + 2 surut per hari)
// Digunakan sebagai FALLBACK jika Firebase belum dikonfigurasi
const TIDE_MODEL = {
  amplitude1: 25,           // M2 - semidiurnal lunar
  period1: 12.42 * 3600,
  phase1: 0,

  amplitude2: 8,            // S2 - semidiurnal solar
  period2: 12.0 * 3600,
  phase2: Math.PI / 4,

  amplitude3: 5,            // K1 - diurnal
  period3: 23.93 * 3600,
  phase3: Math.PI / 3,

  baseline: 45,
  noise: 1.5,
};

// ===================== STATE =====================
let historyData = [];
let predictionData = [];
let currentTinggiAir = 0;
let previousTinggiAir = 0;
let tableData = [];
let historyChart = null;
let predictionChart = null;
let currentHistoryRange = '24h';

// Firebase state
let firebaseConnected = false;
let useFirebase = false;
let firebaseDB = null;
let simulationInterval = null;

// Daily history state
let dailyHistoryChart = null;
let dailyHistoryData = [];
let selectedDateKey = '';
let dailyHistoryListener = null;
let availableHistoryDates = [];
let availableHistoryCounts = {};

// ===================== INITIALIZATION =====================
document.addEventListener('DOMContentLoaded', () => {
  // Coba inisialisasi Firebase
  initFirebase();

  // Inisialisasi komponen UI
  drawGauge(0);
  createHistoryChart();
  createPredictionChart();
  createDailyHistoryChart();
  initDailyHistory();
  updateClock();

  // Clock selalu jalan
  setInterval(updateClock, 1000);
});

// ===================== FIREBASE INIT =====================
function initFirebase() {
  // Cek apakah konfigurasi Firebase sudah diisi
  if (FIREBASE_CONFIG.apiKey === "MASUKKAN_API_KEY_ANDA" ||
      FIREBASE_CONFIG.databaseURL.includes("nama-project-anda")) {
    console.log("⚠️ Firebase belum dikonfigurasi. Menggunakan data simulasi.");
    setConnectionStatus('simulasi');
    startSimulationMode();
    return;
  }

  try {
    // Inisialisasi Firebase
    const app = firebase.initializeApp(FIREBASE_CONFIG);
    firebaseDB = firebase.database();

    console.log("🔥 Firebase terinitialisasi, mencoba koneksi...");
    setConnectionStatus('connecting');

    // Monitor status koneksi Firebase
    const connectedRef = firebaseDB.ref(".info/connected");
    connectedRef.on("value", (snap) => {
      if (snap.val() === true) {
        console.log("✅ Firebase terhubung!");
        firebaseConnected = true;
        useFirebase = true;
        setConnectionStatus('connected');

        // Stop simulasi jika sedang jalan
        if (simulationInterval) {
          clearInterval(simulationInterval);
          simulationInterval = null;
        }

        // Mulai listen data dari Firebase
        listenRealtimeData();
        loadHistoryData();
        fetchAvailableHistoryDates();
      } else {
        console.log("❌ Firebase terputus, fallback ke simulasi.");
        firebaseConnected = false;
        setConnectionStatus('disconnected');

        // Fallback ke simulasi
        if (!simulationInterval) {
          startSimulationMode();
        }
      }
    });

  } catch (error) {
    console.error("❌ Firebase error:", error);
    setConnectionStatus('error');
    startSimulationMode();
  }
}

// ============= CONNECTION STATUS INDICATOR ===============
function setConnectionStatus(status) {
  const dot = document.getElementById('connectionDot');
  const text = document.getElementById('connectionStatus');

  switch (status) {
    case 'connected':
      dot.style.background = '#10b981';
      text.textContent = '🔥 Firebase Live';
      text.style.color = '#10b981';
      break;
    case 'connecting':
      dot.style.background = '#f59e0b';
      text.textContent = '⏳ Menghubungkan...';
      text.style.color = '#f59e0b';
      break;
    case 'disconnected':
      dot.style.background = '#ef4444';
      text.textContent = '⚡ Offline (Simulasi)';
      text.style.color = '#ef4444';
      break;
    case 'simulasi':
      dot.style.background = '#8b5cf6';
      text.textContent = '🧪 Mode Simulasi';
      text.style.color = '#8b5cf6';
      break;
    case 'error':
      dot.style.background = '#ef4444';
      text.textContent = '❌ Firebase Error';
      text.style.color = '#ef4444';
      break;
  }
}

// ============= FIREBASE: LISTEN REALTIME DATA ============
function listenRealtimeData() {
  if (!firebaseDB) return;

  const realtimeRef = firebaseDB.ref('/realtime');

  realtimeRef.on('value', (snapshot) => {
    const data = snapshot.val();
    if (!data) {
      console.log("📭 Belum ada data realtime di Firebase.");
      return;
    }

    console.log("📡 Data realtime diterima:", data);

    previousTinggiAir = currentTinggiAir;
    currentTinggiAir = parseFloat(data.tinggiAir) || 0;
    const jarakSensor = parseFloat(data.jarakSensor) || 0;
    const status = data.status || getStatus(currentTinggiAir);
    const tinggiMin = parseFloat(data.tinggiAirMin) || currentTinggiAir;
    const tinggiMax = parseFloat(data.tinggiAirMax) || currentTinggiAir;

    // Update gauge
    drawGauge(currentTinggiAir);
    document.getElementById('gaugeNumber').textContent = currentTinggiAir.toFixed(1);

    // Update status badge
    const badge = document.getElementById('statusBadge');
    badge.className = `status-badge ${getStatusClass(status)}`;
    document.getElementById('statusText').textContent = status;

    // Update jarak sensor
    document.getElementById('jarakSensor').textContent = `${jarakSensor.toFixed(1)} cm`;

    // Update trend
    updateTrend(currentTinggiAir, previousTinggiAir);

    // Update threshold bars
    updateThresholdBars(currentTinggiAir);

    // Update stats dari Firebase min/max
    document.getElementById('statMin').textContent = tinggiMin.toFixed(1);
    document.getElementById('statMax').textContent = tinggiMax.toFixed(1);

    // Tambah ke history lokal (untuk chart realtime)
    const now = new Date();
    historyData.push({ time: now, height: currentTinggiAir });
    if (historyData.length > CONFIG.HISTORY_POINTS + 50) {
      historyData = historyData.slice(-CONFIG.HISTORY_POINTS - 50);
    }

    // Tambah ke table data
    tableData.push({
      time: now,
      height: currentTinggiAir,
      jarak: jarakSensor,
      status: status
    });
    if (tableData.length > CONFIG.TABLE_ROWS) {
      tableData = tableData.slice(-CONFIG.TABLE_ROWS);
    }

    // Update avg
    if (historyData.length > 0) {
      const heights = historyData.map(d => d.height);
      const avg = heights.reduce((a, b) => a + b, 0) / heights.length;
      document.getElementById('statAvg').textContent = avg.toFixed(1);
    }

    // Update charts
    updateHistoryChart();
    updatePredictionFromData();
    updateTable();
  });
}

// ============= FIREBASE: LOAD HISTORY DATA ===============
// Membaca history dari Firebase — flexible parser
function loadHistoryData() {
  if (!firebaseDB) return;

  // Hitung tanggal hari ini dan kemarin (untuk 24 jam history)
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const dates = [
    formatDateKey(yesterday),
    formatDateKey(today)
  ];

  console.log(`📚 Memuat history untuk: ${dates.join(', ')}`);

  let allHistory = [];

  dates.forEach(dateKey => {
    // Listen pada level tanggal — ini mencakup semua jam di dalamnya
    const historyRef = firebaseDB.ref(`/history/${dateKey}`);

    historyRef.on('value', (snapshot) => {
      const dayData = snapshot.val();
      
      // Hapus data lama dari tanggal ini sebelum menambah yang baru
      allHistory = allHistory.filter(d => {
        const dKey = formatDateKey(d.time);
        return dKey !== dateKey;
      });

      if (dayData) {
        // Gunakan flexible parser (sama seperti daily history)
        const parsed = parseHistoryEntries(dayData);
        allHistory.push(...parsed);
        console.log(`📚 [${dateKey}] ${parsed.length} entries dimuat.`);
      } else {
        console.log(`📭 [${dateKey}] Belum ada data history.`);
      }

      // Sort semua data berdasarkan waktu
      allHistory.sort((a, b) => a.time - b.time);

      // Merge dengan existing local data (tanpa duplikasi)
      if (allHistory.length > 0) {
        const lastFirebaseTime = allHistory[allHistory.length - 1].time.getTime();
        const localOnlyData = historyData.filter(d => d.time.getTime() > lastFirebaseTime);
        historyData = [...allHistory, ...localOnlyData];
      }

      // Update stats
      updateStats();

      // Update charts
      updateHistoryChart();
      updatePredictionFromData();

      // Update table dari history — selalu sinkronkan dengan data terbaru
      if (allHistory.length > 0) {
        // Gabungkan history Firebase dengan data realtime lokal yang lebih baru
        const allData = [...historyData];
        tableData = allData.slice(-CONFIG.TABLE_ROWS).map(d => ({
          time: d.time,
          height: d.height,
          jarak: parseFloat((CONFIG.TINGGI_SENSOR - d.height).toFixed(1)),
          status: getStatus(d.height)
        }));
        updateTable();
      }
    });
  });
}

// Flexible parser untuk history — mengembalikan array {time, height}
function parseHistoryEntries(data) {
  const results = [];
  if (!data || typeof data !== 'object') return results;

  function tryAddEntry(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (!isDataEntry(obj)) return false;

    let time = null;
    if (obj.timestamp) {
      const ts = Number(obj.timestamp);
      if (ts > 1e12) time = new Date(ts);
      else if (ts > 1e9) time = new Date(ts * 1000);
    }
    if (!time && obj.waktu) time = new Date(obj.waktu);
    if (!time && obj.time) time = new Date(obj.time);
    if (!time && obj.date) time = new Date(obj.date);

    if (!time || isNaN(time.getTime())) return false;

    const height = parseFloat(
      obj.tinggiAir ?? obj.waterLevel ?? obj.level ??
      obj.height ?? obj.tinggi ?? obj.water_level ?? 0
    );

    results.push({
      time: time,
      height: isNaN(height) ? 0 : height
    });
    return true;
  }

  // Coba parse hingga 3 level kedalaman
  Object.values(data).forEach(v1 => {
    if (tryAddEntry(v1)) return;
    if (!v1 || typeof v1 !== 'object') return;
    Object.values(v1).forEach(v2 => {
      if (tryAddEntry(v2)) return;
      if (!v2 || typeof v2 !== 'object') return;
      Object.values(v2).forEach(v3 => {
        tryAddEntry(v3);
      });
    });
  });

  return results;
}

// Helper: Format Date ke string YYYY-MM-DD
function formatDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ============= PREDICTION FROM ACTUAL DATA ===============
function updatePredictionFromData() {
  const now = Date.now();
  const tenMinutes = 10 * 60 * 1000;

  // Jika ada cukup data history, hitung baseline dari data aktual
  let baseline = TIDE_MODEL.baseline;
  if (historyData.length >= 12) {
    const recentHeights = historyData.slice(-12).map(d => d.height);
    baseline = recentHeights.reduce((a, b) => a + b, 0) / recentHeights.length;
  }

  predictionData = [];
  for (let i = 0; i <= CONFIG.PREDICTION_POINTS; i++) {
    const timestamp = now + (i * tenMinutes);
    const height = calculateTideHeightWithBaseline(timestamp, baseline);
    predictionData.push({
      time: new Date(timestamp),
      height: parseFloat(height.toFixed(1))
    });
  }

  updatePredictionChart();
}

function calculateTideHeightWithBaseline(timestamp, baseline) {
  const t = timestamp / 1000;

  const h1 = TIDE_MODEL.amplitude1 * Math.sin((2 * Math.PI * t) / TIDE_MODEL.period1 + TIDE_MODEL.phase1);
  const h2 = TIDE_MODEL.amplitude2 * Math.sin((2 * Math.PI * t) / TIDE_MODEL.period2 + TIDE_MODEL.phase2);
  const h3 = TIDE_MODEL.amplitude3 * Math.sin((2 * Math.PI * t) / TIDE_MODEL.period3 + TIDE_MODEL.phase3);

  const height = baseline + h1 + h2 + h3;
  return Math.max(0, Math.min(CONFIG.MAX_TINGGI, height));
}

// ===================== SIMULATION MODE =====================
// Fallback ketika Firebase belum dikonfigurasi
function startSimulationMode() {
  console.log("🧪 Memulai mode simulasi...");
  useFirebase = false;

  // Generate initial data
  initializeSimulationData();

  // Update pertama
  updateDashboardSimulation();

  // Start interval
  simulationInterval = setInterval(updateDashboardSimulation, CONFIG.UPDATE_INTERVAL);
}

function initializeSimulationData() {
  const now = Date.now();
  const tenMinutes = 10 * 60 * 1000;

  // Generate 24 jam history
  historyData = [];
  for (let i = CONFIG.HISTORY_POINTS - 1; i >= 0; i--) {
    const timestamp = now - (i * tenMinutes);
    const height = calculateTideWithNoise(timestamp);
    historyData.push({
      time: new Date(timestamp),
      height: parseFloat(height.toFixed(1))
    });
  }

  // Generate prediction
  predictionData = [];
  for (let i = 0; i <= CONFIG.PREDICTION_POINTS; i++) {
    const timestamp = now + (i * tenMinutes);
    const height = calculateTideHeight(timestamp);
    predictionData.push({
      time: new Date(timestamp),
      height: parseFloat(height.toFixed(1))
    });
  }

  // Generate table data
  tableData = [];
  for (let i = CONFIG.TABLE_ROWS - 1; i >= 0; i--) {
    const timestamp = now - (i * 2 * 60 * 1000);
    const height = calculateTideWithNoise(timestamp);
    const jarak = CONFIG.TINGGI_SENSOR - height;
    tableData.push({
      time: new Date(timestamp),
      height: parseFloat(height.toFixed(1)),
      jarak: parseFloat(jarak.toFixed(1)),
      status: getStatus(height)
    });
  }

  currentTinggiAir = historyData[historyData.length - 1].height;
  previousTinggiAir = historyData[historyData.length - 2].height;
}

function updateDashboardSimulation() {
  const now = Date.now();

  previousTinggiAir = currentTinggiAir;
  currentTinggiAir = calculateTideWithNoise(now);
  currentTinggiAir = parseFloat(currentTinggiAir.toFixed(1));

  const jarakSensor = parseFloat((CONFIG.TINGGI_SENSOR - currentTinggiAir).toFixed(1));
  const status = getStatus(currentTinggiAir);

  // Update gauge
  drawGauge(currentTinggiAir);
  document.getElementById('gaugeNumber').textContent = currentTinggiAir.toFixed(1);

  // Update status badge
  const badge = document.getElementById('statusBadge');
  badge.className = `status-badge ${getStatusClass(status)}`;
  document.getElementById('statusText').textContent = status;

  // Update jarak sensor
  document.getElementById('jarakSensor').textContent = `${jarakSensor} cm`;

  // Update trend
  updateTrend(currentTinggiAir, previousTinggiAir);

  // Update threshold bars
  updateThresholdBars(currentTinggiAir);

  // Update history
  historyData.push({ time: new Date(now), height: currentTinggiAir });
  if (historyData.length > CONFIG.HISTORY_POINTS + 50) {
    historyData = historyData.slice(-CONFIG.HISTORY_POINTS - 50);
  }

  // Update table
  tableData.push({
    time: new Date(now),
    height: currentTinggiAir,
    jarak: jarakSensor,
    status: status
  });
  if (tableData.length > CONFIG.TABLE_ROWS) {
    tableData = tableData.slice(-CONFIG.TABLE_ROWS);
  }

  // Update stats
  updateStats();

  // Update charts
  updateHistoryChart();

  // Update prediction
  updatePredictionSimulation();
  updatePredictionChart();

  // Update table
  updateTable();
}

function updatePredictionSimulation() {
  const now = Date.now();
  const tenMinutes = 10 * 60 * 1000;

  predictionData = [];
  for (let i = 0; i <= CONFIG.PREDICTION_POINTS; i++) {
    const timestamp = now + (i * tenMinutes);
    const height = calculateTideHeight(timestamp);
    predictionData.push({
      time: new Date(timestamp),
      height: parseFloat(height.toFixed(1))
    });
  }
}

// ===================== CLOCK =====================
function updateClock() {
  const now = new Date();

  const timeStr = now.toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const dateStr = now.toLocaleDateString('id-ID', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });

  document.getElementById('clock').textContent = timeStr;
  document.getElementById('date').textContent = dateStr;
}

// ===================== TIDE CALCULATION =====================
function calculateTideHeight(timestamp) {
  const t = timestamp / 1000;

  const h1 = TIDE_MODEL.amplitude1 * Math.sin((2 * Math.PI * t) / TIDE_MODEL.period1 + TIDE_MODEL.phase1);
  const h2 = TIDE_MODEL.amplitude2 * Math.sin((2 * Math.PI * t) / TIDE_MODEL.period2 + TIDE_MODEL.phase2);
  const h3 = TIDE_MODEL.amplitude3 * Math.sin((2 * Math.PI * t) / TIDE_MODEL.period3 + TIDE_MODEL.phase3);

  const height = TIDE_MODEL.baseline + h1 + h2 + h3;
  return Math.max(0, Math.min(CONFIG.MAX_TINGGI, height));
}

function calculateTideWithNoise(timestamp) {
  const base = calculateTideHeight(timestamp);
  const noise = (Math.random() - 0.5) * 2 * TIDE_MODEL.noise;
  return Math.max(0, Math.min(CONFIG.MAX_TINGGI, base + noise));
}

// ===================== STATUS =====================
function getStatus(height) {
  if (height >= CONFIG.BATAS_BAHAYA) return 'BAHAYA';
  if (height >= CONFIG.BATAS_WASPADA) return 'WASPADA';
  return 'NORMAL';
}

function getStatusClass(status) {
  return status.toLowerCase();
}

// ===================== TREND =====================
function updateTrend(current, previous) {
  const diff = current - previous;
  const indicator = document.getElementById('trendIndicator');
  const icon = document.getElementById('trendIcon');
  const text = document.getElementById('trendText');

  if (diff > 0.3) {
    indicator.className = 'trend up';
    icon.textContent = '↑';
    text.textContent = `Naik +${diff.toFixed(1)} cm`;
  } else if (diff < -0.3) {
    indicator.className = 'trend down';
    icon.textContent = '↓';
    text.textContent = `Turun ${diff.toFixed(1)} cm`;
  } else {
    indicator.className = 'trend stable';
    icon.textContent = '→';
    text.textContent = 'Stabil';
  }
}

// ===================== THRESHOLD BARS =====================
function updateThresholdBars(height) {
  const normalPct = Math.min(100, (Math.min(height, CONFIG.BATAS_WASPADA) / CONFIG.BATAS_WASPADA) * 100);
  const waspadaPct = height >= CONFIG.BATAS_WASPADA
    ? Math.min(100, ((Math.min(height, CONFIG.BATAS_BAHAYA) - CONFIG.BATAS_WASPADA) / (CONFIG.BATAS_BAHAYA - CONFIG.BATAS_WASPADA)) * 100)
    : 0;
  const bahayaPct = height >= CONFIG.BATAS_BAHAYA
    ? Math.min(100, ((height - CONFIG.BATAS_BAHAYA) / (CONFIG.MAX_TINGGI - CONFIG.BATAS_BAHAYA)) * 100)
    : 0;

  document.getElementById('barNormal').style.width = `${normalPct}%`;
  document.getElementById('barWaspada').style.width = `${waspadaPct}%`;
  document.getElementById('barBahaya').style.width = `${bahayaPct}%`;
}

// ===================== STATISTICS =====================
function updateStats() {
  const heights = historyData.map(d => d.height);
  if (heights.length === 0) return;

  const min = Math.min(...heights);
  const max = Math.max(...heights);
  const avg = heights.reduce((a, b) => a + b, 0) / heights.length;

  document.getElementById('statMin').textContent = min.toFixed(1);
  document.getElementById('statMax').textContent = max.toFixed(1);
  document.getElementById('statAvg').textContent = avg.toFixed(1);
}

// ===================== GAUGE DRAWING =====================
function drawGauge(value) {
  const canvas = document.getElementById('gaugeCanvas');
  const ctx = canvas.getContext('2d');

  const width = canvas.width;
  const height = canvas.height;
  const centerX = width / 2;
  const centerY = height - 20;
  const radius = Math.min(centerX, centerY) - 20;

  ctx.clearRect(0, 0, width, height);

  const startAngle = Math.PI;
  const endAngle = 2 * Math.PI;
  const valueAngle = startAngle + ((value / CONFIG.MAX_TINGGI) * Math.PI);

  // Background arc
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, startAngle, endAngle);
  ctx.lineWidth = 20;
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
  ctx.lineCap = 'round';
  ctx.stroke();

  // Tick marks
  for (let i = 0; i <= 10; i++) {
    const angle = startAngle + (i / 10) * Math.PI;
    const tickStart = radius - 30;
    const tickEnd = radius - 22;

    const x1 = centerX + tickStart * Math.cos(angle);
    const y1 = centerY + tickStart * Math.sin(angle);
    const x2 = centerX + tickEnd * Math.cos(angle);
    const y2 = centerY + tickEnd * Math.sin(angle);

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineWidth = i % 5 === 0 ? 2 : 1;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
    ctx.stroke();

    if (i % 5 === 0) {
      const labelDist = radius - 40;
      const lx = centerX + labelDist * Math.cos(angle);
      const ly = centerY + labelDist * Math.sin(angle);
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.fillStyle = 'rgba(148, 163, 184, 0.5)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((i * 10).toString(), lx, ly);
    }
  }

  // Colored segments
  const normalEnd = startAngle + (CONFIG.BATAS_WASPADA / CONFIG.MAX_TINGGI) * Math.PI;
  const waspadaEnd = startAngle + (CONFIG.BATAS_BAHAYA / CONFIG.MAX_TINGGI) * Math.PI;
  drawArcSegment(ctx, centerX, centerY, radius, startAngle, normalEnd, '#10b981', 0.4);
  drawArcSegment(ctx, centerX, centerY, radius, normalEnd, waspadaEnd, '#f59e0b', 0.4);
  drawArcSegment(ctx, centerX, centerY, radius, waspadaEnd, endAngle, '#ef4444', 0.4);

  // Value arc with gradient
  if (value > 0) {
    const gradient = ctx.createLinearGradient(
      centerX - radius, centerY,
      centerX + radius, centerY
    );

    if (value < CONFIG.BATAS_WASPADA) {
      gradient.addColorStop(0, '#10b981');
      gradient.addColorStop(1, '#14b8a6');
    } else if (value < CONFIG.BATAS_BAHAYA) {
      gradient.addColorStop(0, '#10b981');
      gradient.addColorStop(0.5, '#f59e0b');
      gradient.addColorStop(1, '#f59e0b');
    } else {
      gradient.addColorStop(0, '#10b981');
      gradient.addColorStop(0.4, '#f59e0b');
      gradient.addColorStop(0.8, '#ef4444');
      gradient.addColorStop(1, '#ef4444');
    }

    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, startAngle, valueAngle);
    ctx.lineWidth = 20;
    ctx.strokeStyle = gradient;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Glow effect
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, startAngle, valueAngle);
    ctx.lineWidth = 24;
    const glowColor = value >= CONFIG.BATAS_BAHAYA ? 'rgba(239, 68, 68, 0.2)'
                    : value >= CONFIG.BATAS_WASPADA ? 'rgba(245, 158, 11, 0.2)'
                    : 'rgba(16, 185, 129, 0.2)';
    ctx.strokeStyle = glowColor;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  // Needle dot
  const dotX = centerX + radius * Math.cos(valueAngle);
  const dotY = centerY + radius * Math.sin(valueAngle);

  ctx.beginPath();
  ctx.arc(dotX, dotY, 6, 0, 2 * Math.PI);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(dotX, dotY, 10, 0, 2 * Math.PI);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.fill();
}

function drawArcSegment(ctx, cx, cy, r, startAngle, endAngle, color, opacity) {
  ctx.beginPath();
  ctx.arc(cx, cy, r - 14, startAngle, endAngle);
  ctx.lineWidth = 3;
  ctx.strokeStyle = color;
  ctx.globalAlpha = opacity;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// ===================== HISTORY CHART =====================
function createHistoryChart() {
  const ctx = document.getElementById('historyChart').getContext('2d');

  historyChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Tinggi Air (cm)',
        data: [],
        borderColor: '#06b6d4',
        backgroundColor: createGradient(ctx, '#06b6d4'),
        borderWidth: 2,
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: '#06b6d4',
        pointHoverBorderColor: '#ffffff',
        pointHoverBorderWidth: 2,
      }]
    },
    options: getChartOptions('Tinggi Air (cm)')
  });
}

function updateHistoryChart() {
  if (!historyChart) return;

  const filteredData = getFilteredHistoryData();

  historyChart.data.labels = filteredData.map(d => d.time);
  historyChart.data.datasets[0].data = filteredData.map(d => d.height);
  historyChart.update('none');
}

function getFilteredHistoryData() {
  const now = Date.now();
  let cutoff;

  switch (currentHistoryRange) {
    case '1h':  cutoff = now - (1 * 60 * 60 * 1000); break;
    case '6h':  cutoff = now - (6 * 60 * 60 * 1000); break;
    case '12h': cutoff = now - (12 * 60 * 60 * 1000); break;
    default:    cutoff = now - (24 * 60 * 60 * 1000); break;
  }

  return historyData.filter(d => d.time.getTime() >= cutoff);
}

// Exposed to HTML onclick
function switchHistoryRange(range, btn) {
  currentHistoryRange = range;
  document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  updateHistoryChart();
}

// ===================== PREDICTION CHART =====================
function createPredictionChart() {
  const ctx = document.getElementById('predictionChart').getContext('2d');

  predictionChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Prediksi Tinggi Air (cm)',
          data: [],
          borderColor: '#8b5cf6',
          backgroundColor: createGradient(ctx, '#8b5cf6'),
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: '#8b5cf6',
          pointHoverBorderColor: '#ffffff',
          pointHoverBorderWidth: 2,
          borderDash: [6, 3],
        },
        {
          label: 'Batas Waspada',
          data: [],
          borderColor: 'rgba(245, 158, 11, 0.5)',
          borderWidth: 1,
          borderDash: [8, 4],
          pointRadius: 0,
          fill: false,
        },
        {
          label: 'Batas Bahaya',
          data: [],
          borderColor: 'rgba(239, 68, 68, 0.5)',
          borderWidth: 1,
          borderDash: [8, 4],
          pointRadius: 0,
          fill: false,
        }
      ]
    },
    options: getChartOptions('Prediksi Tinggi Air (cm)')
  });
}

function updatePredictionChart() {
  if (!predictionChart) return;

  predictionChart.data.labels = predictionData.map(d => d.time);
  predictionChart.data.datasets[0].data = predictionData.map(d => d.height);
  predictionChart.data.datasets[1].data = predictionData.map(() => CONFIG.BATAS_WASPADA);
  predictionChart.data.datasets[2].data = predictionData.map(() => CONFIG.BATAS_BAHAYA);
  predictionChart.update('none');
}

// ===================== CHART HELPERS =====================
function createGradient(ctx, color) {
  const gradient = ctx.createLinearGradient(0, 0, 0, 300);
  gradient.addColorStop(0, hexToRgba(color, 0.3));
  gradient.addColorStop(0.5, hexToRgba(color, 0.1));
  gradient.addColorStop(1, hexToRgba(color, 0));
  return gradient;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getChartOptions(yLabel) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    plugins: {
      legend: {
        display: true,
        labels: {
          color: '#94a3b8',
          font: { family: 'Inter', size: 11 },
          padding: 20,
          usePointStyle: true,
          pointStyleWidth: 10,
        }
      },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.9)',
        titleColor: '#f1f5f9',
        bodyColor: '#94a3b8',
        borderColor: 'rgba(148, 163, 184, 0.2)',
        borderWidth: 1,
        cornerRadius: 8,
        padding: 12,
        titleFont: { family: 'Inter', size: 12, weight: '600' },
        bodyFont: { family: 'JetBrains Mono', size: 11 },
        callbacks: {
          title: function(items) {
            const date = new Date(items[0].parsed.x || items[0].label);
            return date.toLocaleString('id-ID', {
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit'
            });
          },
          label: function(item) {
            return ` ${item.dataset.label}: ${item.parsed.y.toFixed(1)} cm`;
          }
        }
      }
    },
    scales: {
      x: {
        type: 'time',
        time: {
          displayFormats: {
            minute: 'HH:mm',
            hour: 'HH:mm',
          },
          tooltipFormat: 'dd MMM HH:mm'
        },
        grid: {
          color: 'rgba(148, 163, 184, 0.06)',
          drawBorder: false,
        },
        ticks: {
          color: '#64748b',
          font: { family: 'JetBrains Mono', size: 10 },
          maxTicksLimit: 12,
          maxRotation: 0,
        },
        border: { display: false }
      },
      y: {
        min: 0,
        max: 100,
        grid: {
          color: 'rgba(148, 163, 184, 0.06)',
          drawBorder: false,
        },
        ticks: {
          color: '#64748b',
          font: { family: 'JetBrains Mono', size: 10 },
          callback: (v) => v + ' cm',
          stepSize: 20,
        },
        border: { display: false },
        title: { display: false }
      }
    },
    animation: {
      duration: 0
    }
  };
}

// ===================== TABLE =====================
function updateTable() {
  const tbody = document.getElementById('dataTableBody');
  let html = '';

  const reversed = [...tableData].reverse();

  reversed.forEach((row) => {
    const dateStr = row.time.toLocaleDateString('id-ID', {
      day: '2-digit',
      month: 'short',
    });

    const timeStr = row.time.toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    const statusClass = getStatusClass(row.status);

    html += `
      <tr>
        <td>${dateStr} ${timeStr}</td>
        <td>${row.height.toFixed(1)} cm</td>
        <td>${row.jarak.toFixed(1)} cm</td>
        <td class="status-cell ${statusClass}">${row.status}</td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

// ===================== DAILY HISTORY =====================
// Fitur untuk melihat history per tanggal dari Firebase

// Inisialisasi daily history — set tanggal hari ini
function initDailyHistory() {
  const today = formatDateKey(new Date());
  selectedDateKey = today;

  const picker = document.getElementById('historyDatePicker');
  if (picker) {
    picker.max = today;
    picker.value = today;
  }

  // Update tampilan tanggal
  updateDateDisplay(today);

  // Load data awal (simulasi jika Firebase belum connect)
  loadDailyHistory(today);
}

// Mengambil semua tanggal yang tersimpan di Firebase /history
function fetchAvailableHistoryDates() {
  if (!firebaseDB) return;

  const historyRootRef = firebaseDB.ref('/history');
  historyRootRef.on('value', (snapshot) => {
    const data = snapshot.val();
    if (!data || typeof data !== 'object') {
      console.log("📭 Belum ada rekaman di /history Firebase.");
      availableHistoryDates = [];
      availableHistoryCounts = {};
      renderAvailableDateSelector();
      return;
    }

    // Ambil semua key yang berformat YYYY-MM-DD
    availableHistoryDates = Object.keys(data)
      .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k))
      .sort(); // Urutan kronologis ascending (misal: 2026-09-05, ..., 2026-10-19)

    // Hitung jumlah record per tanggal
    availableHistoryCounts = {};
    availableHistoryDates.forEach(dateKey => {
      const dayData = data[dateKey];
      let count = 0;
      if (dayData && typeof dayData === 'object') {
        Object.values(dayData).forEach(item => {
          if (item && typeof item === 'object') {
            if (isDataEntry(item)) {
              count++;
            } else {
              // Jika data berada di dalam subfolder jam (HH)
              count += Object.keys(item).length;
            }
          }
        });
      }
      availableHistoryCounts[dateKey] = count;
    });

    console.log(`📅 Tanggal tersedia di Firebase:`, availableHistoryDates);

    // Render dropdown dan chip pilihan tanggal
    renderAvailableDateSelector();

    // Jika belum memilih tanggal atau tanggal yang dipilih tidak ada di database,
    // langsung tampilkan tanggal terbaru yang memiliki data
    if (availableHistoryDates.length > 0) {
      if (!selectedDateKey || !data[selectedDateKey]) {
        const latestDate = availableHistoryDates[availableHistoryDates.length - 1];
        selectDate(latestDate);
      } else {
        // Reload data untuk tanggal yang sedang aktif
        loadDailyHistory(selectedDateKey);
      }
    }
  });
}

// Render dropdown dan pill badges untuk tanggal yang ada di Firebase
function renderAvailableDateSelector() {
  const selectEl = document.getElementById('availableDateSelect');
  const pillsEl = document.getElementById('availableDatePills');

  if (!selectEl || !pillsEl) return;

  if (availableHistoryDates.length === 0) {
    selectEl.innerHTML = '<option value="">(Belum ada rekaman di Firebase)</option>';
    pillsEl.innerHTML = '<span style="font-size:0.8rem; color:var(--text-muted);">Menunggu data Firebase...</span>';
    return;
  }

  // Tampilkan dari yang paling baru (terbaru di atas / kiri)
  const reversedDates = [...availableHistoryDates].reverse();

  let selectHtml = `<option value="">-- Pilih Tanggal (${availableHistoryDates.length} tersimpan) --</option>`;
  reversedDates.forEach(d => {
    const count = availableHistoryCounts[d] || 0;
    const isToday = d === formatDateKey(new Date());
    const displayStr = formatDisplayDateOnly(d);
    const label = `${d} (${displayStr})${isToday ? ' — Hari Ini' : ''} • [${count} data]`;
    selectHtml += `<option value="${d}" ${d === selectedDateKey ? 'selected' : ''}>${label}</option>`;
  });
  selectEl.innerHTML = selectHtml;

  let pillsHtml = '';
  reversedDates.forEach(d => {
    const count = availableHistoryCounts[d] || 0;
    const isActive = d === selectedDateKey ? 'active' : '';
    pillsHtml += `
      <button class="date-pill ${isActive}" data-date="${d}" onclick="selectDate('${d}')" title="Buka data tanggal ${d}">
        📅 ${d} <span class="pill-count">${count}</span>
      </button>
    `;
  });
  pillsEl.innerHTML = pillsHtml;
}

// Sinkronisasi status active pada pills & dropdown
function updateActivePillAndDropdown(dateKey) {
  const selectEl = document.getElementById('availableDateSelect');
  if (selectEl) {
    selectEl.value = dateKey;
  }

  document.querySelectorAll('.date-pill').forEach(pill => {
    if (pill.getAttribute('data-date') === dateKey) {
      pill.classList.add('active');
    } else {
      pill.classList.remove('active');
    }
  });

  updateNavButtonsState();
}

// Update status tombol prev / next
function updateNavButtonsState() {
  const prevBtn = document.getElementById('btnPrevDay');
  const nextBtn = document.getElementById('btnNextDay');
  if (!prevBtn || !nextBtn) return;

  if (availableHistoryDates.length > 0) {
    const idx = availableHistoryDates.indexOf(selectedDateKey);
    // Jika di tanggal paling awal
    if (idx === 0) {
      prevBtn.style.opacity = '0.35';
      prevBtn.style.pointerEvents = 'none';
    } else {
      prevBtn.style.opacity = '1';
      prevBtn.style.pointerEvents = 'auto';
    }

    // Jika di tanggal paling akhir
    if (idx === availableHistoryDates.length - 1 || (idx === -1 && selectedDateKey >= availableHistoryDates[availableHistoryDates.length - 1])) {
      nextBtn.style.opacity = '0.35';
      nextBtn.style.pointerEvents = 'none';
    } else {
      nextBtn.style.opacity = '1';
      nextBtn.style.pointerEvents = 'auto';
    }
  }
}

// Fungsi utama memilih tanggal
function selectDate(dateKey) {
  if (!dateKey) return;
  selectedDateKey = dateKey;

  const picker = document.getElementById('historyDatePicker');
  if (picker) picker.value = dateKey;

  updateDateDisplay(dateKey);
  updateActivePillAndDropdown(dateKey);
  loadDailyHistory(dateKey);
}

// Dipanggil saat input date picker kalender berubah
function onDatePickerChange(dateKey) {
  if (!dateKey) return;
  selectDate(dateKey);
}

// Dipanggil saat memilih dari dropdown
function onSelectAvailableDate(dateKey) {
  if (!dateKey) return;
  selectDate(dateKey);
}

// Navigasi tanggal pintar (jumps ke tanggal yang benar-benar ADA di Firebase)
function navigateDay(offset) {
  if (availableHistoryDates.length === 0) {
    // Fallback jika belum ada daftar tanggal: kurangi 1 hari biasa
    const picker = document.getElementById('historyDatePicker');
    const current = new Date((picker.value || selectedDateKey) + 'T00:00:00');
    current.setDate(current.getDate() + offset);
    selectDate(formatDateKey(current));
    return;
  }

  const currentIndex = availableHistoryDates.indexOf(selectedDateKey);

  if (offset < 0) {
    // Cari tanggal sebelumnya yang ada datanya
    if (currentIndex > 0) {
      selectDate(availableHistoryDates[currentIndex - 1]);
    } else if (currentIndex === -1) {
      const earlierDates = availableHistoryDates.filter(d => d < selectedDateKey);
      if (earlierDates.length > 0) {
        selectDate(earlierDates[earlierDates.length - 1]);
      }
    }
  } else if (offset > 0) {
    // Cari tanggal berikutnya yang ada datanya
    if (currentIndex !== -1 && currentIndex < availableHistoryDates.length - 1) {
      selectDate(availableHistoryDates[currentIndex + 1]);
    } else if (currentIndex === -1) {
      const laterDates = availableHistoryDates.filter(d => d > selectedDateKey);
      if (laterDates.length > 0) {
        selectDate(laterDates[0]);
      }
    }
  }
}

// Langsung ke hari ini / tanggal terbaru
function goToToday() {
  const today = formatDateKey(new Date());
  if (availableHistoryDates.includes(today)) {
    selectDate(today);
  } else if (availableHistoryDates.length > 0) {
    // Pilih tanggal paling baru yang tersimpan
    selectDate(availableHistoryDates[availableHistoryDates.length - 1]);
  } else {
    selectDate(today);
  }
}

// Update teks tampilan tanggal yang ramah dibaca
function updateDateDisplay(dateKey) {
  const display = document.getElementById('dateDisplay');
  if (!display) return;

  try {
    const parts = dateKey.split('-');
    const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    display.textContent = `📅 ${date.toLocaleDateString('id-ID', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    })}`;
  } catch (e) {
    display.textContent = `📅 ${dateKey}`;
  }

  updateNavButtonsState();
}

// Format ringkas nama hari/bulan
function formatDisplayDateOnly(dateKey) {
  try {
    const parts = dateKey.split('-');
    const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return date.toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
  } catch (e) {
    return dateKey;
  }
}

// Load data history untuk tanggal yang dipilih dari Firebase
function loadDailyHistory(dateKey) {
  selectedDateKey = dateKey;
  dailyHistoryData = [];

  const statusEl = document.getElementById('dailyStatus');
  const tableContainer = document.getElementById('dailyTableContainer');

  // Tampilkan status loading
  setDailyStatus('loading', `⏳ Memuat data tanggal ${dateKey}...`);
  if (tableContainer) tableContainer.style.display = 'none';

  // Reset chart & ringkasan stats
  updateDailyHistoryChart([]);
  resetDailyStats();

  // Jika Firebase belum terkoneksi, gunakan mode simulasi
  if (!useFirebase || !firebaseDB) {
    generateDailySimulationData(dateKey);
    return;
  }

  // Bersihkan listener sebelumnya
  if (dailyHistoryListener) {
    dailyHistoryListener.off();
    dailyHistoryListener = null;
  }

  console.log(`📅 Mengambil history dari Firebase: /history/${dateKey}`);
  const historyRef = firebaseDB.ref(`/history/${dateKey}`);
  dailyHistoryListener = historyRef;

  // Listen secara real-time untuk tanggal yang dipilih
  historyRef.on('value', (snapshot) => {
    const dayData = snapshot.val();
    console.log(`📅 [${dateKey}] Data Firebase diterima:`, dayData);

    if (!dayData) {
      setDailyStatus('empty', `📭 Tidak ada data rekaman pada tanggal ${dateKey}.`);
      if (tableContainer) tableContainer.style.display = 'none';
      updateDailyHistoryChart([]);
      resetDailyStats();
      return;
    }

    // Parse semua entries (baik format langsung maupun berjenjang)
    dailyHistoryData = [];
    parseDailyEntries(dayData, dateKey);

    // Urutkan kronologis (dari pagi ke malam)
    dailyHistoryData.sort((a, b) => a.time - b.time);

    console.log(`📅 [${dateKey}] Berhasil memproses ${dailyHistoryData.length} data.`);

    if (dailyHistoryData.length === 0) {
      setDailyStatus('empty', `📭 Data ditemukan pada tanggal ini tetapi formatnya tidak sesuai.`);
      if (tableContainer) tableContainer.style.display = 'none';
      return;
    }

    if (statusEl) statusEl.style.display = 'none';
    if (tableContainer) tableContainer.style.display = '';

    updateDailyStats(dailyHistoryData);
    updateDailyHistoryChart(dailyHistoryData);
    updateDailyTable(dailyHistoryData);
  });
}

// Parser fleksibel — menangani baik entry langsung di bawah tanggal maupun di dalam folder jam (HH)
function parseDailyEntries(data, dateKey) {
  if (!data || typeof data !== 'object') return;

  Object.keys(data).forEach(key => {
    const val = data[key];
    if (!val || typeof val !== 'object') return;

    // Tingkat 1: Cek apakah entry langsung (seperti di Firebase: /history/YYYY-MM-DD/{pushKey})
    if (isDataEntry(val)) {
      addDailyEntry(val, dateKey);
      return;
    }

    // Tingkat 2: Cek apakah berada di folder jam (HH)
    Object.keys(val).forEach(subKey => {
      const subVal = val[subKey];
      if (!subVal || typeof subVal !== 'object') return;

      if (isDataEntry(subVal)) {
        addDailyEntry(subVal, dateKey);
        return;
      }

      // Tingkat 3: Jaga-jaga jika ada nesting lebih dalam
      Object.keys(subVal).forEach(deepKey => {
        const deepVal = subVal[deepKey];
        if (deepVal && typeof deepVal === 'object' && isDataEntry(deepVal)) {
          addDailyEntry(deepVal, dateKey);
        }
      });
    });
  });
}

// Cek apakah sebuah object adalah item rekaman sensor
function isDataEntry(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return obj.hasOwnProperty('tinggiAir') ||
         obj.hasOwnProperty('jarakSensor') ||
         obj.hasOwnProperty('timestamp') ||
         obj.hasOwnProperty('waktu') ||
         obj.hasOwnProperty('waterLevel') ||
         obj.hasOwnProperty('status');
}

// Parsing 1 record data menjadi objek standard
function addDailyEntry(entry, dateKey) {
  let time = null;

  // 1. Coba dari timestamp (seconds atau milliseconds)
  if (entry.timestamp !== undefined && entry.timestamp !== null && entry.timestamp !== '') {
    const ts = Number(entry.timestamp);
    if (!isNaN(ts) && ts > 0) {
      if (ts > 1e12) {
        time = new Date(ts);
      } else if (ts > 1e9) {
        time = new Date(ts * 1000);
      }
    }
  }

  // 2. Coba dari waktu string (contoh: "14:01:23")
  if (!time || isNaN(time.getTime())) {
    const timeStr = String(entry.waktu || entry.time || '').trim();
    if (timeStr) {
      if (timeStr.includes(':')) {
        // Gabungkan tanggal yang dipilih dengan waktu jam:menit:detik
        const candidate = new Date(`${dateKey}T${timeStr}`);
        if (!isNaN(candidate.getTime())) {
          time = candidate;
        }
      }
      if (!time) {
        const candidate = new Date(timeStr);
        if (!isNaN(candidate.getTime())) time = candidate;
      }
    }
  }

  // 3. Fallback jika masih belum ada waktu
  if (!time || isNaN(time.getTime())) {
    time = new Date(`${dateKey}T00:00:00`);
  }

  // Parse tinggi air
  const height = parseFloat(
    entry.tinggiAir ?? entry.waterLevel ?? entry.level ??
    entry.height ?? entry.tinggi ?? entry.water_level ?? 0
  );

  // Parse jarak sensor
  const jarak = entry.jarakSensor !== undefined ? parseFloat(entry.jarakSensor) :
                entry.distance !== undefined ? parseFloat(entry.distance) :
                parseFloat((CONFIG.TINGGI_SENSOR - (isNaN(height) ? 0 : height)).toFixed(1));

  // Parse status
  const status = entry.status || getStatus(isNaN(height) ? 0 : height);

  dailyHistoryData.push({
    time: time,
    height: isNaN(height) ? 0 : height,
    jarak: isNaN(jarak) ? parseFloat((CONFIG.TINGGI_SENSOR - height).toFixed(1)) : jarak,
    status: status
  });
}

// Fallback data simulasi jika Firebase offline
function generateDailySimulationData(dateKey) {
  const date = new Date(dateKey + 'T00:00:00');
  const startOfDay = date.getTime();
  const tenMinutes = 10 * 60 * 1000;
  const now = Date.now();

  dailyHistoryData = [];

  for (let i = 0; i < 144; i++) {
    const timestamp = startOfDay + (i * tenMinutes);
    if (timestamp > now) break;

    const height = calculateTideWithNoise(timestamp);
    dailyHistoryData.push({
      time: new Date(timestamp),
      height: parseFloat(height.toFixed(1)),
      jarak: parseFloat((CONFIG.TINGGI_SENSOR - height).toFixed(1)),
      status: getStatus(height)
    });
  }

  const statusEl = document.getElementById('dailyStatus');
  const tableContainer = document.getElementById('dailyTableContainer');

  if (dailyHistoryData.length === 0) {
    setDailyStatus('empty', `📭 Belum ada data untuk tanggal ini.`);
    if (tableContainer) tableContainer.style.display = 'none';
    return;
  }

  if (statusEl) statusEl.style.display = 'none';
  if (tableContainer) tableContainer.style.display = '';

  updateDailyStats(dailyHistoryData);
  updateDailyHistoryChart(dailyHistoryData);
  updateDailyTable(dailyHistoryData);
}

// Set pesan status daily
function setDailyStatus(type, message) {
  const statusEl = document.getElementById('dailyStatus');
  const iconEl = document.getElementById('dailyStatusIcon');
  const textEl = document.getElementById('dailyStatusText');
  if (!statusEl) return;

  statusEl.style.display = 'flex';
  statusEl.className = `daily-status ${type}`;
  if (textEl) textEl.textContent = message;

  if (iconEl) {
    iconEl.textContent = type === 'loading' ? '⏳' : '📭';
  }
}

// Reset daily stats
function resetDailyStats() {
  const totalEl = document.getElementById('dailyTotal');
  const minEl = document.getElementById('dailyMin');
  const maxEl = document.getElementById('dailyMax');
  const avgEl = document.getElementById('dailyAvg');

  if (totalEl) totalEl.textContent = '--';
  if (minEl) minEl.textContent = '-- cm';
  if (maxEl) maxEl.textContent = '-- cm';
  if (avgEl) avgEl.textContent = '-- cm';
}

// Hitung dan update statistik harian
function updateDailyStats(data) {
  if (data.length === 0) {
    resetDailyStats();
    return;
  }

  const heights = data.map(d => d.height);
  const min = Math.min(...heights);
  const max = Math.max(...heights);
  const avg = heights.reduce((a, b) => a + b, 0) / heights.length;

  const totalEl = document.getElementById('dailyTotal');
  const minEl = document.getElementById('dailyMin');
  const maxEl = document.getElementById('dailyMax');
  const avgEl = document.getElementById('dailyAvg');

  if (totalEl) totalEl.textContent = data.length.toLocaleString('id-ID');
  if (minEl) minEl.textContent = `${min.toFixed(1)} cm`;
  if (maxEl) maxEl.textContent = `${max.toFixed(1)} cm`;
  if (avgEl) avgEl.textContent = `${avg.toFixed(1)} cm`;
}

// =============== DAILY HISTORY CHART ===============
function createDailyHistoryChart() {
  const canvas = document.getElementById('dailyHistoryChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  dailyHistoryChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Tinggi Air (cm)',
          data: [],
          borderColor: '#f59e0b',
          backgroundColor: createGradient(ctx, '#f59e0b'),
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          pointRadius: 4,
          pointHoverRadius: 7,
          pointBackgroundColor: '#f59e0b',
          pointBorderColor: '#ffffff',
          pointBorderWidth: 1.5,
        },
        {
          label: 'Batas Waspada',
          data: [],
          borderColor: 'rgba(245, 158, 11, 0.4)',
          borderWidth: 1,
          borderDash: [8, 4],
          pointRadius: 0,
          fill: false,
        },
        {
          label: 'Batas Bahaya',
          data: [],
          borderColor: 'rgba(239, 68, 68, 0.4)',
          borderWidth: 1,
          borderDash: [8, 4],
          pointRadius: 0,
          fill: false,
        }
      ]
    },
    options: getDailyChartOptions()
  });
}

function getDailyChartOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    plugins: {
      legend: {
        display: true,
        labels: {
          color: '#94a3b8',
          font: { family: 'Inter', size: 11 },
          padding: 20,
          usePointStyle: true,
          pointStyleWidth: 10,
        }
      },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.9)',
        titleColor: '#f1f5f9',
        bodyColor: '#94a3b8',
        borderColor: 'rgba(148, 163, 184, 0.2)',
        borderWidth: 1,
        cornerRadius: 8,
        padding: 12,
        titleFont: { family: 'Inter', size: 12, weight: '600' },
        bodyFont: { family: 'JetBrains Mono', size: 11 },
        callbacks: {
          title: function(items) {
            const date = new Date(items[0].parsed.x || items[0].label);
            return date.toLocaleString('id-ID', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false
            });
          },
          label: function(item) {
            return ` ${item.dataset.label}: ${item.parsed.y.toFixed(1)} cm`;
          }
        }
      }
    },
    scales: {
      x: {
        type: 'time',
        time: {
          displayFormats: {
            hour: 'HH:mm',
            minute: 'HH:mm',
          },
          tooltipFormat: 'HH:mm:ss'
        },
        grid: {
          color: 'rgba(148, 163, 184, 0.06)',
          drawBorder: false,
        },
        ticks: {
          color: '#64748b',
          font: { family: 'JetBrains Mono', size: 10 },
          maxTicksLimit: 12,
          maxRotation: 0,
        },
        border: { display: false }
      },
      y: {
        min: 0,
        max: 100,
        grid: {
          color: 'rgba(148, 163, 184, 0.06)',
          drawBorder: false,
        },
        ticks: {
          color: '#64748b',
          font: { family: 'JetBrains Mono', size: 10 },
          callback: (v) => v + ' cm',
          stepSize: 20,
        },
        border: { display: false },
        title: { display: false }
      }
    },
    animation: {
      duration: 300
    }
  };
}

function updateDailyHistoryChart(data) {
  if (!dailyHistoryChart) return;

  dailyHistoryChart.data.labels = data.map(d => d.time);
  dailyHistoryChart.data.datasets[0].data = data.map(d => d.height);
  dailyHistoryChart.data.datasets[1].data = data.map(() => CONFIG.BATAS_WASPADA);
  dailyHistoryChart.data.datasets[2].data = data.map(() => CONFIG.BATAS_BAHAYA);

  // Jika jumlah data > 50, sembunyikan titik agar grafik tetap rapi
  dailyHistoryChart.data.datasets[0].pointRadius = data.length > 50 ? 0 : 4;

  dailyHistoryChart.update();
}

// =============== DAILY DATA TABLE ===============
function updateDailyTable(data) {
  const tbody = document.getElementById('dailyTableBody');
  if (!tbody) return;
  let html = '';

  // Urutkan dari data paling baru (waktu terakhir) di atas
  const reversed = [...data].reverse();

  reversed.forEach((row, index) => {
    const timeStr = row.time.toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    const statusClass = getStatusClass(row.status);

    html += `
      <tr>
        <td style="color: var(--text-muted); font-size: 0.75rem;">${index + 1}</td>
        <td>${timeStr}</td>
        <td>${row.height.toFixed(1)} cm</td>
        <td>${row.jarak.toFixed(1)} cm</td>
        <td class="status-cell ${statusClass}">${row.status}</td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}
