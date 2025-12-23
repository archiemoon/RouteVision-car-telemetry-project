

renderHomePage()

////////////////////////
// Data Tracking Logic
////////////////////////

let liveDrive = null;
let timeInterval = null;

function startDrive() {
    //Time in ms from epoch
    const now = Date.now();

    liveDrive = {
        startTime: now,
        lastSpeedKph: 0,
        recentSpeeds: [],
        lastGpsTime: null,
        prevSpeedKph: null,
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
        if (liveDrive.lastSpeedKph < 2) {
            const deltaHours = 1 / 3600;
            liveDrive.fuelUsedLitres +=
                IDLE_LITRES_PER_HOUR * deltaHours;
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
    return liveDrive.distanceKm / hours;
}


const LITRES_PER_100KM = 5.1;
const IDLE_LITRES_PER_HOUR = 0.8; // realistic range: 0.5–1.0

function calculateMPG(distanceKm, fuelLitres) {
    if (fuelLitres === 0) return 0;

    const miles = distanceKm * 0.621371;
    const gallons = fuelLitres * 0.219969;

    return miles / gallons;
}

function stopDrive() {
    stopActiveTimer()
    appState.paused = false;

    const driveSummary = {
        date: new Date().toISOString().split("T")[0],
        startTime: liveDrive.startTime,
        durationSeconds: Math.floor(liveDrive.activeSeconds),
        distanceMiles: (liveDrive.distanceKm * 0.621371).toFixed(1),
        averageSpeedMPH: (getAverageSpeed()* 0.621371).toFixed(1),
        fuelUsedLitres: liveDrive.fuelUsedLitres.toFixed(3),
        estimatedMPG: calculateMPG(
            liveDrive.distanceKm,
            liveDrive.fuelUsedLitres
        ).toFixed(1)
    };

    const drives = JSON.parse(localStorage.getItem("drives")) || [];
    drives.push(driveSummary);
    localStorage.setItem("drives", JSON.stringify(drives));

    liveDrive = null;
}

////////////////////////
// Live GPS and API logic
////////////////////////

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

    liveDrive.recentSpeeds.push(speedKph);

    // keep last 60 seconds (assuming ~1s GPS)
    if (liveDrive.recentSpeeds.length > 60) {
        liveDrive.recentSpeeds.shift();
    }

    const now = position.timestamp;

    if (!liveDrive.lastGpsTime) {
        liveDrive.lastGpsTime = now;
        liveDrive.prevSpeedKph = speedKph;
        return;
    }

    const deltaSeconds = (now - liveDrive.lastGpsTime) / 1000;
    liveDrive.lastGpsTime = now;

    updateLiveFromSpeed(speedKph, deltaSeconds);


    ////////////////
    document.getElementById("dbg-time").textContent =
        liveDrive.activeSeconds.toFixed(1);

    document.getElementById("dbg-speed").textContent =
        (speedMps*2.23694).toFixed(1);

    document.getElementById("dbg-distance").textContent =
        (liveDrive.distanceKm * 0.621371).toFixed(1);

    document.getElementById("dbg-fuel").textContent =
        liveDrive.fuelUsedLitres.toFixed(3);

    document.getElementById("dbg-avg-speed").textContent =
        (getAverageSpeed() * 0.621371).toFixed(1);

    document.getElementById("dbg-mpg").textContent =
        (calculateMPG(
            liveDrive.distanceKm,
            liveDrive.fuelUsedLitres
        ).toFixed(1));
    ////////////////
}

function updateLiveFromSpeed(speedKph, deltaSeconds) {
    if (deltaSeconds <= 0) return;

    const prevDistance = liveDrive.distanceKm;

    // ---- ACCELERATION (proxy for throttle) ----
    let acceleration = 0;
    if (liveDrive.prevSpeedKph !== null) {
        acceleration = (speedKph - liveDrive.prevSpeedKph) / deltaSeconds;
        acceleration = Math.max(-5, Math.min(acceleration, 5));
    }

    liveDrive.prevSpeedKph = speedKph;

    // ---- COASTING / ENGINE BRAKING ----
    const isCoasting =
        speedKph > 20 && acceleration < -0.5;

    // ---- DISTANCE ----
    if (speedKph >= 2) {
        updateDistance(speedKph, deltaSeconds);
    }

    const deltaDistanceKm =
        liveDrive.distanceKm - prevDistance;

    // ---- FUEL MULTIPLIER ----
    let fuelMultiplier = 1;

    // Acceleration penalty
    if (acceleration > 1.5) fuelMultiplier = 1.4;
    else if (acceleration > 0.5) fuelMultiplier = 1.15;

    // Speed efficiency curve
    if (speedKph < 30) fuelMultiplier *= 1.3;
    else if (speedKph > 120) fuelMultiplier *= 1.25;

    // ---- FUEL USE ----
    if (isCoasting) {
    // assume fuel cut-off only while moving
    if (speedKph > 10) return;
    }

    // ---- WARM-UP PENALTY ----
    let warmupMultiplier = 1;

    // First 5 minutes = less efficient
    if (liveDrive.activeSeconds < 180) warmupMultiplier = 1.4  ;
    else if (liveDrive.activeSeconds < 300) warmupMultiplier = 1.2;

    // ---- URBAN PENALTY ----
    let urbanMultiplier = 1;

    const avgSpeedKph = getRecentAverageSpeed();

    if (avgSpeedKph < 20) urbanMultiplier = 1.4;
    else if (avgSpeedKph < 30) urbanMultiplier = 1.25;

    if (speedKph >= 2) {
        liveDrive.fuelUsedLitres +=
        (deltaDistanceKm / 100) *
        LITRES_PER_100KM *
        fuelMultiplier *
        warmupMultiplier *
        urbanMultiplier;
    }
}

function getRecentAverageSpeed() {
    if (liveDrive.recentSpeeds.length === 0) return 0;
    return liveDrive.recentSpeeds.reduce((a, b) => a + b, 0) /
    liveDrive.recentSpeeds.length;
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

function updateFuelPrice() {
    navigator.geolocation.getCurrentPosition(async pos => {
        try {
            const price = await getLocalE10Price(
                pos.coords.latitude,
                pos.coords.longitude
            );

            if (price == null) {
                console.warn("Fuel price unavailable");
                return;
            }

            const fuelPriceText = document.getElementById("fuel-price");
            if (!fuelPriceText) return;
            fuelPriceText.textContent = price.toFixed(1);

            console.log("Local E10:", price.toFixed(1), "p/L");
        } catch (err) {
            console.error("Failed to update fuel price", err);
        }
    });
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
    const drives = JSON.parse(localStorage.getItem("drives")) || [];
    if (drives.length === 0) return;

    const recentTripsPanel =
        document.getElementById("recent-trips-overview-content");
    recentTripsPanel.innerHTML = "";

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
            drive.date + " | " +
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
    const drives = JSON.parse(localStorage.getItem("drives")) || [];
    if (drives.length === 0) return;

    const tripsPage = document.getElementById("recent-trips-page");
    tripsPage.innerHTML = "";

    // How many trips to show (max 3)
    const count = drives.length;

    for (let i = 0; i < count; i++) {
        const drive = drives[drives.length - 1 - i];
        // ---- create cell ----
        const cell = document.createElement("div");
        cell.style.position = "relative";
        cell.style.height = "55px";
        cell.style.borderRadius = "15px";
        cell.style.display = "flex";
        cell.style.alignItems = "center";
        cell.style.justifyContent = "center";
        cell.style.fontSize = "12px";
        cell.style.fontWeight = "700";
        cell.style.color = "var(--text-main)";
        cell.style.boxShadow = "0 0px 4px 0 var(--shadow)";
        cell.style.margin = "2px 2px 8px 2px";

        cell.textContent =
            drive.date + " | " +
            formatTime(i) + " | " +
            drive.distanceMiles + "mi | " +
            formatDuration(i) + " | " +
            drive.estimatedMPG + "mpg";

        tripsPage.appendChild(cell);
    }  
}

//////////////////////// Stats Page ////////////////////////

const resetBtn = document.getElementById("reset-btn")
resetBtn.addEventListener("click", () => {
    localStorage.clear();
});

//////////////////////// Profile Page ////////////////////////

function updateProfileStats() {
    const drives = JSON.parse(localStorage.getItem("drives")) || [];

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
    //renderStats();
    updateProfileStats();
}

function renderHomePage() {
    renderRecentTrips();
    //renderStatsPreview();
}

//updateFuelPrice();