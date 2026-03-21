const Preferences = window.Capacitor?.Plugins?.Preferences ?? {
    get: async ({ key }) => ({ value: localStorage.getItem(key) }),
    set: async ({ key, value }) => localStorage.setItem(key, value),
    remove: async ({ key }) => localStorage.removeItem(key),
    clear: async () => localStorage.clear(),
};

async function setStatusBarColor(isDark) {
    const StatusBar = window.Capacitor?.Plugins?.StatusBar;
    if (!StatusBar) return;
    await StatusBar.setBackgroundColor({ color: isDark ? '#212121' : '#F9F8F8' });
    await StatusBar.setStyle({ style: isDark ? 'DARK' : 'LIGHT' });
}

renderHomePage()

////////////////////////
// Data Tracking Logic
////////////////////////

let liveDrive = null;
let timeInterval = null;

async function init() {
    const baselineMPG = (await Preferences.get({ key: 'baselineMPG' })).value;
    LITRES_PER_100KM = 282.481 / (Number(baselineMPG) || 53);

    const savedTheme = (await Preferences.get({ key: 'theme' })).value
    const isDark = savedTheme === "dark";
    if (isDark) document.body.classList.add("dark");
    await setStatusBarColor(isDark);
    updateThemeIcon();

    connectOBD(true);
}
init();


// -------------------- Tunable constants --------------------
let LITRES_PER_100KM = 5.3; // calibrated to your car's real-world MPG (will be overridden by saved value if set)

// Idle consumption
const IDLE_LITRES_PER_HOUR = 0.8; // realistic range: 0.5–1.0

// Calibrate MPG output to your car
const MPG_CALIBRATION = 1;
const DEFAULT_FUEL_PRICE = 135; // pence per litre (used if API price unavailable)

// --- Tuning knobs (adjust later if needed) ---
const SPEED_SMOOTH_WINDOW = 10;      // last N GPS samples used for smoothing accel
const STEADY_CRUISE_MULT = 0.84;     // 0.78–0.90 (lower = more efficient cruising)
const OPTIMAL_SPEED_KPH = 85;        // ~53 mph sweet spot
const SPEED_EFF_STRENGTH = 0.15;     // higher = bigger penalty away from optimal
const COASTING_REDUCTION = 0.70;     // 0.6–0.85 (closer to 1 = less “free” coasting)
const GENTLE_FLOW_MULT = 0.92;
const DOWNHILL_PAYBACK_MULT = 0.55;


// --- NEW: allow very low fuel during light-load cruise / downhill-overrun-like moments ---
const MIN_L_PER_100KM_CRUISE = 2.3;   // stable high-speed cruise can be very low
const MIN_L_PER_100KM_OVERRUN = 0.8;  // near-fuel-cut-ish on overrun/downhill

// --- NEW: stability detection tuning ---
const STABLE_SPEED_STD_KPH = 0.8;     // lower = stricter “stable speed”
const STABLE_ACCEL_KPHPS = 0.08;      // kph/s
const LIGHTLOAD_MIN_SPEED_KPH = 55;   // only treat as light-load when above this speed
const OVERRUN_MIN_SPEED_KPH = 35;     // only treat as overrun-like when above this speed


function startDrive() {
    const now = Date.now();

    liveDrive = {
        startTime: now,
        lastSpeedKph: 0,
        recentSpeeds: [],
        lastGpsTime: null,
        prevSmoothSpeedKph: null,
        activeSeconds: 0,
        distanceKm: 0,
        downhillCreditKm: 0,
        fuelUsedLitres: 0
    };

    startActiveTimer();
    connectOBD(true);
}

function startActiveTimer() {
    if (timeInterval) return;

    timeInterval = setInterval(() => {
        if (!liveDrive) return;
        if (appState.paused) return;

        liveDrive.activeSeconds += 1;

        // IDLE FUEL (time-based)
        if (!obdConnected && liveDrive.lastSpeedKph < 3) {
            const deltaHours = 1 / 3600;
            liveDrive.fuelUsedLitres += IDLE_LITRES_PER_HOUR * deltaHours;
        }
    }, 1000);
}

function stopActiveTimer() {
    clearInterval(timeInterval);
    timeInterval = null;
}

function updateDistance(speedKph, deltaSeconds) {
    const kmPerSecond = speedKph / 3600;
    liveDrive.distanceKm += kmPerSecond * deltaSeconds;
}

function getAverageSpeed() {
    if (!liveDrive || liveDrive.activeSeconds === 0) return 0;
    const hours = liveDrive.activeSeconds / 3600;
    return liveDrive.distanceKm / hours; // kph
}

// -------------------- MPG calc --------------------

function calculateMPG(distanceKm, fuelLitres) {
    if (fuelLitres === 0) return 0;

    const miles = distanceKm * 0.621371;
    const gallons = fuelLitres * 0.219969;

    const rawMpg = miles / gallons;
    return rawMpg * MPG_CALIBRATION;
}

// -------------------- Stop + save --------------------

async function stopDrive() {
    stopActiveTimer();
    appState.paused = false;

    const iso = new Date().toISOString().split("T")[0];
    const [y, m, d] = iso.split("-");
    const formattedDate = `${d}/${m}/${y}`;

    const fuelPricePerL = Number((await Preferences.get({ key: 'fuelPrice' })).value) || DEFAULT_FUEL_PRICE;
    const fuelCost = liveDrive.fuelUsedLitres * (fuelPricePerL / 100);

    const driveSummary = {
        date: formattedDate,
        startTime: liveDrive.startTime,
        durationSeconds: Math.floor(liveDrive.activeSeconds),
        distanceMiles: (liveDrive.distanceKm * 0.621371).toFixed(1),
        averageSpeedMPH: (getAverageSpeed() * 0.621371).toFixed(1),
        fuelUsedLitres: liveDrive.fuelUsedLitres.toFixed(3),
        fuelCost: Number.isFinite(fuelCost) ? fuelCost : 0,
        estimatedMPG: calculateMPG(liveDrive.distanceKm, liveDrive.fuelUsedLitres).toFixed(1)
    };

    
    const drives = JSON.parse((await Preferences.get({ key: "drives" })).value || "[]");
    drives.push(driveSummary);
    await Preferences.set({ 
        key: 'drives', 
        value: JSON.stringify(drives) 
    });

    updateFuelRemaining(liveDrive.fuelUsedLitres);

    liveDrive = null;
}

// ============================================================
// GPS logic
// ============================================================

