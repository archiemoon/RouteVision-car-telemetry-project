////////////////////////
// Start/Stop button logic
////////////////////////

const appState = { mode: "idle" };

function enterDrivingMode() {
    appState.mode = "driving";
    document.getElementById("driving-mode").classList.remove("hidden");
}

function exitDrivingMode() {
    if (!confirm("Stop driving?")) return;
    appState.mode = "idle";
    document.getElementById("driving-mode").classList.add("hidden");
}

const startBtn = document.getElementById("top-bar-start-btn");
const stopBtn = document.getElementById("stop-btn");

startBtn.addEventListener("click", enterDrivingMode);
stopBtn.addEventListener("click", exitDrivingMode);

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
