

renderHomePage()

////////////////////////
// Data Tracking Logic
////////////////////////
// ============================================================
// LIVE DRIVE TRACKING + FUEL MODEL (UPDATED + COPY/PASTE READY)
// - Keeps your existing functionality
// - Adds: speed smoothing for acceleration, steady-cruise bonus,
//         more realistic warm-up decay, and smoother speed efficiency
// ============================================================

let liveDrive = null;
let timeInterval = null;

// -------------------- Tunable constants --------------------
// Baseline economy model
const LITRES_PER_100KM = 5.3;

// Idle consumption
const IDLE_LITRES_PER_HOUR = 0.8; // realistic range: 0.5–1.0

// Calibrate MPG output to your car (keep using your existing value)
const MPG_CALIBRATION = 0.985;

// --- New tuning knobs (start here, adjust later if needed) ---
const SPEED_SMOOTH_WINDOW = 10;      // last N GPS samples used for smoothing accel
const STEADY_CRUISE_MULT = 0.84;     // 0.78–0.90 (lower = more efficient cruising)
const OPTIMAL_SPEED_KPH = 85;        // ~53 mph sweet spot
const SPEED_EFF_STRENGTH = 0.15;     // higher = bigger penalty away from optimal
const COASTING_REDUCTION = 0.70;     // 0.6–0.85 (closer to 1 = less “free” coasting)

// -------------------- Core drive lifecycle --------------------

function startDrive() {
    const now = Date.now();

    liveDrive = {
        startTime: now,
        lastSpeedKph: 0,
        recentSpeeds: [],
        lastGpsTime: null,
        prevSmoothSpeedKph: null, // <-- changed: track smoothed speed for acceleration
        activeSeconds: 0,
        distanceKm: 0,
        fuelUsedLitres: 0
    };

    startActiveTimer();
}