navigator.geolocation.getCurrentPosition(
    () => console.log("GPS allowed"),
    err => console.error(err),
    { enableHighAccuracy: true }
);

let geoWatchId = null;

function startGPS() {
    if (geoWatchId !== null) return;

    geoWatchId = navigator.geolocation.watchPosition(
        handlePositionUpdate,
        handleGPSError,
        {
            enableHighAccuracy: true,
            maximumAge: 1000,
            timeout: 10000
        }
    );
}

function handleGPSError(error) {
    console.error("GPS error:", error);

    switch (error.code) {
        case error.PERMISSION_DENIED:
            console.error("User denied GPS permission");
            break;
        case error.POSITION_UNAVAILABLE:
            console.error("Position unavailable");
            break;
        case error.TIMEOUT:
            console.error("GPS timeout");
            break;
        default:
            console.error("Unknown GPS error");
    }
}

function stopGPS() {
    if (geoWatchId !== null) {
        navigator.geolocation.clearWatch(geoWatchId);
        geoWatchId = null;
    }
}

function handlePositionUpdate(position) {
    if (!liveDrive) return;
    if (appState.paused) return;

    const speedMps = position.coords.speed;
    if (speedMps === null) return;

    const speedKph = speedMps * 3.6;
    liveDrive.lastSpeedKph = speedKph;

    // Store recent speeds for smoothing / stability
    liveDrive.recentSpeeds.push(speedKph);
    if (liveDrive.recentSpeeds.length > 60) liveDrive.recentSpeeds.shift();

    const now = position.timestamp;

    if (!liveDrive.lastGpsTime) {
        liveDrive.lastGpsTime = now;
        liveDrive.prevSmoothSpeedKph = getSmoothedSpeedKph();
        return;
    }

    const deltaSeconds = (now - liveDrive.lastGpsTime) / 1000;
    liveDrive.lastGpsTime = now;

    updateLiveFromSpeed(speedKph, deltaSeconds);

    // Debug UI
    const dbgTime = document.getElementById("dbg-time");
    const dbgSpeed = document.getElementById("dbg-speed");
    const dbgDist = document.getElementById("dbg-distance");
    const dbgFuel = document.getElementById("dbg-fuel");
    const dbgAvg = document.getElementById("dbg-avg-speed");
    const dbgMpg = document.getElementById("dbg-mpg");

    if (dbgTime) dbgTime.textContent = liveDrive.activeSeconds.toFixed(1);
    if (dbgSpeed) dbgSpeed.textContent = (speedMps * 2.23694).toFixed(1);
    if (dbgDist) dbgDist.textContent = (liveDrive.distanceKm * 0.621371).toFixed(1);
    if (dbgFuel) dbgFuel.textContent = liveDrive.fuelUsedLitres.toFixed(3);
    if (dbgAvg) dbgAvg.textContent = (getAverageSpeed() * 0.621371).toFixed(1);
    if (dbgMpg) dbgMpg.textContent = calculateMPG(liveDrive.distanceKm, liveDrive.fuelUsedLitres).toFixed(1);
}

// ============================================================
// OBD-II Bluetooth (Veepeak BLE)
// ============================================================

const BLE_SERVICE     = 'fff0';
const BLE_NOTIFY_CHAR = 'fff1';
const BLE_WRITE_CHAR  = 'fff2';

let bleDeviceId = null;
let obdConnected = false;
let responseBuffer = '';

function getBLE() {
    return window.Capacitor?.Plugins?.BluetoothLe ?? null;
}

async function connectOBD(silent = false) {
    const BLE = getBLE();
    if (!BLE) { console.warn("BLE plugin not available"); return; }

    try {
        await BLE.initialize();

        // Try to reconnect to last known device first
        const savedId = (await Preferences.get({ key: 'obdDeviceId' })).value;
        let deviceId = null;

        if (savedId) {
            try {
                console.log("Trying to reconnect to saved OBD device...");
                await BLE.connect({ deviceId: savedId, timeout: 5000 });
                deviceId = savedId;
                console.log("Reconnected to saved device");
            } catch (e) {
                console.warn("Saved device not available, scanning...");
                deviceId = null;
            }
        }

        if (!deviceId) {
            if (silent) {
                // Called from startDrive — don't show picker, just give up quietly
                console.log("OBD not available, using GPS model");
                return;
            }
            // Called from button — show picker
            const result = await BLE.requestDevice({ services: [BLE_SERVICE] });
            deviceId = result.deviceId;
            console.log("OBD device found:", result.name, deviceId);
            await BLE.connect({ 
                deviceId,
                onDisconnected: () => {
                    console.warn("OBD disconnected unexpectedly");
                    obdConnected = false;
                    bleDeviceId = null;
                    stopOBDPolling();
                    updateOBDStatus(false);
                    // GPS fuel model automatically takes over since obdConnected is now false
                }
            });
            await Preferences.set({ key: 'obdDeviceId', value: deviceId });
        }

        bleDeviceId = deviceId;
        obdConnected = true;

        // Listen for responses
        await BLE.startNotifications({
            deviceId: bleDeviceId,
            service: BLE_SERVICE,
            characteristic: BLE_NOTIFY_CHAR,
            callback: (result) => {
                const chunk = new TextDecoder().decode(
                    new Uint8Array(Object.values(result.value))
                );
                responseBuffer += chunk;
                processOBDBuffer();
            }
        });

        // Initialise ELM327
        await sendOBD('ATZ');
        await delay(1000);
        await sendOBD('ATE0');
        await sendOBD('ATL0');
        await sendOBD('ATS0');
        await sendOBD('ATH0');
        await sendOBD('ATSP0');

        updateOBDStatus(true);
        startOBDPolling();

    } catch (err) {
        console.error("OBD connect failed:", err);
        obdConnected = false;
        updateOBDStatus(false);
        if (!silent) {
            alert("Could not connect to OBD scanner: " + err.message);
        }
    }
}

async function disconnectOBD() {
    const BLE = getBLE();
    if (!BLE || !bleDeviceId) return;

    stopOBDPolling();

    try {
        await BLE.stopNotifications({
            deviceId: bleDeviceId,
            service: BLE_SERVICE,
            characteristic: BLE_NOTIFY_CHAR,
        });
        await BLE.disconnect({ deviceId: bleDeviceId });
    } catch (err) {
        console.warn("OBD disconnect error:", err);
    }

    bleDeviceId = null;
    obdConnected = false;
    updateOBDStatus(false);
    console.log("OBD disconnected");
}

