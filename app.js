////////////////////////
// 
////////////////////////

let liveDrive = null;

function startDrive() {
    console.log("Drive Started");
    const now = Date.now();

    liveDrive = {
        startTime: now,
        lastUpdate: now,

        distanceKm: 0,
        totalSpeed: 0,
        speedSamples: 0,

        fuelUsedLitres: 0
    };
}

function updateDistance(speedKph, deltaSeconds) {
    const kmPerSecond = speedKph / 3600;
    liveDrive.distanceKm += kmPerSecond * deltaSeconds;
}

function updateAverageSpeed(speedKph) {
    liveDrive.totalSpeed += speedKph;
    liveDrive.speedSamples += 1;
}

function getAverageSpeed() {
    if (liveDrive.speedSamples === 0) return 0;
    return liveDrive.totalSpeed / liveDrive.speedSamples;
}

const LITRES_PER_100KM = 7.5;

function updateFuelUsed(deltaDistanceKm) {
  liveDrive.fuelUsedLitres += (deltaDistanceKm / 100) * LITRES_PER_100KM;
}

function calculateMPG(distanceKm, fuelLitres) {
    if (fuelLitres === 0) return 0;

    const miles = distanceKm * 0.621371;
    const gallons = fuelLitres * 0.219969;

    return miles / gallons;
}

function stopDrive() {
    console.log("Drive Stopped");

    const driveSummary = {
        date: new Date().toISOString().split("T")[0],
        durationSeconds: Math.floor(
            (Date.now() - liveDrive.startTime) / 1000
        ),
        distanceKm: liveDrive.distanceKm,
        averageSpeedKph: getAverageSpeed(),
        fuelUsedLitres: liveDrive.fuelUsedLitres,
        estimatedMPG: calculateMPG(
            liveDrive.distanceKm,
            liveDrive.fuelUsedLitres
        )
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
    onsole.error("GPS error:", error);

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
    console.log("Tracking...");
    ////////////////
    if (!liveDrive) return;
    ////////////////
    const speedMps = position.coords.speed; // meters per second

    if (speedMps === null) return; // GPS not ready yet

    const speedKph = speedMps * 3.6;

    updateLiveFromSpeed(speedKph);

    ////////////////
    document.getElementById("dbg-speed").textContent =
        speedKph.toFixed(1);

    document.getElementById("dbg-distance").textContent =
        liveDrive.distanceKm.toFixed(3);

    document.getElementById("dbg-fuel").textContent =
        liveDrive.fuelUsedLitres.toFixed(3);

    document.getElementById("dbg-avg-speed").textContent =
        getAverageSpeed().toFixed(1);
    ////////////////
}

function updateLiveFromSpeed(speedKph) {
    const now = Date.now();
    const deltaSeconds = (now - liveDrive.lastUpdate) / 1000;
    liveDrive.lastUpdate = now;

    const prevDistance = liveDrive.distanceKm;

    updateDistance(speedKph, deltaSeconds);
    updateAverageSpeed(speedKph);
    updateFuelUsed(liveDrive.distanceKm - prevDistance);
}


/////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////


////////////////////////
// Start/Stop button logic
////////////////////////

const appState = { mode: "idle" };

function enterDrivingMode() {
    appState.mode = "driving";
    document.getElementById("driving-mode").classList.remove("hidden");
}

function exitDrivingMode() {
    appState.mode = "idle";
    document.getElementById("driving-mode").classList.add("hidden");
}

const startBtn = document.getElementById("top-bar-start-btn");
const stopBtn = document.getElementById("stop-btn");

startBtn.addEventListener("click", () => {
    enterDrivingMode();
    startDrive();
    startGPS();
});
stopBtn.addEventListener("click", () => {
    stopGPS();
    stopDrive();
    exitDrivingMode();
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


////////////////////////
// Page Switcher
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
    setActiveNav("home-btn");
});

document.getElementById("compass-btn")
.addEventListener("click", () => {
    showPage("recent-trips-page");
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
    setActiveNav("profile-btn");
});