function startActiveTimer() {
    if (timeInterval) return;

    timeInterval = setInterval(() => {
        if (!liveDrive) return;
        if (appState.paused) return;

        liveDrive.activeSeconds += 1;

        // IDLE FUEL (time-based)
        if (liveDrive.lastSpeedKph < 3) {
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

function stopDrive() {
    stopActiveTimer();
    appState.paused = false;

    const iso = new Date().toISOString().split("T")[0];
    const [y, m, d] = iso.split("-");
    const formattedDate = `${d}/${m}/${y}`;

    const fuelPricePerL = Number(localStorage.getItem("fuelPrice")) || 0;
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

    const drives = JSON.parse(localStorage.getItem("drives")) || [];
    drives.push(driveSummary);
    localStorage.setItem("drives", JSON.stringify(drives));

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

    // Store recent speeds for smoothing
    liveDrive.recentSpeeds.push(speedKph);
    if (liveDrive.recentSpeeds.length > 60) liveDrive.recentSpeeds.shift();

    const now = position.timestamp;

    if (!liveDrive.lastGpsTime) {
        liveDrive.lastGpsTime = now;
        liveDrive.prevSmoothSpeedKph = getSmoothedSpeedKph(); // init smoothed speed
        return;
    }

    const deltaSeconds = (now - liveDrive.lastGpsTime) / 1000;
    liveDrive.lastGpsTime = now;

    updateLiveFromSpeed(speedKph, deltaSeconds);

    // Debug UI (same as your original)
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
// Fuel model updates (UPDATED)
// ============================================================

// Smooth speed to reduce “phantom acceleration” from GPS noise
function getSmoothedSpeedKph() {
    if (!liveDrive || liveDrive.recentSpeeds.length === 0) return 0;

    const n = Math.min(SPEED_SMOOTH_WINDOW, liveDrive.recentSpeeds.length);
    const slice = liveDrive.recentSpeeds.slice(-n);

    const avg = slice.reduce((a, b) => a + b, 0) / n;
    return avg;
}

function updateLiveFromSpeed(speedKphRaw, deltaSeconds) {
    if (deltaSeconds <= 0) return;

    const prevDistance = liveDrive.distanceKm;

    // Use smoothed speed for acceleration + cruise detection
    const speedKph = speedKphRaw;              // keep raw for distance gating
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

    const deltaDistanceKm = liveDrive.distanceKm - prevDistance;

    // ---- COASTING / ENGINE BRAKING ----
    const isCoasting = smoothSpeedKph > 20 && acceleration < -0.5;

    // ---- FUEL MULTIPLIER ----
    let fuelMultiplier = 1;

    // Acceleration penalty (use smoothed accel)
    if (acceleration > 1.5) fuelMultiplier *= 1.35;
    else if (acceleration > 0.5) fuelMultiplier *= 1.12;

    // ---- Speed efficiency (smooth "bowl" curve around optimal speed) ----
    // 1.0 near OPTIMAL_SPEED_KPH, gradually worse as you move away
    const diff = Math.abs(smoothSpeedKph - OPTIMAL_SPEED_KPH);
    const speedEfficiency = 1 + (diff / OPTIMAL_SPEED_KPH) * SPEED_EFF_STRENGTH;
    fuelMultiplier *= speedEfficiency;

    // ---- Steady cruising bonus (your missing piece) ----
    // Reward gentle, steady throttle in the 70–105 kph band (A-road/dual carriageway cruising)
    const isSteadyCruise =
        smoothSpeedKph >= 70 &&
        smoothSpeedKph <= 105 &&
        Math.abs(acceleration) < 0.15;

    if (isSteadyCruise) {
        fuelMultiplier *= STEADY_CRUISE_MULT;
    }

    // ---- Coasting reduction (reduced fuel flow, not zero) ----
    if (isCoasting && smoothSpeedKph > 10) {
        fuelMultiplier *= COASTING_REDUCTION;
    }

    // ---- Warm-up penalty (distance + time aware) ----
    // Warm-up fades faster if you've covered distance (engine under load)
    let warmupMultiplier = 1;
    const minutes = liveDrive.activeSeconds / 60;
    const km = liveDrive.distanceKm;

    if (minutes < 5 && km < 5) warmupMultiplier = 1.22;
    else if (minutes < 8 && km < 8) warmupMultiplier = 1.10;

    // ---- Urban penalty (only when consistently slow) ----
    let urbanMultiplier = 1;
    const avgSpeedKphRecent = getRecentAverageSpeed();

    if (avgSpeedKphRecent < 25 && smoothSpeedKph < 35) {
        urbanMultiplier = 1.18;
    }

    const combinedMultiplier = fuelMultiplier * warmupMultiplier * urbanMultiplier;
    const cappedMultiplier = Math.min(combinedMultiplier, 2.0);

    // ---- FUEL USE ----
    if (speedKph >= 2 && deltaDistanceKm > 0) {
        liveDrive.fuelUsedLitres +=
            (deltaDistanceKm / 100) *
            LITRES_PER_100KM *
            cappedMultiplier;
    }
}

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
stopBtn.addEventListener("click", () => {
    stopGPS();
    stopDrive();
    resetPauseIcon();
    exitDrivingMode();
    refreshPages();
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

const savedTheme = localStorage.getItem("theme");

if (savedTheme === "dark") {
    document.body.classList.add("dark");
}

updateThemeIcon();

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

function toggleDarkMode() {
    document.body.classList.toggle("dark");

    localStorage.setItem(
    "theme",
    document.body.classList.contains("dark") ? "dark" : "light"
    );

    updateThemeIcon();
}

const switcherBtn = document.getElementById("top-bar-mode-btn");
switcherBtn.addEventListener("click", toggleDarkMode);

//////////////////////// Home Page ////////////////////////

async function updateFuelPrice() {
        try {
            const location = JSON.parse(localStorage.getItem("location"));
            console.log(location.latitude, location.longitude);

            const price = await getLocalE10Price(
                location.latitude,
                location.longitude
            );

            if (price == null) {
                console.warn("Fuel price unavailable");
                return;
            }

            localStorage.setItem("fuelPrice", price);

            const fuelPriceText = document.getElementById("fuel-price");
            if (!fuelPriceText) return;
            fuelPriceText.textContent = price.toFixed(1);

            console.log("Local E10:", price.toFixed(1), "p/L");
        } catch (err) {
            console.error("Failed to update fuel price", err);
        }
}

async function getLocalE10Price(lat, lng) {
    const res = await fetch(
        `https://fuel-price-proxy.archie-moon04.workers.dev/?lat=${lat}&lng=${lng}&radius=10`
    );
    const data = await res.json();
    return data.avgE10PencePerLitre;
}


////////////////////////
// Recent Trips 
////////////////////////

function renderRecentTrips() {
    const recentTripsPanel =
        document.getElementById("recent-trips-overview-content");
    recentTripsPanel.innerHTML = "";

    const drives = JSON.parse(localStorage.getItem("drives")) || [];
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
        cell.style.boxShadow = "0 0px 4px 0 var(--shadow)";
        cell.style.marginBottom = "8px";

        cell.textContent =
            drive.date + " @ " +
            formatTime(i) + " | " +
            drive.distanceMiles + "mi | " +
            formatDuration(i) + " | " +
            drive.estimatedMPG + "mpg";

        recentTripsPanel.appendChild(cell);
    }
}

function formatDuration(i) {
    const drives = JSON.parse(localStorage.getItem("drives")) || [];
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

function formatTime(i) {
    const drives = JSON.parse(localStorage.getItem("drives")) || [];
    if (drives.length === 0) return;

    const drive = drives[drives.length - 1 - i];

    const startTime = new Date(drive.startTime);

    const hours = startTime.getHours().toString().padStart(2, "0");
    const minutes = startTime.getMinutes().toString().padStart(2, "0");

    return `${hours}:${minutes}`;
}

//////////////////////// Trips Page ////////////////////////
function renderAllTrips() {
    const tripsPage = document.getElementById("recent-trips-page-content");
    tripsPage.innerHTML = "";

    const drives = JSON.parse(localStorage.getItem("drives")) || [];
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
        line1.textContent = `${drive.date} @ ${formatTime(i)}`;
        line1.style.fontSize = "16px";
        line1.style.fontWeight = "700";

        // ---- line 2 ----
        const line2 = document.createElement("span");

        const price =
            Number.isFinite(drive.fuelCost)
                ? drive.fuelCost
                : (drive.fuelUsedLitres * (137.9/100)); // if no price saved, revert to fixed value

        line2.style.whiteSpace = "pre-line";
        line2.textContent = 
            `${formatDuration(i)} | ${drive.distanceMiles}mi | ${drive.averageSpeedMPH}mph
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
            cell.remove();
        };

        text.appendChild(line1);
        text.appendChild(line2);
        cell.appendChild(text);
        cell.appendChild(deleteButton);

        tripsPage.appendChild(cell);
    }
}

function deleteDriveByStartTime(startTime) {
    const drives = JSON.parse(localStorage.getItem("drives")) || [];

    const updatedDrives = drives.filter(
        drive => drive.startTime !== startTime
    );

    localStorage.setItem("drives", JSON.stringify(updatedDrives));
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

function getDrivesForPeriod(period) {
    const drives =
        (JSON.parse(localStorage.getItem("drives")) || [])
            .map(normalizeDrive);

    if (period === "lifetime") return drives;

    const now = Date.now();
    let cutoff;

    switch (period) {
        case "week":
            cutoff = now - 7 * 24 * 60 * 60 * 1000;
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

function getStats(period) {
    return calculateStats(getDrivesForPeriod(period));
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
    valueEl.style.fontSize = "20px";
    valueEl.style.fontWeight = "800";
    valueEl.style.color = "var(--text-main)";

    const labelEl = document.createElement("div");
    labelEl.textContent = label;
    labelEl.style.fontSize = "14px";
    labelEl.style.fontWeight = "500";
    labelEl.style.color = "var(--text-accent)";

    item.appendChild(valueEl);
    item.appendChild(labelEl);

    return item;
}

function createStatsCard(period, titleText) {
    const stats = getStats(period);

    const cell = document.createElement("div");
    cell.style.position = "relative";
    cell.style.height = "240px";
    cell.style.borderRadius = "15px";
    cell.style.display = "flex";
    cell.style.alignItems = "center";
    cell.style.boxShadow = "0 0px 10px 0 var(--shadow)";
    cell.style.margin = "16px 2px";
    cell.style.padding = "0 12px";

    const title = document.createElement("div");
    title.textContent = titleText;
    title.style.position = "absolute";
    title.style.top = "6px";
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
    innerCell.style.margin = "140px 2px 120px 2px";
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

function renderStats() {
    const statsPage = document.getElementById("stats-page-content");
    statsPage.innerHTML = "";

    statsPage.style.paddingTop = "40px";
    statsPage.style.paddingBottom = "40px";

    statsPage.appendChild(createStatsCard("week", "Weekly Stats"));
    statsPage.appendChild(createStatsCard("month", "Monthly Stats"));
    statsPage.appendChild(createStatsCard("year", "Yearly Stats"));
    statsPage.appendChild(createStatsCard("lifetime", "Lifetime Stats"));
}

//////////////////////// Profile Page ////////////////////////

function updateProfileStats() {
    const drives = JSON.parse(localStorage.getItem("drives")) || [];

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

const setHomeBtn = document.getElementById("set-profile-home-btn");
setHomeBtn.addEventListener("click", () => {
    const confirmed = confirm(
        "Are you sure you want to set your current location as your Home?\n\nThis is used to obtain your local fuel price."
    );

    if (!confirmed) return;

    navigator.geolocation.getCurrentPosition(pos => {
        const location = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude
        };

        localStorage.setItem("location", JSON.stringify(location));
        updateFuelPrice();
    })
});

const resetBtn = document.getElementById("reset-profile-btn")
resetBtn.addEventListener("click", () => {
    const confirmed = confirm(
        "Are you sure you want to reset your profile?\n\nThis will delete all saved data."
    );

    if (!confirmed) return;

    localStorage.clear();
    refreshPages();

    const fuelPriceText = document.getElementById("fuel-price");
    if (fuelPriceText) {
        fuelPriceText.textContent = "000.0";
    }
});

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

function refreshPages() {
    renderRecentTrips();
    //renderStatsPreview();
    renderAllTrips();
    renderStats();
    updateProfileStats();
}

function renderHomePage() {
    renderRecentTrips();
    //renderStatsPreview();
}

updateFuelPrice();