function sendOBD(cmd) {
    const BLE = getBLE();
    if (!BLE || !bleDeviceId) return Promise.resolve();

    const encoded = new TextEncoder().encode(cmd + '\r');
    const value = Array.from(encoded).reduce((obj, val, i) => {
        obj[i] = val; return obj;
    }, {});

    return BLE.write({
        deviceId: bleDeviceId,
        service: BLE_SERVICE,
        characteristic: BLE_WRITE_CHAR,
        value: { buffer: encoded.buffer }
    }).catch(err => console.warn("OBD write error:", err));
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ---- Response parsing ----

const pendingResolvers = {};
let currentPID = null;

function processOBDBuffer() {
    if (!responseBuffer.includes('>')) return;

    const parts = responseBuffer.split('>');
    responseBuffer = parts.pop(); // keep incomplete part

    for (const raw of parts) {
        const cleaned = raw.trim().replace(/\s/g, '');
        if (!cleaned || cleaned === 'OK' || cleaned.startsWith('AT')) continue;

        if (currentPID && pendingResolvers[currentPID]) {
            pendingResolvers[currentPID](cleaned);
            delete pendingResolvers[currentPID];
            currentPID = null;
        }
    }
}

function queryPID(pid) {
    return new Promise((resolve) => {
        currentPID = pid;
        pendingResolvers[pid] = resolve;
        sendOBD('01' + pid);

        // Timeout after 2s
        setTimeout(() => {
            if (pendingResolvers[pid]) {
                delete pendingResolvers[pid];
                currentPID = null;
                resolve(null);
            }
        }, 2000);
    });
}

// ---- PID decoders ----

function decodeMAF(response) {
    // PID 10: MAF air flow rate
    // Response: 4110AABB → value = (AA*256 + BB) / 100 g/s
    if (!response || response.length < 8) return null;
    const aa = parseInt(response.substring(4, 6), 16);
    const bb = parseInt(response.substring(6, 8), 16);
    if (isNaN(aa) || isNaN(bb)) return null;
    return (aa * 256 + bb) / 100; // g/s
}

function decodeSpeed(response) {
    // PID 0D: vehicle speed
    // Response: 410DAA → value = AA km/h
    if (!response || response.length < 6) return null;
    const aa = parseInt(response.substring(4, 6), 16);
    if (isNaN(aa)) return null;
    return aa; // km/h
}

function mafToLPer100(mafGs, speedKph) {
    if (!speedKph || speedKph < 2) return null;
    // MAF (g/s) → fuel flow using stoichiometric ratio (14.7:1) and petrol density (750 g/L)
    const fuelFlowLPerS = mafGs / (14.7 * 750);
    const fuelFlowLPerH = fuelFlowLPerS * 3600;
    return (fuelFlowLPerH / speedKph) * 100; // L/100km
}

// ---- Polling loop ----

let obdPollInterval = null;

function startOBDPolling() {
    if (obdPollInterval) return;
    obdPollInterval = setInterval(pollOBD, 500);
}

function stopOBDPolling() {
    clearInterval(obdPollInterval);
    obdPollInterval = null;
}

async function pollOBD() {
    if (!obdConnected || !liveDrive) return;

    // Poll MAF
    const mafRaw = await queryPID('10');
    const mafGs = decodeMAF(mafRaw);

    // Poll Speed
    const speedRaw = await queryPID('0D');
    const speedKph = decodeSpeed(speedRaw);

    if (mafGs !== null) {
        // Override the GPS-based fuel model with real MAF data
        const deltaSeconds = 0.5; // polling interval
        const fuelFlowLPerS = mafGs / (14.7 * 750);
        liveDrive.fuelUsedLitres += fuelFlowLPerS * deltaSeconds;
        console.log(`MAF: ${mafGs.toFixed(2)}g/s | Fuel: ${liveDrive.fuelUsedLitres.toFixed(3)}L`);
    }

    if (speedKph !== null) {
        liveDrive.lastSpeedKph = speedKph;
    }
}

// ---- UI status ----

function updateOBDStatus(connected) {
    const btn = document.getElementById("obd-connect-btn");
    const dot = document.getElementById("obd-status-dot");
    if (!btn) return;

    if (dot) {
        dot.classList.toggle("connected", connected);
    }
}

// ============================================================
// Fuel model updates (UPDATED + NEW LOW-LOAD IMPROVEMENTS)
// ============================================================

// Smooth speed to reduce “phantom acceleration” from GPS noise
function getSmoothedSpeedKph() {
    if (!liveDrive || liveDrive.recentSpeeds.length === 0) return 0;

    const n = Math.min(SPEED_SMOOTH_WINDOW, liveDrive.recentSpeeds.length);
    const slice = liveDrive.recentSpeeds.slice(-n);

    const avg = slice.reduce((a, b) => a + b, 0) / n;
    return avg;
}

// NEW: speed standard deviation over a short window (stability detector)
function getSpeedStdKph(window = 10) {
    if (!liveDrive || liveDrive.recentSpeeds.length < 2) return 999;

    const n = Math.min(window, liveDrive.recentSpeeds.length);
    const xs = liveDrive.recentSpeeds.slice(-n);

    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const variance = xs.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / n;

    return Math.sqrt(variance);
}

// NEW: recent average speed over a SHORT window (so “urban” doesn’t get diluted by older data)
function getRecentAverageSpeedShort(window = 12) {
    if (!liveDrive || liveDrive.recentSpeeds.length === 0) return 0;

    const n = Math.min(window, liveDrive.recentSpeeds.length);
    const xs = liveDrive.recentSpeeds.slice(-n);

    return xs.reduce((a, b) => a + b, 0) / n;
}

// NEW: smooth warm-up penalty (no step-changes)
function getWarmupMultiplier() {
    // time and distance both matter; whichever is “less warmed up” dominates
    const tMin = liveDrive.activeSeconds / 60;
    const km = liveDrive.distanceKm;

    // Decay curves (tune these constants if needed)
    const timeFactor = Math.exp(-tMin / 6); // ~6 min time constant
    const distFactor = Math.exp(-km / 4);   // ~4 km distance constant

    // Up to +24% at the very start, smoothly decays toward 1.0
    const penalty = 0.3 * Math.max(timeFactor, distFactor);
    return 1 + penalty;
}

function getCruiseSmoothnessFactor(accel, speedStd) {
    // accel: kph/s, speedStd: kph

    // Normalise into 0–1 range
    const accelScore = Math.max(0, 1 - Math.abs(accel) / 0.6);
    const stdScore   = Math.max(0, 1 - speedStd / 1.2);

    // Combined smoothness
    return Math.min(1, accelScore * stdScore);
}


function updateLiveFromSpeed(speedKphRaw, deltaSeconds) {
    if (deltaSeconds <= 0) return;

    const prevDistance = liveDrive.distanceKm;

    // Use smoothed speed for detection logic
    const speedKph = speedKphRaw;
    const smoothSpeedKph = getSmoothedSpeedKph();

    // ---- ACCELERATION (smoothed) ----
    let acceleration = 0; // kph/s
    if (liveDrive.prevSmoothSpeedKph !== null) {
        acceleration = (smoothSpeedKph - liveDrive.prevSmoothSpeedKph) / deltaSeconds;
        acceleration = Math.max(-5, Math.min(acceleration, 5));
    }
    liveDrive.prevSmoothSpeedKph = smoothSpeedKph;

    // ---- DISTANCE ----
    if (speedKph >= 2) {
        updateDistance(speedKph, deltaSeconds);
    }

    if (obdConnected) return;

    const deltaDistanceKm = liveDrive.distanceKm - prevDistance;
    if (deltaDistanceKm <= 0) return;

    // =========================================================
    // STABILITY / LOW-LOAD DETECTION
    // =========================================================

    const speedStd = getSpeedStdKph(10);

    const isStable =
        speedStd < STABLE_SPEED_STD_KPH &&
        Math.abs(acceleration) < STABLE_ACCEL_KPHPS;

    const isLightLoadCruise =
        smoothSpeedKph > LIGHTLOAD_MIN_SPEED_KPH &&
        isStable &&
        speedStd < 0.7 &&
        Math.abs(acceleration) < 0.08;

    const isOverrunLike =
        smoothSpeedKph > OVERRUN_MIN_SPEED_KPH &&
        (
            acceleration < -0.35 ||
            (isStable && speedStd < 0.4)
        );

    // ---- DOWNHILL CREDIT ACCUMULATION ----
    if (isOverrunLike) {
        liveDrive.downhillCreditKm += deltaDistanceKm;
    }

    const isCoasting =
        smoothSpeedKph > 20 &&
        acceleration < -0.5;

    // =========================================================
    // BASELINE (vehicle state, NOT driving style)
    // =========================================================

    let baseLPer100 = LITRES_PER_100KM;

    // Warm-up affects baseline efficiency only
    baseLPer100 *= getWarmupMultiplier();

    // =========================================================
    // BEHAVIOURAL MULTIPLIERS
    // =========================================================

    let fuelMultiplier = 1;

    // Acceleration penalty
    if (acceleration > 1.5) fuelMultiplier *= 1.35;
    else if (acceleration > 0.5) fuelMultiplier *= 1.12;

    // ---- Speed efficiency curve ----
    let speedEfficiency = 1;

    const PLATEAU_MIN_KPH = 55;
    const PLATEAU_MAX_KPH = 75;

    if (smoothSpeedKph < PLATEAU_MIN_KPH) {
        const diff = PLATEAU_MIN_KPH - smoothSpeedKph;
        speedEfficiency = 1 + (diff / PLATEAU_MIN_KPH) * SPEED_EFF_STRENGTH;
    } else if (smoothSpeedKph > PLATEAU_MAX_KPH) {
        const diff = smoothSpeedKph - PLATEAU_MAX_KPH;
        speedEfficiency = 1 + (diff / OPTIMAL_SPEED_KPH) * SPEED_EFF_STRENGTH;
    }

    fuelMultiplier *= speedEfficiency;

    // ---- Steady cruise bonus ----
    const cruiseSmoothness = getCruiseSmoothnessFactor(acceleration, speedStd);

    if (smoothSpeedKph >= 60 && smoothSpeedKph <= 105) {
        const cruiseBonus =
            1 - cruiseSmoothness * (1 - STEADY_CRUISE_MULT);
        fuelMultiplier *= cruiseBonus;
    }

    // ---- Gentle flow ----
    const isGentleFlow =
        smoothSpeedKph >= 45 &&
        smoothSpeedKph <= 80 &&
        Math.abs(acceleration) < 0.35 &&
        speedStd < 1.2;

    if (isGentleFlow && cruiseSmoothness < 0.5) {
        fuelMultiplier *= GENTLE_FLOW_MULT;
    }

    // ---- Coasting reduction ----
    if (isCoasting && smoothSpeedKph > 10) {
        fuelMultiplier *= COASTING_REDUCTION;
    }

    // ---- Urban penalty (recent context only) ----
    let urbanMultiplier = 1;
    const avgSpeedKphRecent = getRecentAverageSpeedShort(12);

    const isRollingRural =
        smoothSpeedKph > 40 &&
        speedStd < 1.9 &&
        Math.abs(acceleration) < 0.6;

    if (
        avgSpeedKphRecent < 28 &&
        smoothSpeedKph < 38 &&
        !isRollingRural &&
        speedStd > 1.6
    ) {
        urbanMultiplier = 1.15;
    }


    fuelMultiplier *= urbanMultiplier;

    // Cap runaway behaviour
    fuelMultiplier = Math.min(fuelMultiplier, 2.0);

    // =========================================================
    // EFFECTIVE CONSUMPTION + LOW-LOAD CLAMPS
    // =========================================================

    let effectiveLPer100 = baseLPer100 * fuelMultiplier;

    // Stable light-load cruise clamp
    if (
        isLightLoadCruise ||
        (smoothSpeedKph > 45 && speedStd < 0.8 && Math.abs(acceleration) < 0.15)
    ) {
        effectiveLPer100 = Math.min(
            effectiveLPer100,
            MIN_L_PER_100KM_CRUISE
        );
    }

    // Overrun / downhill clamp
    if (isOverrunLike && acceleration <= 0) {
        effectiveLPer100 = Math.min(
            effectiveLPer100,
            MIN_L_PER_100KM_OVERRUN
        );
    }

    if (!Number.isFinite(effectiveLPer100) || effectiveLPer100 < 0) return;

    // =========================================================
    // DOWNHILL CREDIT PAYBACK
    // =========================================================

    if (!isOverrunLike && liveDrive.downhillCreditKm > 0 && !isLightLoadCruise) {
        const paybackKm = Math.min(deltaDistanceKm, liveDrive.downhillCreditKm);

        const paybackFuel =
            (paybackKm / 100) *
            LITRES_PER_100KM *
            DOWNHILL_PAYBACK_MULT;

        liveDrive.fuelUsedLitres += paybackFuel;
        liveDrive.downhillCreditKm -= paybackKm;
    }

    // =========================================================
    // FINAL FUEL USE
    // =========================================================

    liveDrive.fuelUsedLitres +=
        (deltaDistanceKm / 100) * effectiveLPer100;
}


// Kept for any other parts of your app that might still call it
function getRecentAverageSpeed() {
    if (!liveDrive || liveDrive.recentSpeeds.length === 0) return 0;
    return liveDrive.recentSpeeds.reduce((a, b) => a + b, 0) / liveDrive.recentSpeeds.length;
}

/////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////


////////////////////////
// Start/Stop/Pause button logic
////////////////////////

const appState = { 
    mode: "idle",
    paused: false
};

function enterDrivingMode() {
    appState.mode = "driving";
    document.getElementById("driving-mode").classList.remove("hidden");
}

function exitDrivingMode() {
    appState.mode = "idle";
    document.getElementById("driving-mode").classList.add("hidden");
}

function updatePauseIcon() {
    const icon = document.querySelector("#pause-btn i");

    if (appState.paused) {
        icon.classList.remove("fa-pause");
        icon.classList.add("fa-play");
    } else {
        icon.classList.remove("fa-play");
        icon.classList.add("fa-pause");
    }
}

function resetPauseIcon() {
    const icon = document.querySelector("#pause-btn i");

    if (icon.classList.contains("fa-play")) {
        icon.classList.remove("fa-play");
        icon.classList.add("fa-pause");
    }
}

const startBtn = document.getElementById("top-bar-start-btn");
const stopBtn = document.getElementById("stop-btn");
const pauseBtn = document.getElementById("pause-btn");

startBtn.addEventListener("click", () => {
    enterDrivingMode();
    startDrive();
    startGPS();
});
stopBtn.addEventListener("click",async () => {
    stopGPS();
    await disconnectOBD();
    await stopDrive();
    resetPauseIcon();
    exitDrivingMode();
    await refreshPages();
});
pauseBtn.addEventListener("click", () => {
    appState.paused = !appState.paused;

    if (appState.paused) {
        stopGPS();
    } else {
        startGPS();
    }

    updatePauseIcon();
});


////////////////////////
// Dark/Light mode logic
////////////////////////

function updateThemeIcon() {
    const icon = document.querySelector("#top-bar-mode-btn i");

    if (!icon) return;
    if (document.body.classList.contains("dark")) {
        icon.classList.remove("fa-moon");
        icon.classList.add("fa-sun");
    } else {
        icon.classList.remove("fa-sun");
        icon.classList.add("fa-moon");
    }
}

async function toggleDarkMode() {
    document.body.classList.toggle("dark");
    const isDark = document.body.classList.contains("dark");
    await setStatusBarColor(isDark);
    await Preferences.set({
        key: 'theme',
        value: isDark ? "dark" : "light"
    });
    updateThemeIcon();
}

const switcherBtn = document.getElementById("top-bar-mode-btn");
switcherBtn.addEventListener("click", toggleDarkMode);

//////////////////////// Home Page ////////////////////////

async function updateFuelPrice() {
    const fuelPriceText = document.getElementById("fuel-price");
    if (!fuelPriceText) return;

    let price = null;

    try {
        // Read location if available
        const locationJson = (await Preferences.get({ key: "location" })).value;
        const location = locationJson ? JSON.parse(locationJson) : null;

        const lat = location?.latitude ?? null;
        const lng = location?.longitude ?? null;

        // Call worker
        price = await getLocalE10Price(lat, lng);

        if (Number.isFinite(price)) {
            await Preferences.set({ key: "fuelPrice", value: price.toString() });
            fuelPriceText.textContent = price.toFixed(1);
            console.log("Fuel price updated:", price.toFixed(1));
            return;
        }

        console.warn("Worker returned invalid price, will use fallback");
    } catch (err) {
        console.warn("Fuel price fetch failed, using fallback", err);
    }

    // Only reach here if worker failed or returned invalid value
    const stored = Number((await Preferences.get({ key: "fuelPrice" })).value);
    const fallback = Number.isFinite(stored) ? stored : DEFAULT_FUEL_PRICE;
    fuelPriceText.textContent = fallback.toFixed(1);
    console.log("Fuel price fallback:", fallback.toFixed(1));
}


async function getLocalE10Price(lat, lng) {
    const url = new URL("https://fuel-price-proxy.archie-moon04.workers.dev/");

    if (Number.isFinite(lat) && Number.isFinite(lng)) {
        url.searchParams.set("lat", lat);
        url.searchParams.set("lng", lng);
        url.searchParams.set("radius", 10);
    }

    const res = await fetch(url.toString());
    console.log("Worker response status:", res.status);

    if (!res.ok) {
        const text = await res.text(); // read body for debug
        console.warn("Worker returned error body:", text);
        throw new Error("Worker failed");
    }

    const data = await res.json();

    return Number.isFinite(data.avgE10PencePerLitre)
        ? data.avgE10PencePerLitre
        : null;
}

const obdBtn = document.getElementById("obd-connect-btn");
obdBtn.addEventListener("click", async () => {
    if (obdConnected) {
        await disconnectOBD();
    } else {
        await connectOBD();
    }
});

////////////////////////
// Recent Trips 
////////////////////////

async function renderRecentTrips() {
    const recentTripsPanel =
        document.getElementById("recent-trips-overview-content");
    recentTripsPanel.innerHTML = "";

    const drives = JSON.parse((await Preferences.get({ key: "drives" })).value || "[]");
    if (drives.length === 0) return;

    // How many trips to show (max 3)
    const count = Math.min(3, drives.length);

    for (let i = 0; i < count; i++) {
        const drive = drives[drives.length - 1 - i];

        // ---- create cell ----
        const cell = document.createElement("div");
        cell.style.position = "relative";
        cell.style.height = "35px";
        cell.style.borderRadius = "15px";
        cell.style.display = "flex";
        cell.style.alignItems = "center";
        cell.style.justifyContent = "center";
        cell.style.fontSize = "12px";
        cell.style.fontWeight = "700";
        cell.style.color = "var(--text-main)";
        cell.style.backgroundColor = "var(--internal-container)";
        cell.style.boxShadow = "0 0px 4px 0 var(--shadow)";
        cell.style.marginBottom = "8px";

        cell.textContent =
            drive.date + " @ " +
            await formatTime(i) + " | " +
            drive.distanceMiles + "mi | " +
            await formatDuration(i) + " | " +
            drive.estimatedMPG + "mpg";

        recentTripsPanel.appendChild(cell);
    }
}

async function formatDuration(i) {
    const drives = JSON.parse((await Preferences.get({ key: "drives" })).value || "[]");
    if (drives.length === 0) return;

    const drive = drives[drives.length - 1 - i];

    // ---- duration formatting ----
    const duration = drive.durationSeconds;
    let formattedDuration;
    let suffix = "s";

    if (duration < 60) {
        formattedDuration = duration;
    } else if (duration < 3600) {
        formattedDuration = (duration / 60).toFixed(1);
        suffix = "min";
    } else {
        formattedDuration = (duration / 3600).toFixed(2);
        suffix = "hr";
    }
    return `${formattedDuration}${suffix}`;
}

async function formatTime(i) {
    const drives = JSON.parse((await Preferences.get({ key: "drives" })).value || "[]");
    if (drives.length === 0) return;

    const drive = drives[drives.length - 1 - i];

    const startTime = new Date(drive.startTime);

    const hours = startTime.getHours().toString().padStart(2, "0");
    const minutes = startTime.getMinutes().toString().padStart(2, "0");

    return `${hours}:${minutes}`;
}

////////////////////////
// Fuel Panel
////////////////////////
const refuelBtn = document.getElementById("refuel-btn");
const refuelPanel = document.getElementById("refuel-panel");
const icon = document.querySelector("#refuel-btn i");

refuelBtn.addEventListener("click", () => {
    refuelPanel.classList.toggle("invisible");
    
    updateIcon();
});

function updateIcon() {
    if (!icon) return;
    if (refuelPanel.classList.contains("invisible")) {
        icon.classList.remove("fa-chevron-up");
        icon.classList.add("fa-fill-drip");
    } else {
        icon.classList.remove("fa-fill-drip");
        icon.classList.add("fa-chevron-up");
    }
}

const refuelInput = document.getElementById("refuel-input");
const confirmRefuelBtn = document.getElementById("confirm-refuel-btn");
const fillTankBtn = document.getElementById("fill-tank-btn");

confirmRefuelBtn.addEventListener("click", async () => {
    const money = Number(refuelInput.value);
    if (!money || money <= 0){
        alert("Please enter a valid amount");
        return;
    };

    const fuelPrice =  Number((await Preferences.get({ key: "fuelPrice" })).value);
    if (!fuelPrice) {
        alert("Fuel price not set");
        return;
    }

    const litresToAdd = money / (fuelPrice/100);

    addFuel(litresToAdd);

    refuelInput.value = "";
    refuelPanel.classList.add("invisible");
    updateIcon();
});

fillTankBtn.addEventListener("click", async () => {
    Preferences.set({ key: "fuelRemaining", value: "44" });
    updateFuelDisplay();
    refuelPanel.classList.add("invisible");
    updateIcon();
});

async function updateFuelDisplay() {
    let currentFuel = Number((await Preferences.get({ key: "fuelRemaining" })).value) ?? 44;

    Preferences.set({ key: "fuelRemaining", value: currentFuel.toString() });

    const percent = (currentFuel / 44) * 100;

    const fuelBar = document.getElementById("fuel-estimation-value");

    fuelBar.style.width = percent + "%";

    // Low fuel warnings
    if (percent <= 25) {
        fuelBar.className = "low-fuel";
    } else if (percent <= 50) {
        fuelBar.className = "med-fuel";
    } else {
        fuelBar.className = "";
    }
}

async function updateFuelRemaining(fuelUsed) {
    let currentFuel = Math.max(0, Number((await Preferences.get({ key: "fuelRemaining" })).value) - fuelUsed);
    Preferences.set({ key: "fuelRemaining", value: currentFuel.toString() });
    updateFuelDisplay();
}

async function addFuel(amount) {
    let currentFuel = Number((await Preferences.get({ key: "fuelRemaining" })).value) || 0;

    let newFuel = Math.min(44, currentFuel + amount);

    Preferences.set({ key: "fuelRemaining", value: newFuel.toString() });
    updateFuelDisplay();
}

//function addFuel(amount) {
    //currentFuel = Math.max(0, currentFuel - amount);
    //localStorage.setItem("fuelRemaining", currentFuel);
    //updateFuelDisplay();
//}

//////////////////////// Trips Page ////////////////////////
async function renderAllTrips() {
    const tripsPage = document.getElementById("recent-trips-page-content");
    tripsPage.innerHTML = "";

    const drives = JSON.parse((await Preferences.get({ key: "drives" })).value || "[]");
    if (drives.length === 0) return;

    // How many trips to show (max 3)
    const count = drives.length;

    for (let i = 0; i < count; i++) {
        const drive = drives[drives.length - 1 - i];

        const cell = document.createElement("div");
        cell.style.position = "relative";
        cell.style.height = "80px";
        cell.style.borderRadius = "15px";
        cell.style.display = "flex";
        cell.style.alignItems = "center";
        cell.style.justifyContent = "space-between";
        cell.style.fontSize = "12px";
        cell.style.fontWeight = "700";
        cell.style.backgroundColor = "var(--bg-panel)";
        cell.style.color = "var(--text-main)";
        cell.style.boxShadow = "0 0px 4px 0 var(--shadow)";
        cell.style.margin = "10px 2px 8px 2px";
        cell.style.padding = "0 12px";

        // ---- text ----
        const text = document.createElement("div");
        text.style.display = "flex";
        text.style.flexDirection = "column";
        text.style.lineHeight = "1.2";

        // ---- line 1 ----
        const line1 = document.createElement("span");
        line1.textContent = `${drive.date} @ ${await formatTime(i)}`;
        line1.style.fontSize = "16px";
        line1.style.fontWeight = "700";

        // ---- line 2 ----
        const line2 = document.createElement("span");

        const price =
            Number.isFinite(drive.fuelCost)
                ? drive.fuelCost
                : (drive.fuelUsedLitres * (DEFAULT_FUEL_PRICE/100)); // if no price saved, revert to fixed value

        line2.style.whiteSpace = "pre-line";
        line2.textContent = 
            `${await formatDuration(i)} | ${drive.distanceMiles}mi | ${drive.averageSpeedMPH}mph
            ${drive.estimatedMPG}mpg | ${drive.fuelUsedLitres}l | £${price.toFixed(2)}`;
        line2.style.fontSize = "15px";
        line2.style.fontWeight = "600";
        line2.style.color = "var(--text-accent)";

        // ---- delete button ----
        const deleteButton = document.createElement("button");
        deleteButton.className = "fa-solid fa-trash-can";
        deleteButton.style.borderRadius = "50%";
        deleteButton.style.backgroundColor = "var(--red-accent)";
        deleteButton.style.boxShadow = "0 0px 5px 0 var(--red-accent)";
        deleteButton.style.color = "white";
        deleteButton.style.border = "none";
        deleteButton.style.width = "30px";
        deleteButton.style.height = "30px";
        deleteButton.style.cursor = "pointer";

        deleteButton.onclick = () => {
            deleteDriveByStartTime(drive.startTime);
            let fuelUsed = Number(drive.fuelUsedLitres) || 0;
            addFuel(fuelUsed);
            cell.remove();
        };

        text.appendChild(line1);
        text.appendChild(line2);
        cell.appendChild(text);
        cell.appendChild(deleteButton);

        tripsPage.appendChild(cell);
    }
}

async function deleteDriveByStartTime(startTime) {
    const drives = JSON.parse((await Preferences.get({ key: "drives" })).value || "[]");

    const updatedDrives = drives.filter(
        drive => drive.startTime !== startTime
    );

    await Preferences.set({ 
        key: 'drives', 
        value: JSON.stringify(updatedDrives) 
    });
}

//////////////////////// Stats Page ////////////////////////

function normalizeDrive(drive) {
    return {
        startTime: Number(drive.startTime),
        distanceMiles: Number(drive.distanceMiles),
        durationSeconds: Number(drive.durationSeconds),
        fuelUsedLitres: Number(drive.fuelUsedLitres),
        fuelCost: Number(drive.fuelCost),
        averageSpeedMPH: Number(drive.averageSpeedMPH),
        estimatedMPG: Number(drive.estimatedMPG)
    };
}

function getStartOfCurrentWeekMonday() {
    const now = new Date();
    const day = now.getDay();

    // Convert so Monday = 0, Sunday = 6
    const diffToMonday = (day + 6) % 7;

    const monday = new Date(now);
    monday.setDate(now.getDate() - diffToMonday);
    monday.setHours(0, 0, 0, 0);

    return monday.getTime();
}

async function getDrivesForPeriod(period) {
    const drives =
        (JSON.parse((await Preferences.get({ key: "drives" })).value || "[]"))
            .map(normalizeDrive);

    if (period === "lifetime") return drives;

    const now = Date.now();
    let cutoff;

    switch (period) {
        case "week":
            cutoff = getStartOfCurrentWeekMonday();
            break;
        case "month":
            cutoff = now - 30 * 24 * 60 * 60 * 1000;
            break;
        case "year":
            cutoff = now - 365 * 24 * 60 * 60 * 1000;
            break;
        default:
            return drives;
    }

    return drives.filter(d => d.startTime >= cutoff);
}

function calculateStats(drives) {
    if (drives.length === 0) {
        return {
            drives: 0,
            miles: 0,
            hours: 0,
            avgMPG: 0,
            avgSpeed: 0,
            fuelCost: 0
        };
    }

    let totalMiles = 0;
    let totalSeconds = 0;
    let totalFuelLitres = 0;
    let totalFuelCost = 0;

    drives.forEach(d => {
        const miles = Number(d.distanceMiles);
        const seconds = Number(d.durationSeconds);
        const litres = Number(d.fuelUsedLitres);
        const cost = Number(d.fuelCost);

        totalMiles += Number.isFinite(miles) ? miles : 0;
        totalSeconds += Number.isFinite(seconds) ? seconds : 0;
        totalFuelLitres += Number.isFinite(litres) ? litres : 0;
        totalFuelCost += Number.isFinite(cost) ? cost : 0;
    });

    const hours = totalSeconds / 3600;

    return {
        drives: drives.length,
        miles: totalMiles,
        hours,
        avgMPG:
            totalFuelLitres > 0
                ? (totalMiles / (totalFuelLitres * 0.219969)) * MPG_CALIBRATION
                : 0,
        avgSpeed:
            hours > 0 ? totalMiles / hours : 0,
        fuelCost: totalFuelCost
    };
}

async function getStats(period) {
    return calculateStats(await getDrivesForPeriod(period));
}

// ---------- UI helpers ----------

function createStatItem(label, value) {
    const item = document.createElement("div");
    item.style.display = "flex";
    item.style.flexDirection = "column";
    item.style.alignItems = "center";
    item.style.justifyContent = "center";

    const valueEl = document.createElement("div");
    valueEl.textContent = value;
    valueEl.style.fontSize = "18px";
    valueEl.style.fontWeight = "500";
    valueEl.style.color = "var(--text-accent)";

    const labelEl = document.createElement("div");
    labelEl.textContent = label;
    labelEl.style.fontSize = "18px";
    labelEl.style.fontWeight = "600";
    labelEl.style.color = "var(--text-main)";

    item.appendChild(valueEl);
    item.appendChild(labelEl);

    return item;
}

async function createStatsCard(period, titleText) {
    const stats = await getStats(period);

    const cell = document.createElement("div");
    cell.style.position = "relative";
    cell.style.height = "255px";
    cell.style.borderRadius = "15px";
    cell.style.display = "flex";
    cell.style.alignItems = "center";
    cell.style.backgroundColor = "var(--bg-panel)";
    cell.style.boxShadow = "0 0px 10px 0 var(--shadow)";
    cell.style.margin = "16px 2px";
    cell.style.padding = "0 12px";

    const title = document.createElement("div");
    title.textContent = titleText;
    title.style.position = "absolute";
    title.style.top = "13px";
    title.style.left = "50%";
    title.style.color = "var(--text-main)";
    title.style.transform = "translateX(-50%)";
    title.style.fontSize = "22px";
    title.style.fontWeight = "600";

    cell.appendChild(title);

    const innerCell = document.createElement("div");
    innerCell.style.height = "165px";
    innerCell.style.width = "100%";
    innerCell.style.borderRadius = "15px";
    innerCell.style.display = "grid";
    innerCell.style.gridTemplateColumns = "1fr 1fr";
    innerCell.style.gridTemplateRows = "1fr 1fr 1fr";
    innerCell.style.gap = "8px";
    innerCell.style.margin = "140px 2px 102px 2px";
    innerCell.style.backgroundColor = "var(--internal-container)";
    innerCell.style.boxShadow = "0 0px 4px 0 var(--shadow)";
    innerCell.style.padding = "12px";

    innerCell.appendChild(createStatItem("Drives", stats.drives));
    innerCell.appendChild(createStatItem("Miles", stats.miles.toFixed(1)));
    innerCell.appendChild(createStatItem("Hours", stats.hours.toFixed(2)));
    innerCell.appendChild(createStatItem("Avg Speed", stats.avgSpeed.toFixed(1) + " mph"));
    innerCell.appendChild(createStatItem("Avg MPG", stats.avgMPG.toFixed(1)));
    innerCell.appendChild(createStatItem("Fuel Cost", "£" + stats.fuelCost.toFixed(2)));

    cell.appendChild(innerCell);

    return cell;
}

// ---------- Main render ----------

async function renderStats() {
    const statsPage = document.getElementById("stats-page-content");
    statsPage.innerHTML = "";

    statsPage.style.paddingTop = "60px";
    statsPage.style.paddingBottom = "60px";

    statsPage.appendChild(await createStatsCard("week", "This Week"));
    statsPage.appendChild(await createStatsCard("month", "Last 30 days"));
    statsPage.appendChild(await createStatsCard("year", "Yearly Stats"));
    statsPage.appendChild(await createStatsCard("lifetime", "Lifetime Stats"));
}

//////////////////////// Profile Page ////////////////////////

async function updateProfileStats() {
    const drives = JSON.parse((await Preferences.get({ key: "drives" })).value || "[]");

    document.getElementById("total-drives").textContent = 0;
    document.getElementById("total-miles").textContent = 0;
    document.getElementById("total-hours").textContent = "0.00";

    if (drives.length === 0) return;

    const totalDrives = drives.length;

    const totalDrivestext = document.getElementById("total-drives")
    totalDrivestext.textContent = totalDrives;

    const totalMiles = drives.reduce(
        (sum, miles) => sum + Number(miles.distanceMiles),
        0
    );

    const totalMilestext = document.getElementById("total-miles")
    totalMilestext.textContent = totalMiles.toFixed(0);


    const totalDuration = drives.reduce(
        (sum, duration) => sum + duration.durationSeconds,
        0
    );

    const totalHoursText = document.getElementById("total-hours")

    const totalHours = totalDuration / 3600;

    if (totalHours < 0.01 && totalHours > 0){
        totalHoursText.textContent = 0.01;
    } else if (totalHours === 0){
        totalHoursText.textContent = 0.0;
    } else {
        totalHoursText.textContent = totalHours.toFixed(2);
    }
}

const versionBtn = document.getElementById("release-version-btn")
versionBtn.addEventListener("click", () => {
    const confirmed = confirm(
        "Current Release Version: v1.1.8"
    );

    if (!confirmed) return;
});

const editBtn = document.getElementById("edit-profile-btn")
editBtn.addEventListener("click", async () => {
    const value = prompt(
        "Please enter a new basline mpg\n(Your cars mpg on a ~1hr long drive)\n\nCurrent Baseline: " + (await Preferences.get({ key: "baselineMPG" })).value + "mpg\n\nNote: This should be calibrated in comparison to your cars trip computer over multiple drives for the best results.",
        ""
    );

    if (value === null) return; // user cancelled

    const number = Number(value);

    if (Number.isNaN(number) || number < 10) {
        alert("Please enter a valid number > 10.");
        return;
    }

    // Save the new baseline MPG to localStorage
    Preferences.set({ key: "baselineMPG", value: number.toString() });
    await refreshPages();
});

const setHomeBtn = document.getElementById("set-profile-home-btn");
setHomeBtn.addEventListener("click", async () => {
    const confirmed = confirm(
        "Are you sure you want to set your current location as your Home?\n\nThis is used to obtain your local fuel price.\n\nNo location will revert to national average price."
    );

    if (!confirmed) return;
    console.log("Attempting geolocation...");
    try {
        const position = await new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, { 
                enableHighAccuracy: true, 
                timeout: 10000 
            });
        });

        const location = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude
        };

        console.log("Location saved:", location);
        await Preferences.set({ key: "location", value: JSON.stringify(location) });
        await updateFuelPrice();
        await refreshPages();

    } catch (err) {
        console.error("Geolocation failed:", err);
        alert("Could not get location: " + err.message);
    }
});

