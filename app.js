////////////////////////
// 
////////////////////////

let liveDrive = null;

function startDrive() {
    console.log("Drive Started");

    //Time in ms from epoch
    const now = Date.now();

    liveDrive = {
        startTime: now,
        lastUpdate: now,
        activeSeconds: 0,
        distanceKm: 0,
        fuelUsedLitres: 0
    };
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


const LITRES_PER_100KM = 5.65;

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
    console.log("Tracking...");
    if (!liveDrive) return;
    if (appState.paused) return;

    const speedMps = position.coords.speed; // meters per second

    if (speedMps === null) return; // GPS not ready yet

    const speedKph = speedMps * 3.6;
    if (speedKph < 2) return;

    updateLiveFromSpeed(speedKph);

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

function updateLiveFromSpeed(speedKph) {
    const now = Date.now();
    const deltaSeconds = (now - liveDrive.lastUpdate) / 1000;
    liveDrive.lastUpdate = now;

    liveDrive.activeSeconds += deltaSeconds;

    const prevDistance = liveDrive.distanceKm;

    updateDistance(speedKph, deltaSeconds);
    updateFuelUsed(liveDrive.distanceKm - prevDistance);
}


/////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////


////////////////////////
// Start/Stop button logic
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
});
pauseBtn.addEventListener("click", () => {
    appState.paused = !appState.paused;
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

////////////////////////
// Recent Trips 
////////////////////////

function renderTrips() {

}

////////////////////////
// Bottom Nav (Func ran when btn pressed)
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