const resetBtn = document.getElementById("reset-profile-btn")
resetBtn.addEventListener("click", async () => {
    const confirmed = confirm(
        "Are you sure you want to reset your profile?\n\nThis will delete all saved data."
    );

    if (!confirmed) return;

    await Preferences.clear();
    await init();
    await refreshPages();

    const fuelPriceText = document.getElementById("fuel-price");
    if (fuelPriceText) {
        fuelPriceText.textContent = "000.0";
    }
});

async function updateProfileButtons() {
    const carBtn = document.getElementById("edit-profile-btn");
    const homeBtn = document.getElementById("set-profile-home-btn");

    const hasMpg = !!(await Preferences.get({ key: "baselineMPG" })).value;
    const hasHome = !!(await Preferences.get({ key: "location" })).value;

    setButtonState(carBtn, hasMpg);
    setButtonState(homeBtn, hasHome);
}

function setButtonState(button, isReady) {
    button.classList.remove("warning", "ready");
    button.classList.add(isReady ? "ready" : "warning");
}

updateProfileButtons();


////////////////////////
// Bottom Nav btns
////////////////////////

function setActiveNav(buttonId) {
    document.querySelectorAll(".nav-btn")
    .forEach(btn => btn.classList.remove("active"));

    document.getElementById(buttonId).classList.add("active");
}

function showPage(pageId) {
    const pages = document.querySelectorAll(".page");

    pages.forEach(page => {
        page.classList.remove("active");
    });

    document.getElementById(pageId).classList.add("active");
}

document.getElementById("home-btn")
.addEventListener("click", () => {
    showPage("home-page");
    renderHomePage();
    setActiveNav("home-btn");
});

document.getElementById("compass-btn")
.addEventListener("click", () => {
    showPage("recent-trips-page");
    renderAllTrips();
    setActiveNav("compass-btn");
});

document.getElementById("stats-btn")
.addEventListener("click", () => {
    showPage("statistics-page");
    renderStats();
    setActiveNav("stats-btn");
});

document.getElementById("profile-btn")
.addEventListener("click", () => {
    showPage("profile-page");
    updateProfileStats();
    setActiveNav("profile-btn");
});

async function refreshPages() {
    await renderRecentTrips();
    await renderAllTrips();
    await renderStats();
    await updateProfileStats();
    await updateProfileButtons();
}

function renderHomePage() {
    renderRecentTrips();
}

updateFuelPrice();
updateFuelDisplay();
